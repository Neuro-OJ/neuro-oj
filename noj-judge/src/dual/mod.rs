//! 双容器编排核心（设计稿 §1）。
//!
//! 关键路径：
//! 1. 创建 Evaluator + Solution 容器（Solution 恒无网；Evaluator 按配置可选联网）
//! 2. 注入支持包到 Evaluator（如有）与用户代码到 Solution
//! 3. 启动两个 exec（Evaluator 跑 evaluate.py；Solution 跑 host.py）
//! 4. 阶段 1：等待 Evaluator 首条输出（30s 启动超时，不计入题目时限）
//! 5. 阶段 2：双向消息转发（evaluator stdout ↔ solution stdin/stderr）+ 调用级超时
//! 6. 等待 Evaluator stdout 出现 `---RESULT---` 标记，解析结果
//! 7. 未出 RESULT 时按 finalize_outcome 判定（总超时 → SystemError；曾发 CallTimeout → TLE）
//! 8. RAII 清理两个容器

pub mod container;
pub mod llm_env;
pub mod protocol;
pub mod tracker;

use std::path::Path;
use std::time::{Duration, Instant};

use anyhow::{Context, Result};
use bollard::container::LogOutput;
use bollard::query_parameters::StatsOptionsBuilder;
use futures_util::StreamExt;
use serde_json::Value;
use tracing::{debug, error, info, warn};

use crate::dual::container::{start_exec, DualContainer, ExecSession};
use crate::dual::protocol::{
    frame_type, EvaluatorLine, LineParser, FRAME_CALL, FRAME_CAPABILITY, FRAME_CAP_REG,
    FRAME_ERROR, FRAME_LOG, FRAME_READY, FRAME_RESULT, FRAME_SHUTDOWN, RESULT_MARKER,
};
use crate::dual::tracker::{InFlightTracker, WaitingSide};
mod pipe;

#[cfg(test)]
mod tests;

use pipe::{forward_frame, write_timeout_frame, PipeWriteOutcome};

use crate::sandbox::container::{
    extract_zip_entries_from_file, inject_file_to_container, inject_zip_entries_to_container,
    parse_command, ZipEntry,
};
use crate::types::{JudgeResult, JudgeStatus, JudgeTaskLlm, PublicJudgeError, RuntimeConfig};

/// 评测输出全文/错误累积上限（1 MiB）。恶意提交可无限打印，
/// 若无限 append 会拖垮 judge 进程（容器内存限制不约束 judge）。
pub const MAX_OUTPUT_BYTES: usize = 1024 * 1024;

/// Solution 容器入口文件名（评测内部约定，硬编码；与 noj_solution_sdk.host
/// 的 `--entry` 路径一致，模块名固定为 `user_solution`，文件名不影响评测）。
pub const SOLUTION_ENTRY_FILE: &str = "main.py";

/// 校验镜像名最后一段是否匹配受信前缀。
fn image_allowed(image: &str, prefix: &str) -> bool {
    if image.is_empty() || image.contains("..") || image.contains('\0') {
        return false;
    }
    let basename = image.rsplit('/').next().unwrap_or(image);
    let name = basename.split(':').next().unwrap_or(basename);
    name.starts_with(prefix)
}

/// 白名单复验失败时回传给提交详情页的公开文案（不含镜像名/命令等动态内容）。
pub(crate) const MSG_IMAGE_NOT_ALLOWED: &str =
    "评测环境配置错误：题目的评测镜像不在评测机白名单内，请联系管理员检查题目运行时配置";
pub(crate) const MSG_COMMAND_NOT_ALLOWED: &str =
    "评测环境配置错误：题目的评测命令不在评测机白名单内，请联系管理员检查题目运行时配置";
pub(crate) const MSG_NETWORK_NOT_ALLOWED: &str =
    "评测环境配置错误：题目需要评测容器联网，但评测机未开启联网（JUDGE_ALLOW_EVALUATOR_NETWORK），请联系管理员";

/// NOJ-190：judge 侧对 MQ 消息中的镜像/命令/网络做白名单复验。
///
/// 失败时返回以 [`PublicJudgeError`] 为根的错误：`Display` 为详细原因（写日志），
/// 提交详情页只展示固定的公开文案。
fn validate_runtime_config(
    submission_id: &str,
    runtime_config: &RuntimeConfig,
    allow_evaluator_network: bool,
    image_prefix: &str,
    command_whitelist: &[String],
) -> Result<()> {
    if !image_allowed(&runtime_config.evaluator.image, image_prefix) {
        return Err(PublicJudgeError(MSG_IMAGE_NOT_ALLOWED).with_detail(format!(
            "submission {}: evaluator 镜像不在白名单前缀内: {}",
            submission_id, runtime_config.evaluator.image
        )));
    }
    if !image_allowed(&runtime_config.solution.image, image_prefix) {
        return Err(PublicJudgeError(MSG_IMAGE_NOT_ALLOWED).with_detail(format!(
            "submission {}: solution 镜像不在白名单前缀内: {}",
            submission_id, runtime_config.solution.image
        )));
    }

    let argv = parse_command(&runtime_config.evaluator.command);
    if argv.is_empty() {
        return Err(PublicJudgeError(MSG_COMMAND_NOT_ALLOWED)
            .with_detail(format!("submission {}: evaluator 命令为空", submission_id)));
    }
    let executable = &argv[0];
    if !command_whitelist.iter().any(|w| w == executable) {
        return Err(
            PublicJudgeError(MSG_COMMAND_NOT_ALLOWED).with_detail(format!(
                "submission {}: evaluator 可执行文件不在白名单内: {}",
                submission_id, executable
            )),
        );
    }

    let network_enabled = runtime_config
        .evaluator
        .network
        .as_ref()
        .map(|n| n.enabled)
        .unwrap_or(false);
    if network_enabled && !allow_evaluator_network {
        return Err(PublicJudgeError(MSG_NETWORK_NOT_ALLOWED).with_detail(format!(
            "submission {}: 消息请求开启 evaluator 网络，但 judge 未允许（JUDGE_ALLOW_EVALUATOR_NETWORK=false）",
            submission_id
        )));
    }
    Ok(())
}

/// 对任务中的资源限制字段执行硬上限收敛，防止 core 配置缺失或消息被篡改。
fn clamp_runtime_config(
    rc: &RuntimeConfig,
    max_evaluator_time_ms: u64,
    max_solution_call_timeout_ms: u64,
) -> RuntimeConfig {
    let mut clamped = rc.clone();
    if max_evaluator_time_ms > 0 {
        clamped.evaluator.time_limit_ms =
            clamped.evaluator.time_limit_ms.min(max_evaluator_time_ms);
    }
    if max_solution_call_timeout_ms > 0 {
        clamped.solution.call_timeout_ms = clamped
            .solution
            .call_timeout_ms
            .min(max_solution_call_timeout_ms);
    }
    // 内存硬上限与容器创建逻辑保持一致（0 由容器层规范化为 512MB，上限 4096MB）。
    clamped.evaluator.memory_limit_mb = clamped.evaluator.memory_limit_mb.min(4096);
    clamped.solution.memory_limit_mb = clamped.solution.memory_limit_mb.min(4096);
    clamped
}

/// 取不小于 `idx` 的最小字符边界。
///
/// 保证 `&s[n..]` 不会 panic（`String` 的字节切片要求下标落在 UTF-8 字符边界上），
/// 且 `s.len() - n <= s.len() - idx` —— 即"丢弃的字节数不少于预期"，
/// 从而让 `MAX_OUTPUT_BYTES` 成为真正的硬上限。
fn ceil_char_boundary(s: &str, idx: usize) -> usize {
    if idx >= s.len() {
        return s.len();
    }
    let mut i = idx;
    while i < s.len() && !s.is_char_boundary(i) {
        i += 1;
    }
    i
}

/// 追加到累积缓冲：超过上限时丢弃头部、只保留尾部（诊断信息优先）。
///
/// 修复记录（2026-09-12 架构评审 §2.2）：原实现为
/// `*buf = buf[start..].to_string()`，`start` 由字节长度相减得到，可能落在多字节
/// 字符（**中文评测输出是常态**）内部 → `byte index N is not a char boundary` panic。
/// panic 发生在 `tokio::spawn` 的任务内，`JoinHandle` 的 Err 只被 `error!` 记录
/// （main.rs），于是结果永不推送、任务永不 ACK，提交永久停在 judging；
/// core sweeper 重投后再次 panic，形成无限循环。
///
/// 现在截断点一律对齐到字符边界，且总长度硬性不超过 `MAX_OUTPUT_BYTES`。
fn append_capped(buf: &mut String, s: &str) {
    if s.len() >= MAX_OUTPUT_BYTES {
        // 单次追加本身就超限（极端恶意输出）：只保留 s 的尾部。
        let start = ceil_char_boundary(s, s.len() - MAX_OUTPUT_BYTES);
        buf.clear();
        buf.push_str(&s[start..]);
        return;
    }
    if buf.len() + s.len() <= MAX_OUTPUT_BYTES {
        buf.push_str(s);
        return;
    }
    let keep = MAX_OUTPUT_BYTES - s.len();
    let start = ceil_char_boundary(buf, buf.len().saturating_sub(keep));
    buf.replace_range(..start, "");
    buf.push_str(s);
}

/// 注入支持包（zip）到 Evaluator 容器的 /workspace 目录。
///
/// VULN-17：先同步提取 zip 中所有文件到内存，再用**一次**批量注入
/// （单个 tar 流 + 单次 `docker exec`）解包，消除 N 次串行 exec。
async fn inject_support_package_to_evaluator(
    docker: &bollard::Docker,
    container_id: &str,
    zip_path: &Path,
) -> Result<()> {
    // 直接以磁盘文件作为 zip 读取源，避免先把整个 zip 读进内存再 to_vec 拷贝。
    // ZipFile 不是 Send，因此仍在 spawn_blocking 中做同步解压，但输入是文件流。
    let entries = tokio::task::spawn_blocking({
        let path = zip_path.to_path_buf();
        move || extract_zip_entries_from_file(&path)
    })
    .await
    .context("spawn_blocking 提取 zip 失败")??;

    // 目录条目由 tar 解压自动创建，无需注入；文件**按值消费**注入
    // （NOJ-A1：边写边释放条目数据，峰值内存不再随"条目 + tar"翻倍）。
    let entry_count = entries.len();
    let files: Vec<ZipEntry> = entries.into_iter().filter(|entry| !entry.is_dir).collect();
    let file_count = files.len();

    inject_zip_entries_to_container(docker, container_id, files)
        .await
        .context("批量注入支持包文件失败")?;

    info!(
        "支持包注入完成 (共 {} 个条目，其中 {} 个文件，单次 exec)",
        entry_count, file_count
    );
    Ok(())
}

/// 从容器读取一次内存峰值（KB）。
///
/// Docker `stats` 的 `memory_stats.max_usage` 仅 cgroups v1 可用；
/// cgroups v2 下该字段缺失，回退到 `usage` 近似值。读取失败或容器已销毁时
/// 返回 `None`（不阻断评测主流程）。
async fn read_container_memory_peak_kb(
    docker: &bollard::Docker,
    container_id: &str,
) -> Option<u64> {
    let options = StatsOptionsBuilder::default()
        .stream(false)
        .one_shot(true)
        .build();
    let mut stream = docker.stats(container_id, Some(options));

    let stat = match tokio::time::timeout(Duration::from_secs(3), stream.next()).await {
        Ok(Some(Ok(stat))) => stat,
        _ => return None,
    };

    let memory = stat.memory_stats?;
    // max_usage 单位字节；cgroups v2 无 max_usage 时退回 usage。
    let peak_bytes = memory.max_usage.or(memory.usage)?;
    Some(peak_bytes / 1024)
}

/// 双容器评测入口，允许通过 Worker 配置传入每个容器的 CPU 上限。
///
/// `instance_id`：由 `Config::instance_id` 显式注入的确定性实例 ID
/// （`noj-{hash12}`），用于容器实例标签与启动清扫（VULN-15）。
#[allow(clippy::too_many_arguments)]
pub async fn evaluate_dual_with_cpu_limit(
    docker: bollard::Docker,
    task_submission_id: &str,
    runtime_config: &RuntimeConfig,
    user_code: &str,
    support_pkg_path: Option<&Path>,
    artifact_zip_path: Option<&Path>,
    task_rejudge_seq: Option<i64>,
    task_llm: Option<&JudgeTaskLlm>,
    cpu_limit_millicores: u64,
    allow_evaluator_network: bool,
    evaluator_network_mode: &str,
    image_prefix: &str,
    command_whitelist: &[String],
    max_evaluator_time_ms: u64,
    max_solution_call_timeout_ms: u64,
    instance_id: &str,
) -> Result<JudgeResult> {
    let runtime_config = clamp_runtime_config(
        runtime_config,
        max_evaluator_time_ms,
        max_solution_call_timeout_ms,
    );
    validate_runtime_config(
        task_submission_id,
        &runtime_config,
        allow_evaluator_network,
        image_prefix,
        command_whitelist,
    )?;
    let started = Instant::now();
    // F-08：启动期 30s 绝对时限从注入/容器准备阶段开始计时（注入耗时计入启动期）。
    let startup_deadline = Instant::now() + Duration::from_secs(30);
    let evaluator_cmd = parse_command(&runtime_config.evaluator.command);

    // 1. 创建 Evaluator 容器
    let evaluator_network_enabled = runtime_config
        .evaluator
        .network
        .as_ref()
        .map(|n| n.enabled)
        .unwrap_or(false);
    let network_mode = if evaluator_network_enabled {
        evaluator_network_mode
    } else {
        "none"
    };
    let mut dual = DualContainer::create_evaluator(
        &docker,
        &runtime_config.evaluator.image,
        runtime_config.evaluator.memory_limit_mb,
        network_mode,
        cpu_limit_millicores,
        instance_id,
    )
    .await
    .context("创建 Evaluator 容器失败")?;

    // 2. 创建 Solution 容器
    dual.create_solution(
        &runtime_config.solution.image,
        runtime_config.solution.memory_limit_mb,
        cpu_limit_millicores,
    )
    .await
    .context("创建 Solution 容器失败")?;

    let evaluator_id = dual
        .evaluator_id
        .clone()
        .ok_or_else(|| anyhow::anyhow!("Evaluator 容器 ID 缺失"))?;
    let solution_id = dual
        .solution_id
        .clone()
        .ok_or_else(|| anyhow::anyhow!("Solution 容器 ID 缺失"))?;

    // VULN-15（Drain 优雅退出）：容器创建之后的**全部**步骤都放在这个内部 async 块里，
    // 使任何提前返回（注入失败 / 启动 exec 失败 / 编排错误）都会走到下面显式的
    // `dual.destroy().await`。否则 `?` 提前返回会触发 `DualContainer::drop`，而 Drop
    // 里的 `tokio::spawn` 在 drain 阶段会被运行时就绪销毁强杀 → 孤儿容器残留。
    let evaluation = async {
        // 3. 注入支持包到 Evaluator 容器（evaluate.py 等评测脚本）
        if let Some(pkg_path) = support_pkg_path {
            info!("注入支持包到 Evaluator 容器: {:?}", pkg_path);
            inject_support_package_to_evaluator(&docker, &evaluator_id, pkg_path)
                .await
                .context("注入支持包到 Evaluator 容器失败")?;
        } else {
            info!("无支持包，跳过注入");
        }

        // 4. 注入用户代码/artifact 到 Solution 容器
        let solution_entry_file = if artifact_zip_path.is_some() {
            "submission.py"
        } else {
            SOLUTION_ENTRY_FILE
        };
        if let Some(artifact_path) = artifact_zip_path {
            info!("注入 artifact zip 到 Solution 容器: {:?}", artifact_path);
            inject_support_package_to_evaluator(&docker, &solution_id, artifact_path)
                .await
                .context("注入 artifact zip 到 Solution 容器失败")?;
        } else {
            inject_file_to_container(
                &docker,
                &solution_id,
                SOLUTION_ENTRY_FILE,
                user_code.as_bytes(),
            )
            .await
            .context("注入用户代码到 Solution 容器失败")?;
        }

        // 5. 构造 Evaluator 环境变量（LLM 任务注入 gateway 地址、eval_token 与提交标识）
        let evaluator_env = task_llm
            .map(|llm| {
                crate::dual::llm_env::build_llm_env(llm, task_submission_id, task_rejudge_seq)
            })
            .unwrap_or_default();

        // 6. 启动 Evaluator exec
        let evaluator_exec = start_exec(&docker, &evaluator_id, evaluator_cmd, evaluator_env)
            .await
            .context("启动 Evaluator exec 失败")?;

        // 7. 启动 Solution exec（Solution 容器不注入任何 NOJ_LLM_* 环境变量）
        let solution_entry_path = format!("/workspace/{}", solution_entry_file);
        let solution_exec = start_exec(
            &docker,
            &solution_id,
            vec![
                "python3".to_string(),
                "-m".to_string(),
                "noj_solution_sdk.host".to_string(),
                "--entry".to_string(),
                solution_entry_path,
            ],
            vec![],
        )
        .await
        .context("启动 Solution exec 失败")?;

        // 8. 运行主循环
        let result = run_dual_loop(
            task_submission_id,
            evaluator_exec,
            solution_exec,
            runtime_config.evaluator.time_limit_ms,
            runtime_config.solution.call_timeout_ms,
            task_rejudge_seq,
            startup_deadline,
        )
        .await;

        // NOJ-162：销毁前读取 Solution 容器内存峰值（仅尽力而为，失败不影响结果）
        let memory_peak_kb = read_container_memory_peak_kb(&docker, &solution_id).await;
        if let Some(kb) = memory_peak_kb {
            info!(
                submission_id = task_submission_id,
                memory_kb = kb,
                "Solution 容器内存峰值已读取"
            );
        }

        Ok::<_, anyhow::Error>((result, memory_peak_kb))
    }
    .await;

    // 9. 显式 await 销毁（不论成功失败）——正常路径绝不依赖 Drop 的托管的 spawn。
    if let Err(e) = dual.destroy().await {
        warn!("DualContainer 销毁警告: {}", e);
    }

    let (result, memory_peak_kb) = evaluation?;

    // NOJ-162：回填真实总耗时与内存峰值
    let mut result = result?;
    if result.time_ms.is_none() {
        result.time_ms = Some(started.elapsed().as_millis() as u64);
    }
    if result.memory_kb.is_none() {
        result.memory_kb = memory_peak_kb;
    }
    Ok(result)
}

/// 超时种类：判定最终状态时区分启动期与正式评测期。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum TimeoutKind {
    /// 阶段 1：评测程序启动等待超时（容器创建 / 文件注入 / 运行时启动开销）
    Startup,
    /// 阶段 2：evaluator 整体执行超过 time_limit_ms
    Total,
}

/// 评测收尾判定：把「评测如何结束」映射为最终状态。
///
/// 仅在 evaluator 未正常输出 ---RESULT--- 时调用（有 RESULT 走 build_judge_result）。
/// 规则（顺序即优先级，决策 5 / AR-07）：
/// 1. 启动等待超时（Startup）→ SystemError：容器拉取/注入/运行时环境异常，平台侧故障；
/// 2. 总执行超时（Total）或曾向 evaluator 发送过 CallTimeout 错误帧 → TimeLimitExceeded：做题人代码慢/超时；
/// 3. 否则 → SystemError：evaluator 自身异常。
fn finalize_outcome(timed_out: Option<TimeoutKind>, sent_call_timeout: bool) -> JudgeStatus {
    if let Some(kind) = timed_out {
        match kind {
            TimeoutKind::Startup => return JudgeStatus::SystemError,
            TimeoutKind::Total => return JudgeStatus::TimeLimitExceeded,
        }
    }
    if sent_call_timeout {
        return JudgeStatus::TimeLimitExceeded;
    }
    JudgeStatus::SystemError
}

/// 主循环：双向 NDJSON 转发 + 解析 Evaluator 输出。
/// 等待下一个调用级超时到期（无 in-flight 调用时永久等待）。
async fn next_call_timeout(tracker: &InFlightTracker) {
    match tracker.next_deadline() {
        Some(d) => tokio::time::sleep_until(d.into()).await,
        None => std::future::pending::<()>().await,
    }
}

/// 处理调用级超时到期：向等待方（Evaluator/Solution）写 timeout 帧。
///
/// 返回 `(evaluator_stdin, solution_stdin)` 两个方向的写入结果（VULN-16）：
/// [`PipeWriteOutcome::PeerGone`] 表示该方向对端 stdin 已死，调用方应结束对应流。
async fn expire_call_timeouts(
    tracker: &mut InFlightTracker,
    eval_input: &mut std::pin::Pin<Box<dyn tokio::io::AsyncWrite + Send + Unpin>>,
    sol_input: &mut std::pin::Pin<Box<dyn tokio::io::AsyncWrite + Send + Unpin>>,
    sent_call_timeout: &mut bool,
) -> Result<(PipeWriteOutcome, PipeWriteOutcome)> {
    let mut eval_outcome = PipeWriteOutcome::Written;
    let mut sol_outcome = PipeWriteOutcome::Written;
    for (id, side) in tracker.expire_now(Instant::now()) {
        match side {
            WaitingSide::Evaluator => {
                let outcome = write_timeout_frame(eval_input, &id).await?;
                if outcome == PipeWriteOutcome::PeerGone {
                    eval_outcome = PipeWriteOutcome::PeerGone;
                }
                *sent_call_timeout = true;
            }
            WaitingSide::Solution => {
                let outcome = write_timeout_frame(sol_input, &id).await?;
                if outcome == PipeWriteOutcome::PeerGone {
                    sol_outcome = PipeWriteOutcome::PeerGone;
                }
            }
        }
    }
    Ok((eval_outcome, sol_outcome))
}

/// 超时收尾：按 finalize_outcome 判定结果（TLE 或 SystemError）。
/// `kind` 区分启动超时（Startup）与评测总超时（Total），语义上两者归因相同。
fn timeout_result(
    submission_id: &str,
    rejudge_seq: Option<i64>,
    sent_call_timeout: bool,
    kind: TimeoutKind,
    message: &str,
) -> JudgeResult {
    match finalize_outcome(Some(kind), sent_call_timeout) {
        JudgeStatus::TimeLimitExceeded => JudgeResult::timeout(submission_id, message, rejudge_seq),
        _ => JudgeResult::system_error(submission_id, message, rejudge_seq),
    }
}

#[allow(clippy::too_many_arguments)]
async fn run_dual_loop(
    submission_id: &str,
    evaluator_exec: ExecSession,
    solution_exec: ExecSession,
    evaluator_timeout_ms: u64,
    default_call_timeout_ms: u64,
    rejudge_seq: Option<i64>,
    startup_deadline: Instant,
) -> Result<JudgeResult> {
    // 解构 exec 拿到 output/input
    let ExecSession {
        output: mut eval_output,
        input: mut eval_input,
        ..
    } = evaluator_exec;
    let ExecSession {
        output: mut sol_output,
        input: mut sol_input,
        ..
    } = solution_exec;

    let mut eval_parser = LineParser::new();
    let mut eval_stderr_buf = String::new();
    let mut eval_stdout_full = String::new();

    let mut sol_parser = LineParser::new();
    let mut solution_ready = false;

    let mut result_payload: Option<String> = None;

    // 调用级超时追踪器（题目级 call_timeout_ms 作为缺省回退值）
    let mut tracker = InFlightTracker::new(default_call_timeout_ms);

    // 是否向 evaluator 发送过 CallTimeout 错误帧（solution 调用超时）。
    // 仅 WaitingSide::Evaluator（evaluator 等 solution 的 call）置位；
    // WaitingSide::Solution（capability 反向调用超时）不置位——其错误帧写给 solution，
    // 不构成「evaluator 未处理 CallTimeout」归因。
    let mut sent_call_timeout = false;

    // Solution 流是否已结束。结束后禁用 select 中的 Solution 分支，
    // 但继续消费 Evaluator 输出（见下方修复说明），避免丢失 RESULT payload。
    // VULN-16：Solution stdin 已死（写入超时/EPIPE）时也会置位。
    let mut solution_done = false;

    // Evaluator 流是否已结束（EOF / 流错误 / stdin 已死）。结束后禁用 Evaluator 分支，
    // 避免对已耗尽的流反复 poll（select 会立即就绪导致忙循环）。
    let mut evaluator_done = false;

    // 阶段 1：等待评测程序真正开始运行（收到首条输出，通常为 ready 帧）。
    // F-08：启动期 30s 绝对时限从注入/容器准备阶段开始计时，
    // 因此这里按剩余时间生成 sleep，注入耗时不再“重置”启动超时。
    let startup_remaining = startup_deadline.saturating_duration_since(Instant::now());
    let startup_deadline = tokio::time::sleep(startup_remaining);
    tokio::pin!(startup_deadline);

    let mut evaluator_started = false;
    while !evaluator_started {
        tokio::select! {
            _ = &mut startup_deadline => {
                warn!("Evaluator 启动超时（30s）: {}", submission_id);
                return Ok(timeout_result(
                    submission_id,
                    rejudge_seq,
                    sent_call_timeout,
                    TimeoutKind::Startup,
                    "Evaluator 启动超时",
                ));
            }
            // 调用级超时（in-flight 到期）
            _ = next_call_timeout(&tracker) => {
                let (eval_pipe, sol_pipe) = expire_call_timeouts(
                    &mut tracker,
                    &mut eval_input,
                    &mut sol_input,
                    &mut sent_call_timeout,
                )
                .await?;
                // VULN-16：Evaluator stdin 已死 → 立即异常收尾，不空转到启动超时。
                if eval_pipe == PipeWriteOutcome::PeerGone {
                    warn!("Evaluator stdin 已关闭，启动阶段异常收尾: {}", submission_id);
                    return Ok(JudgeResult::system_error(
                        submission_id,
                        "Evaluator stdin 已关闭（写入超时或 EPIPE）",
                        rejudge_seq,
                    ));
                }
                if sol_pipe == PipeWriteOutcome::PeerGone {
                    solution_done = true;
                }
            }
            chunk = eval_output.next() => {
                let chunk = match chunk {
                    Some(Ok(c)) => c,
                    Some(Err(e)) => {
                        error!("Evaluator exec 流错误: {}", e);
                        return Ok(JudgeResult::system_error(
                            submission_id,
                            &format!("Evaluator 启动失败: {}", e),
                            rejudge_seq,
                        ));
                    }
                    None => {
                        // 评测程序未输出任何内容即退出
                        return Ok(JudgeResult::system_error(
                            submission_id,
                            "Evaluator 未启动（无输出即退出）",
                            rejudge_seq,
                        ));
                    }
                };
                // VULN-16：启动阶段若 Solution stdin 已死，立刻标记该流结束
                // （阶段 2 不再向它写帧，避免每帧都等满 3s 超时）。
                let solution_pipe_ok = handle_eval_chunk(
                    &mut eval_parser,
                    &mut eval_stderr_buf,
                    &mut eval_stdout_full,
                    &mut sol_input,
                    &mut result_payload,
                    &mut tracker,
                    chunk,
                )
                .await?;
                if !solution_pipe_ok {
                    warn!("Solution stdin 已关闭（启动阶段），终止该方向转发");
                    solution_done = true;
                }
                if result_payload.as_ref().is_some_and(|p| !p.is_empty()) {
                    break;
                }
                evaluator_started = true;
            }
            else => break,
        }
    }

    // 阶段 2：正式评测——总超时从评测程序开始运行起算（题目 time_limit_ms）。
    //
    // 修复（D0）：守卫条件必须是「payload **尚未完整取得**」，而不只是
    // `is_none()`。阶段 1 是 `while !evaluator_started` 循环：一旦收到首条输出
    // （例如只有 `---RESULT---` 标记的那一个 chunk）就会正常退出循环，此时
    // `result_payload == Some("")`（已见标记、payload 待读）。若此处用 `is_none()`
    // 判断，阶段 2 会被整体跳过，payload 永远不被读取 —— 随后尾部逻辑判定
    // 「已见标记但无 payload」，把合法评测结果误判为 SystemError（提交丢分）。
    //
    // 该缺陷表现为时序相关的偶发失败：标记与 payload 落在**同一个** chunk 时
    // （一次 handle_eval_chunk 内连续处理两行）恰好正常；分成两个 chunk 到达
    // （评测脚本先 flush 标记、稍后再写 payload）则必然丢结果。
    if result_payload.as_deref().is_none_or(|p| p.is_empty()) {
        let deadline = tokio::time::sleep(Duration::from_millis(evaluator_timeout_ms));
        tokio::pin!(deadline);

        'outer: loop {
            // 退出条件 1（首选）：结果 payload 已完整取得 → 立即收尾。
            //
            // 必须优先于下面的「Evaluator 流结束」条件：Solution 容器承载的是常驻
            // host 进程，它只在收到 `shutdown` 帧或 **stdin EOF** 时退出，而编排
            // 循环全程持有 `sol_input` 从不关闭、也从不向它发 shutdown 帧。因此
            // Solution 的 EOF 在生产中基本不会出现；若等它结束才收尾，必然拖到
            // 总超时（表现为 status=error「Evaluator 总超时」，而结果其实早已拿到）。
            if result_payload.as_deref().is_some_and(|p| !p.is_empty()) {
                break 'outer;
            }

            // 退出条件 2：Evaluator 流已结束 → 立即收尾。
            //
            // Evaluator 是 RESULT 的唯一来源：它的 stdout 一旦关闭（EOF 或流错误），
            // payload 不可能再补全，继续等待没有意义。先 drain 尾部残留（payload
            // 可能没有以换行结尾而留在解析器缓冲里），再退出。
            //
            // 修复（评审）：此前这里是 `evaluator_done && solution_done`。由于上述
            // 原因 `solution_done` 在生产中不可达，该条件实际永不成立 —— 当评测器
            // **不带 RESULT 标记**结束（崩溃、`sys.exit(1)`、被 OOM kill）时，循环会
            // 空转到 `evaluator_time_limit_ms` 才由 deadline 收尾。判定结果不受影响
            // （两条路径最终都是 error），但会白占评测槽位并拉长失败延迟。
            // 阶段 2 重构前这里是「Evaluator EOF 即 break」，本次恢复该快速失败语义。
            if evaluator_done {
                drain_eval_tail(&mut eval_parser, &mut eval_stdout_full, &mut result_payload);
                break 'outer;
            }

            tokio::select! {
                // 总超时
                _ = &mut deadline => {
                    warn!("Evaluator 总超时: {}", submission_id);
                    return Ok(timeout_result(
                        submission_id,
                        rejudge_seq,
                        sent_call_timeout,
                        TimeoutKind::Total,
                        "Evaluator 总超时",
                    ));
                }

                // 调用级超时（in-flight 到期）
                _ = next_call_timeout(&tracker) => {
                    let (eval_pipe, sol_pipe) = expire_call_timeouts(
                        &mut tracker,
                        &mut eval_input,
                        &mut sol_input,
                        &mut sent_call_timeout,
                    )
                    .await?;
                    // VULN-16：超时帧写不进去 = 对端 stdin 已死。
                    // Evaluator stdin 死 → 立即异常收尾；Solution stdin 死 → 结束其流。
                    if eval_pipe == PipeWriteOutcome::PeerGone {
                        warn!("Evaluator stdin 已关闭，异常收尾: {}", submission_id);
                        drain_eval_tail(
                            &mut eval_parser,
                            &mut eval_stdout_full,
                            &mut result_payload,
                        );
                        evaluator_done = true;
                    }
                    if sol_pipe == PipeWriteOutcome::PeerGone {
                        solution_done = true;
                    }
                }

                // Evaluator stdout/stderr
                chunk = eval_output.next(), if !evaluator_done => {
                    let chunk = match chunk {
                        Some(Ok(c)) => c,
                        Some(Err(e)) => {
                            error!("Evaluator exec 流错误: {}", e);
                            evaluator_done = true;
                            continue;
                        }
                        None => {
                            // 修复（D0）：Evaluator EOF 时**先 drain 解析器缓冲**再退出。
                            // payload 行可能没有以换行结尾（EOF 残留），此时它仍在
                            // eval_parser.buf 中；直接 break 会丢弃它，把合法结果误判为
                            // SystemError（提交丢分）。drain_remaining() 将其作为最后
                            // 一行交回，交由下方统一的 payload 提取逻辑处理。
                            drain_eval_tail(
                                &mut eval_parser,
                                &mut eval_stdout_full,
                                &mut result_payload,
                            );
                            evaluator_done = true;
                            continue;
                        }
                    };
                    // VULN-16：Solution stdin 已死（写入超时/EPIPE）→ 该流结束，
                    // 后续帧不再尝试投递（避免每帧都等满 3s 超时）。
                    if !handle_eval_chunk(
                        &mut eval_parser,
                        &mut eval_stderr_buf,
                        &mut eval_stdout_full,
                        &mut sol_input,
                        &mut result_payload,
                        &mut tracker,
                        chunk,
                    )
                    .await?
                    {
                        solution_done = true;
                    }
                    if result_payload.as_ref().is_some_and(|p| !p.is_empty()) {
                        break 'outer;
                    }
                }

                // Solution stdout/stderr
                //
                // 修复（D0）：Solution 流结束**不代表**评测结束。
                // Evaluator 可能仍有在途/待 flush 输出——典型场景是 evaluate.py
                // 先写 `---RESULT---`（若 stdout 为行缓冲则立即下发），payload 行
                // 则要等进程退出时才 flush。此前在此处直接 `break 'outer` 会抛弃
                // Evaluator 的剩余输出，导致 payload 丢失 → 合法结果被误判为
                // SystemError（提交丢分），且表现为时序相关的偶发失败。
                //
                // 现在只把 Solution 标记为已结束并禁用该分支，继续等待 Evaluator
                // 输出，直到其 EOF、payload 完整，或总超时兜底（不会无限挂起）。
                chunk = sol_output.next(), if !solution_done => {
                    match chunk {
                        Some(Ok(c)) => {
                            // VULN-16：Evaluator stdin 已死 → 按协议转入异常收尾
                            // （置 evaluator_done，由循环顶部 drain + 结束）。
                            if !handle_sol_chunk(
                                &mut sol_parser,
                                &mut eval_input,
                                c,
                                &mut solution_ready,
                                &mut tracker,
                            )
                            .await?
                            {
                                warn!(
                                    "Evaluator stdin 已关闭，停止转发 solution 帧: {}",
                                    submission_id
                                );
                                evaluator_done = true;
                            }
                        }
                        Some(Err(e)) => {
                            error!("Solution exec 流错误: {}", e);
                            solution_done = true;
                        }
                        None => {
                            solution_done = true;
                        }
                    }
                }

                else => {
                    // 安全网：所有分支同时不可用时的兜底退出（正常路径由循环顶部的
                    // 「payload 完整」/「evaluator_done」两个判定处理）。
                    drain_eval_tail(
                        &mut eval_parser,
                        &mut eval_stdout_full,
                        &mut result_payload,
                    );
                    break 'outer;
                }
            }
        }
    }

    // 解析最终结果
    if let Some(payload) = result_payload.as_deref().filter(|p| !p.is_empty()) {
        // payload 是 `---RESULT---` 后第一行 JSON
        let parsed: serde_json::Value =
            serde_json::from_str(payload).context("---RESULT--- JSON 解析失败")?;
        return Ok(build_judge_result(
            submission_id,
            &parsed,
            &eval_stderr_buf,
            &eval_stdout_full,
            rejudge_seq,
        ));
    }

    // 已见 RESULT 标记但 payload 行未以换行结束（EOF 残留）时，
    // 把 drain 出的最后一行当作 payload，避免把合法结果误判为 SystemError。
    // （幂等：循环内的 drain 已执行过时，此处不再产生内容。）
    drain_eval_tail(&mut eval_parser, &mut eval_stdout_full, &mut result_payload);

    if let Some(payload) = result_payload.as_deref().filter(|p| !p.is_empty()) {
        let parsed: serde_json::Value =
            serde_json::from_str(payload).context("---RESULT--- JSON 解析失败")?;
        return Ok(build_judge_result(
            submission_id,
            &parsed,
            &eval_stderr_buf,
            &eval_stdout_full,
            rejudge_seq,
        ));
    }

    // 未拿到 RESULT 标记
    warn!("Evaluator 未输出 ---RESULT--- 标记: {}", submission_id);
    let full_output = crate::merge_output(&eval_stdout_full, &eval_stderr_buf);
    match finalize_outcome(None, sent_call_timeout) {
        JudgeStatus::TimeLimitExceeded => Ok(JudgeResult::timeout(
            submission_id,
            &full_output,
            rejudge_seq,
        )),
        _ => Ok(JudgeResult::system_error(
            submission_id,
            &full_output,
            rejudge_seq,
        )),
    }
}

/// 取出 Evaluator 解析器缓冲区中的尾部残留并尝试提取 RESULT payload。
///
/// 用于 Evaluator EOF / 编排循环收尾：`---RESULT---` 之后的 payload 行可能**没有
/// 以换行结尾**（评测脚本直接退出，或 stdout 缓冲在退出时才 flush），此时该行仍
/// 留在 [`LineParser`] 的内部缓冲中，从未经过 `feed()` 切分。若不 drain 就结束编排，
/// 合法结果会因「已见标记但无 payload」被误判为 SystemError（提交丢分）。
///
/// 幂等：`drain_remaining()` 会清空缓冲，重复调用不再产生内容。
fn drain_eval_tail(
    parser: &mut LineParser,
    stdout_full: &mut String,
    result_payload: &mut Option<String>,
) {
    for line in parser.drain_remaining() {
        if let EvaluatorLine::Unknown(s) = line {
            append_capped(stdout_full, &s);
            append_capped(stdout_full, "\n");
            // 仅当「已见标记、等待首条非空行」时吸收为 payload
            if result_payload.as_ref() == Some(&String::new()) && !s.trim().is_empty() {
                *result_payload = Some(s.trim().to_string());
            }
        }
    }
}

/// 处理 Evaluator exec 的一个 chunk：解析 + 转发 call 帧 + 检测 RESULT 标记。
///
/// 返回 `Ok(true)` 表示 forwarding 方向（Solution stdin）仍可用；`Ok(false)`
/// 表示 Solution stdin 已死（写入超时/EPIPE），调用方应立即把 Solution 流标记为
/// 结束（VULN-16），不得继续尝试写入。真实错误仍为 `Err`。
#[allow(clippy::too_many_arguments)]
async fn handle_eval_chunk(
    parser: &mut LineParser,
    stderr_buf: &mut String,
    stdout_full: &mut String,
    sol_input: &mut std::pin::Pin<Box<dyn tokio::io::AsyncWrite + Send + Unpin>>,
    result_payload: &mut Option<String>,
    tracker: &mut InFlightTracker,
    chunk: LogOutput,
) -> Result<bool> {
    let (data, is_err) = match chunk {
        LogOutput::StdOut { message } => (message, false),
        LogOutput::StdErr { message } => (message, true),
        _ => return Ok(true),
    };

    if is_err {
        let s = String::from_utf8_lossy(&data);
        append_capped(stderr_buf, &s);
        // Evaluator stderr 透传到日志（诊断用）
        debug!("[eval-stderr] {}", s);
        return Ok(true);
    }

    // stdout: feed 到 LineParser
    let lines = parser.feed(&data);
    for line in lines {
        match line {
            EvaluatorLine::ResultMarker => {
                // NOJ-160：用 Some("") 作为「已见标记、等待下一非空行」的跨 chunk 状态。
                *result_payload = Some(String::new());
                append_capped(stdout_full, RESULT_MARKER);
                append_capped(stdout_full, "\n");
            }
            EvaluatorLine::Frame(v) => {
                // 协议帧处理：
                // - call 帧：evaluator → solution 的函数调用，登记调用级超时后原样转发
                // - cap_reg 帧：judge 与 evaluator 的私有协议（capability 默认超时上报），不转发
                // - result/error 帧：capability 调用的响应（solution 等待），按 id 命中判定转发
                // 其他类型（log 等）记录但不转发
                match frame_type(&v) {
                    Some(FRAME_CALL) => {
                        // 登记调用级超时（缺省回退题目级默认），原样转发
                        tracker.on_call_frame(&v, Instant::now());
                        if forward_frame(sol_input, &v).await? == PipeWriteOutcome::PeerGone {
                            return Ok(false);
                        }
                    }
                    Some(FRAME_CAP_REG) => {
                        // judge 侧私有协议：更新 capability 超时映射，不转发给 solution
                        tracker.on_cap_reg_frame(&v);
                        debug!("cap_reg 帧已记录（不转发）: {}", v);
                    }
                    Some(FRAME_RESULT) | Some(FRAME_ERROR) => {
                        // capability 响应帧：命中则转发给 solution，迟到/未知丢弃
                        if let Some(id) = v.get("id").and_then(Value::as_str) {
                            if tracker.resolve_response(id) {
                                if forward_frame(sol_input, &v).await? == PipeWriteOutcome::PeerGone
                                {
                                    return Ok(false);
                                }
                            } else {
                                warn!("丢弃迟到的 evaluator 响应帧（id={}）", id);
                            }
                        }
                    }
                    // log：合法帧，judge 收集但不转发（保持既有语义）
                    Some(FRAME_LOG) => {}
                    // 未知/非法 type：按协议记录 warn 并丢弃
                    _ => {
                        warn!("丢弃未知 type 的 evaluator 帧: {}", v);
                    }
                }
                // 记录所有帧到 stdout 全文（供结果展示）
                let s = v.to_string();
                append_capped(stdout_full, &s);
                append_capped(stdout_full, "\n");
            }
            EvaluatorLine::Unknown(s) => {
                // 普通 evaluate.py 输出，丢弃
                append_capped(stdout_full, &s);
                append_capped(stdout_full, "\n");
                if result_payload.as_ref() == Some(&String::new()) && !s.trim().is_empty() {
                    *result_payload = Some(s.trim().to_string());
                }
            }
        }
    }
    Ok(true)
}

/// 处理 Solution exec 的一个 chunk：转发 NDJSON 帧到 evaluator stdin。
///
/// 返回 `Ok(true)` 表示 Evaluator stdin 仍可用；`Ok(false)` 表示 Evaluator stdin
/// 已死（写入超时/EPIPE），调用方应立即按协议转入异常收尾（VULN-16）。
async fn handle_sol_chunk(
    parser: &mut LineParser,
    eval_input: &mut std::pin::Pin<Box<dyn tokio::io::AsyncWrite + Send + Unpin>>,
    chunk: LogOutput,
    solution_ready: &mut bool,
    tracker: &mut InFlightTracker,
) -> Result<bool> {
    let data = match chunk {
        LogOutput::StdOut { message } => message,
        LogOutput::StdErr { message } => {
            // Solution stderr 透传到日志（诊断用）
            let s = String::from_utf8_lossy(&message);
            debug!("[sol-stderr] {}", s);
            return Ok(true);
        }
        _ => return Ok(true),
    };

    let lines = parser.feed(&data);
    for line in lines {
        if let EvaluatorLine::Frame(v) = line {
            // ready 之前只接受 ready 帧，其余忽略（防御）
            if !*solution_ready {
                if frame_type(&v) == Some(FRAME_READY) {
                    *solution_ready = true;
                }
                continue;
            }
            match frame_type(&v) {
                Some(FRAME_CAPABILITY) => {
                    // solution 请求 capability：查注册超时登记后转发 evaluator
                    tracker.on_capability_frame(&v, Instant::now());
                    if forward_frame(eval_input, &v).await? == PipeWriteOutcome::PeerGone {
                        return Ok(false);
                    }
                }
                Some(FRAME_RESULT) | Some(FRAME_ERROR) => {
                    // call 响应帧（evaluator 等待）：命中则转发，迟到/未知丢弃
                    if let Some(id) = v.get("id").and_then(Value::as_str) {
                        if tracker.resolve_response(id) {
                            if forward_frame(eval_input, &v).await? == PipeWriteOutcome::PeerGone {
                                return Ok(false);
                            }
                        } else {
                            warn!("丢弃迟到的 solution 响应帧（id={}）", id);
                        }
                    }
                }
                // log / shutdown 等合法帧：保持既有转发语义（solution → evaluator）
                Some(FRAME_LOG) | Some(FRAME_SHUTDOWN) => {
                    if forward_frame(eval_input, &v).await? == PipeWriteOutcome::PeerGone {
                        return Ok(false);
                    }
                }
                // 未知/非法 type：按协议记录 warn 并丢弃
                _ => {
                    warn!("丢弃未知 type 的 solution 帧: {}", v);
                }
            }
        }
    }
    Ok(true)
}

fn build_judge_result(
    submission_id: &str,
    parsed: &serde_json::Value,
    stderr: &str,
    stdout: &str,
    rejudge_seq: Option<i64>,
) -> JudgeResult {
    let full_output = crate::merge_output(stdout, stderr);
    // evaluate.py 结果 JSON 不再输出 status；即使携带旧 status 也统一映射为
    // finished / error，分数是唯一结果。
    let raw_status = parsed.get("status").and_then(Value::as_str);
    let status = match raw_status {
        Some(
            "error" | "SystemError" | "TimeLimitExceeded" | "MemoryLimitExceeded" | "RuntimeError",
        ) => "error",
        _ => "finished",
    }
    .to_string();
    let score = parsed
        .get("score")
        .and_then(Value::as_i64)
        .unwrap_or(0)
        .clamp(0, 10_000) as i32;
    let details = parsed.get("details").cloned().unwrap_or(Value::Null);

    JudgeResult {
        submission_id: submission_id.to_string(),
        status,
        score,
        output: full_output,
        details,
        time_ms: None,
        memory_kb: None,
        // NOJ-161：成功路径必须透传任务 rejudge_seq。
        rejudge_seq,
        // 版本化封套由 main.rs 在状态最终确定后统一补齐（apply_protocol）。
        run_id: None,
        problem_version_id: None,
        evaluation_protocol_version: None,
        result_kind: None,
    }
}

/// 集成测试辅助（tests/ 目录 E2E 使用，复用真实转发逻辑）。
///
/// 封装 [`handle_eval_chunk`] / [`handle_sol_chunk`]，跳过 stdout/stderr 收集，
/// 让 E2E 测试直接驱动 judge 转发语义。
#[allow(dead_code)] // 仅 tests/ 集成测试引用（lib 目标下必然未使用）
pub mod mod_test_helpers {
    use super::*;

    /// 等价 `handle_eval_chunk`，忽略 stderr/stdout 全文收集。
    pub async fn handle_eval_chunk_probe(
        parser: &mut LineParser,
        sol_input: &mut std::pin::Pin<Box<dyn tokio::io::AsyncWrite + Send + Unpin>>,
        result_payload: &mut Option<String>,
        tracker: &mut InFlightTracker,
        chunk: LogOutput,
    ) {
        let mut stderr_buf = String::new();
        let mut stdout_full = String::new();
        let _ = super::handle_eval_chunk(
            parser,
            &mut stderr_buf,
            &mut stdout_full,
            sol_input,
            result_payload,
            tracker,
            chunk,
        )
        .await;
    }

    /// 等价 `handle_sol_chunk`。
    pub async fn handle_sol_chunk_probe(
        parser: &mut LineParser,
        eval_input: &mut std::pin::Pin<Box<dyn tokio::io::AsyncWrite + Send + Unpin>>,
        chunk: LogOutput,
        solution_ready: &mut bool,
        tracker: &mut InFlightTracker,
    ) {
        let _ = super::handle_sol_chunk(parser, eval_input, chunk, solution_ready, tracker).await;
    }
}
