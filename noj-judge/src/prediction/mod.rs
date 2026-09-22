//! prediction 模式：单容器数据评分路径。
//!
//! **不创建、不执行 Solution 容器**，无 NDJSON 编排。选手提交物是纯数据，
//! 平台不执行任何不可信代码。

use std::path::Path;
use std::time::{Duration, Instant};

use anyhow::{Context, Result};
use bollard::container::LogOutput;
use futures_util::StreamExt;
use serde_json::Value;
use tracing::warn;

use crate::dual::append_capped;
use crate::dual::container::{start_exec, DualContainer};
use crate::dual::protocol::{EvaluatorLine, LineParser};
use crate::types::{JudgeResult, RuntimeConfig};

const PREDICTION_DIR: &str = "/workspace/prediction";
const RESULT_MARKER: &str = "---RESULT---";

/// 解析 prediction `/workspace` tmpfs 上限（MB）。
///
/// 题目级 `evaluator.workspace_size_mb` 优先，缺省用 Judge Worker 的
/// `JUDGE_PREDICTION_WORKSPACE_MB`；两者都收敛到
/// [`crate::config::MIN_PREDICTION_WORKSPACE_MB`]..=[`crate::config::MAX_PREDICTION_WORKSPACE_MB`]。
///
/// 题目级字段是**用户可控输入**（U 型题 owner 可自行编辑），原先直接传入 Docker
/// tmpfs size，绕过 worker 配置的 512–16384 范围；这里补上同一收敛，避免无界声明。
fn resolve_workspace_mb(configured: Option<u64>, default_workspace_mb: u64) -> u64 {
    configured.unwrap_or(default_workspace_mb).clamp(
        crate::config::MIN_PREDICTION_WORKSPACE_MB,
        crate::config::MAX_PREDICTION_WORKSPACE_MB,
    )
}

/// prediction 输出累积器。
///
/// 关键安全修复（2026-09-21 Task 8 评审）：prediction 评测消费用户提供的预测文件，
/// 恶意文件可诱导 evaluator 在 `time_limit_ms` 内无限打印。原实现用无界
/// `push_str` 累积 stdout/stderr，会让 judge 进程 OOM（容器内存限制不约束 judge），
/// 并连带杀死同进程内其他在途提交。现改为：
///
/// - stdout/stderr 全文一律经 [`append_capped`] 累积，硬上限
///   [`crate::dual::MAX_OUTPUT_BYTES`]（1 MiB，超出丢头部保尾部）；
/// - 标记检测改为流式：用 [`LineParser`] 按行切分，见到 `---RESULT---` 后把下一个
///   非空行立刻存入独立的 `payload` 槽。这样即使滚动缓冲被截断（标记被丢出窗口），
///   标记与 payload 也已被捕获，不会误判为 `system_error`；
/// - 同时消除了每 chunk 对无界缓冲全量重扫的 O(n²) 开销。
#[derive(Debug, Default)]
struct PredictionOutput {
    stdout_full: String,
    stderr_buf: String,
    parser: LineParser,
    /// `None`＝未见标记；`Some("")`＝已见标记、等待首个非空行；
    /// `Some(payload)`＝已捕获 payload。
    payload: Option<String>,
}

impl PredictionOutput {
    fn new() -> Self {
        Self::default()
    }

    /// 是否已捕获到 payload（评测可提前结束）。
    fn has_payload(&self) -> bool {
        matches!(&self.payload, Some(p) if !p.is_empty())
    }

    /// 喂入一个 chunk：累积输出并流式检测 RESULT 标记/payload。
    fn feed(&mut self, chunk: &LogOutput) {
        match chunk {
            LogOutput::StdOut { message } => {
                let lines = self.parser.feed(message);
                for line in lines {
                    self.handle_line(line);
                }
            }
            LogOutput::StdErr { message } => {
                let s = String::from_utf8_lossy(message);
                append_capped(&mut self.stderr_buf, &s);
            }
            _ => {}
        }
    }

    fn handle_line(&mut self, line: EvaluatorLine) {
        match line {
            EvaluatorLine::ResultMarker => {
                // 首个标记生效：payload 已捕获（非空）时后续标记行不再重置，避免把
                // 已经拿到的合法结果清掉。触发场景：
                // - evaluate.py 曾用 print 调试 `---RESULT---`，之后才是真正结果；
                // - stdout 块缓冲下进程在写标记与 flush payload 之间死亡（标记先行、
                //   payload 丢失），此后若出现第二组标记+payload，同样保留先到者。
                // 空 payload（Some("")＝已见标记、等待下一非空行）时保持原语义，
                // 使「标记与 payload 跨 chunk」仍能正常收尾。
                if !self.has_payload() {
                    self.payload = Some(String::new());
                }
                append_capped(&mut self.stdout_full, RESULT_MARKER);
                append_capped(&mut self.stdout_full, "\n");
            }
            other => {
                // 非标记行统一记录到 stdout 全文（供结果展示）
                let s = match other {
                    EvaluatorLine::Frame(v) => v.to_string(),
                    EvaluatorLine::Unknown(s) => s,
                    EvaluatorLine::ResultMarker => unreachable!("ResultMarker 已在上分支处理"),
                };
                append_capped(&mut self.stdout_full, &s);
                append_capped(&mut self.stdout_full, "\n");
                if self.payload.as_ref() == Some(&String::new()) && !s.trim().is_empty() {
                    self.payload = Some(s.trim().to_string());
                }
            }
        }
    }

    /// 收尾：把 [`LineParser`] 内部缓冲的尾部残留（无换行结尾）也走一遍检测。
    ///
    /// EOF 时 evaluator 可能刚 flush 完 `---RESULT---\n<json>` 的最后一行而尚未出
    /// 换行，若不做这一步，payload 会遗留在解析器缓冲里、被误判为无结果。
    fn finish(&mut self) {
        for line in self.parser.drain_remaining() {
            self.handle_line(line);
        }
    }
}

/// prediction 评测入口。
#[allow(clippy::too_many_arguments)]
pub async fn evaluate_prediction(
    docker: bollard::Docker,
    submission_id: &str,
    runtime_config: &RuntimeConfig,
    support_pkg_path: Option<&Path>,
    prediction_path: &Path,
    prediction_file_name: &str,
    rejudge_seq: Option<i64>,
    cpu_limit_millicores: u64,
    allow_evaluator_network: bool,
    evaluator_network_mode: &str,
    image_prefix: &str,
    command_whitelist: &[String],
    max_evaluator_time_ms: u64,
    default_workspace_mb: u64,
) -> Result<JudgeResult> {
    // 复用双容器路径的同名 clamp/validate（solution 为 None 时自动跳过其校验）
    let rc =
        crate::dual::clamp_runtime_config_for_prediction(runtime_config, max_evaluator_time_ms);
    crate::dual::validate_runtime_config(
        submission_id,
        &rc,
        allow_evaluator_network,
        image_prefix,
        command_whitelist,
    )?;

    let started = Instant::now();
    let startup_deadline = Instant::now() + Duration::from_secs(30);

    let network_enabled = rc
        .evaluator
        .network
        .as_ref()
        .map(|n| n.enabled)
        .unwrap_or(false);
    let network_mode = if network_enabled {
        evaluator_network_mode
    } else {
        "none"
    };
    let workspace_mb = resolve_workspace_mb(rc.evaluator.workspace_size_mb, default_workspace_mb);

    let dual = DualContainer::create_evaluator_with_workspace(
        &docker,
        &rc.evaluator.image,
        rc.evaluator.memory_limit_mb,
        network_mode,
        cpu_limit_millicores,
        workspace_mb,
    )
    .await
    .context("创建 Evaluator 容器失败")?;

    let evaluator_id = dual
        .evaluator_id
        .clone()
        .ok_or_else(|| anyhow::anyhow!("Evaluator 容器 ID 缺失"))?;

    if let Some(pkg) = support_pkg_path {
        crate::dual::inject_support_package_to_evaluator(&docker, &evaluator_id, pkg)
            .await
            .context("注入支持包到 Evaluator 容器失败")?;
    }

    // 预测文件 → /workspace/prediction/<file_name>
    let rel = format!("prediction/{}", prediction_file_name);
    // Task 7 裁决：`inject_file_stream_to_container` 自身**不含截止时间**（容器侧
    // `tar xf -` 挂起时会无限等待），由调用方界定时间上限。预测文件可能有数 GB，
    // 这里复用启动期剩余的 30s 预算作为硬上限；超时则返回 system_error，
    // 由 RAII（`dual` 的 Drop）负责销毁 Evaluator 容器。
    let inject_budget = startup_deadline.saturating_duration_since(Instant::now());
    match tokio::time::timeout(
        inject_budget,
        crate::dual::inject_file_stream_to_container(&docker, &evaluator_id, prediction_path, &rel),
    )
    .await
    {
        Ok(injected) => injected.context("注入预测文件失败")?,
        Err(_) => {
            return Ok(JudgeResult::system_error(
                submission_id,
                "注入预测文件超时",
                rejudge_seq,
            ))
        }
    }

    let env = vec![
        format!("NOJ_PREDICTION_DIR={}", PREDICTION_DIR),
        format!("NOJ_PREDICTION_FILE={}", prediction_file_name),
    ];
    let cmd = crate::sandbox::container::parse_command(&rc.evaluator.command);
    let exec = start_exec(&docker, &evaluator_id, cmd, env)
        .await
        .context("启动 Evaluator exec 失败")?;

    let outcome = run_prediction_loop(
        submission_id,
        exec,
        rc.evaluator.time_limit_ms,
        rejudge_seq,
        startup_deadline,
    )
    .await;

    let memory_peak_kb = crate::dual::read_container_memory_peak_kb(&docker, &evaluator_id).await;
    if let Err(e) = dual.destroy().await {
        warn!("prediction 容器销毁警告: {}", e);
    }

    let mut result = outcome?;
    if result.time_ms.is_none() {
        result.time_ms = Some(started.elapsed().as_millis() as u64);
    }
    if result.memory_kb.is_none() {
        result.memory_kb = memory_peak_kb;
    }
    Ok(result)
}

async fn run_prediction_loop(
    submission_id: &str,
    mut exec: crate::dual::container::ExecSession,
    time_limit_ms: u64,
    rejudge_seq: Option<i64>,
    startup_deadline: Instant,
) -> Result<JudgeResult> {
    let mut out = PredictionOutput::new();

    // 阶段 1：等待首条输出（30s 启动期）
    let mut first_seen = false;
    while !first_seen {
        let remaining = startup_deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            return Ok(JudgeResult::system_error(
                submission_id,
                "评测程序启动超时",
                rejudge_seq,
            ));
        }
        match tokio::time::timeout(remaining, exec.output.next()).await {
            Err(_) => {
                return Ok(JudgeResult::system_error(
                    submission_id,
                    "评测程序启动超时",
                    rejudge_seq,
                ))
            }
            Ok(None) => break,
            Ok(Some(Err(e))) => return Err(anyhow::anyhow!("读取 Evaluator 输出失败: {}", e)),
            Ok(Some(Ok(chunk))) => {
                first_seen = true;
                out.feed(&chunk);
            }
        }
    }

    // 阶段 2：总时限内持续读取，直到流式解析捕获 payload 或流结束
    let deadline = Instant::now() + Duration::from_millis(time_limit_ms);
    while !out.has_payload() {
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            return Ok(JudgeResult::system_error(
                submission_id,
                "评测超时（time_limit_ms）",
                rejudge_seq,
            ));
        }
        match tokio::time::timeout(remaining, exec.output.next()).await {
            Err(_) => {
                return Ok(JudgeResult::system_error(
                    submission_id,
                    "评测超时（time_limit_ms）",
                    rejudge_seq,
                ))
            }
            Ok(None) => break,
            Ok(Some(Err(e))) => return Err(anyhow::anyhow!("读取 Evaluator 输出失败: {}", e)),
            Ok(Some(Ok(chunk))) => out.feed(&chunk),
        }
    }

    // EOF 或无换行结尾的尾部残留也参与检测
    out.finish();

    match out.payload.take() {
        Some(payload) if !payload.is_empty() => match serde_json::from_str::<Value>(&payload) {
            Ok(parsed) => Ok(crate::dual::build_judge_result(
                submission_id,
                &parsed,
                &out.stderr_buf,
                &out.stdout_full,
                rejudge_seq,
            )),
            Err(e) => {
                warn!("prediction RESULT JSON 解析失败: {}", e);
                Ok(JudgeResult::system_error(
                    submission_id,
                    "评测脚本输出结果不是合法 JSON",
                    rejudge_seq,
                ))
            }
        },
        _ => Ok(JudgeResult::system_error(
            submission_id,
            "评测脚本未输出结果标记",
            rejudge_seq,
        )),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 构造一个 stdout 分块。
    fn stdout_chunk(s: &str) -> LogOutput {
        LogOutput::StdOut {
            message: s.as_bytes().to_vec().into(),
        }
    }

    /// 标记存在时提取其后的首个非空行（流式路径，覆盖原 `extract_result_payload`
    /// 的等价语义：标记存在 / 不存在 / 标记后仅空白行）。
    #[test]
    fn test_payload_extraction_semantics() {
        // 标记存在 + 后续噪声行 → 取标记后首个非空行
        let mut out = PredictionOutput::new();
        out.feed(&stdout_chunk(
            "some logs\n---RESULT---\n{\"score\":1000,\"details\":{}}\ntrailing\n",
        ));
        out.finish();
        assert_eq!(
            out.payload.as_deref(),
            Some("{\"score\":1000,\"details\":{}}")
        );

        // 标记不存在 → 无 payload
        let mut out = PredictionOutput::new();
        out.feed(&stdout_chunk("no marker here\n"));
        out.finish();
        assert_eq!(out.payload, None);

        // 标记后仅空白行 → 保持空 payload（不得误判为已捕获）
        let mut out = PredictionOutput::new();
        out.feed(&stdout_chunk("---RESULT---\n\n  \n"));
        out.finish();
        assert_eq!(out.payload.as_deref(), Some(""));
        assert!(!out.has_payload());
    }

    /// marker + payload 之后跟超过 1 MiB（输出上限）的噪声，payload 仍必须被捕获。
    ///
    /// 回归 2026-09-21 Task 8 评审：rolling buffer 会丢弃头部，若循环依赖重扫全文
    /// 检测标记，标记会被截断出窗口 → 误判 system_error。
    #[test]
    fn test_streaming_payload_survives_buffer_truncation() {
        let mut out = PredictionOutput::new();
        out.feed(&stdout_chunk("---RESULT---\n{\"score\":1000}\n"));
        // 追加远超 MAX_OUTPUT_BYTES 的尾部噪声，足以把 marker 挤出滚动缓冲
        let noise = "x".repeat(crate::dual::MAX_OUTPUT_BYTES + 4096);
        out.feed(&stdout_chunk(&noise));
        out.finish();

        assert!(
            out.stdout_full.len() <= crate::dual::MAX_OUTPUT_BYTES,
            "stdout 全文必须受硬上限约束: {}",
            out.stdout_full.len()
        );
        assert!(
            !out.stdout_full.contains("---RESULT---"),
            "本用例应已把 marker 挤出缓冲（否则用例无效）"
        );
        assert_eq!(out.payload.as_deref(), Some("{\"score\":1000}"));
        assert!(out.has_payload());
    }

    /// 无换行结尾的 payload（EOF 时才 flush）也必须被捕获。
    #[test]
    fn test_payload_without_trailing_newline_drained_at_eof() {
        let mut out = PredictionOutput::new();
        out.feed(&stdout_chunk("---RESULT---\n{\"score\":7}"));
        assert!(!out.has_payload(), "无换行时 payload 仍在解析器缓冲内");
        out.finish();
        assert_eq!(out.payload.as_deref(), Some("{\"score\":7}"));
    }

    /// 首个标记生效：payload 已捕获后，后续标记行不得把结果清掉。
    ///
    /// 回归场景：evaluate.py 调试打印过 `---RESULT---`，或 stdout 块缓冲下
    /// 标记先于 payload 下发。原实现每个标记都重置 payload，会把已捕获的
    /// 合法结果丢掉并误判为 system_error。
    #[test]
    fn test_second_marker_does_not_clobber_captured_payload() {
        let mut out = PredictionOutput::new();
        out.feed(&stdout_chunk(
            "---RESULT---\n{\"score\":1000}\n---RESULT---\n{\"score\":0}\n",
        ));
        out.finish();
        assert_eq!(
            out.payload.as_deref(),
            Some("{\"score\":1000}"),
            "已捕获的 payload 不应被后续标记重置"
        );
    }

    /// 标记后只有噪声、随后才有第二组标记 + payload：仍应吸收第二组的 payload。
    #[test]
    fn test_second_marker_payload_used_when_first_had_none() {
        let mut out = PredictionOutput::new();
        out.feed(&stdout_chunk(
            "---RESULT---\n  \n---RESULT---\n{\"score\":7}\n",
        ));
        out.finish();
        assert_eq!(out.payload.as_deref(), Some("{\"score\":7}"));
        assert!(out.has_payload());
    }

    /// 未输出标记时保持「无 payload」语义。
    #[test]
    fn test_no_marker_yields_no_payload() {
        let mut out = PredictionOutput::new();
        out.feed(&stdout_chunk("just logs\nmore logs\n"));
        out.finish();
        assert!(!out.has_payload());
    }

    /// marker 后只有空白行 → payload 保持为空（不得误判为已捕获）。
    #[test]
    fn test_marker_with_only_blank_lines() {
        let mut out = PredictionOutput::new();
        out.feed(&stdout_chunk("---RESULT---\n\n   \n"));
        out.finish();
        assert_eq!(out.payload.as_deref(), Some(""));
        assert!(!out.has_payload());
    }

    /// stderr 同样受硬上限约束。
    #[test]
    fn test_stderr_capped() {
        let mut out = PredictionOutput::new();
        let noise = "e".repeat(crate::dual::MAX_OUTPUT_BYTES + 4096);
        out.feed(&LogOutput::StdErr {
            message: noise.into_bytes().into(),
        });
        assert!(out.stderr_buf.len() <= crate::dual::MAX_OUTPUT_BYTES);
    }

    /// 题目级 workspace_size_mb 必须收敛到 worker 允许范围
    /// （`JUDGE_PREDICTION_WORKSPACE_MB` 的 512–16384）。
    #[test]
    fn test_resolve_workspace_mb_clamps_problem_override() {
        use crate::config::{MAX_PREDICTION_WORKSPACE_MB, MIN_PREDICTION_WORKSPACE_MB};

        // 缺省：用 worker 配置值
        assert_eq!(resolve_workspace_mb(None, 2048), 2048);
        // 范围内：原样透传
        assert_eq!(resolve_workspace_mb(Some(4096), 2048), 4096);
        // 越界：收敛到上下限（题目 owner 是用户可控输入，不能无界声明 tmpfs）
        assert_eq!(
            resolve_workspace_mb(Some(10_000_000), 2048),
            MAX_PREDICTION_WORKSPACE_MB
        );
        assert_eq!(
            resolve_workspace_mb(Some(1), 2048),
            MIN_PREDICTION_WORKSPACE_MB
        );
    }
}
