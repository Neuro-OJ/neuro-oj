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

use crate::dual::container::{start_exec, DualContainer};
use crate::types::{JudgeResult, RuntimeConfig};

const PREDICTION_DIR: &str = "/workspace/prediction";
const RESULT_MARKER: &str = "---RESULT---";

/// 从 evaluator stdout 提取 `---RESULT---` 后的首个非空行。
fn extract_result_payload(stdout: &str) -> Option<String> {
    let mut lines = stdout.lines();
    while let Some(line) = lines.next() {
        if line.trim() == RESULT_MARKER {
            for next in lines.by_ref() {
                if !next.trim().is_empty() {
                    return Some(next.trim().to_string());
                }
            }
            return None;
        }
    }
    None
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
    let workspace_mb = rc
        .evaluator
        .workspace_size_mb
        .unwrap_or(default_workspace_mb);

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
    let mut stdout_full = String::new();
    let mut stderr_buf = String::new();

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
                append_chunk(&chunk, &mut stdout_full, &mut stderr_buf);
            }
        }
    }

    // 阶段 2：总时限内持续读取
    let deadline = Instant::now() + Duration::from_millis(time_limit_ms);
    loop {
        if extract_result_payload(&stdout_full).is_some() {
            break;
        }
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
            Ok(Some(Ok(chunk))) => append_chunk(&chunk, &mut stdout_full, &mut stderr_buf),
        }
    }

    match extract_result_payload(&stdout_full) {
        Some(payload) => match serde_json::from_str::<Value>(&payload) {
            Ok(parsed) => Ok(crate::dual::build_judge_result(
                submission_id,
                &parsed,
                &stderr_buf,
                &stdout_full,
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
        None => Ok(JudgeResult::system_error(
            submission_id,
            "评测脚本未输出结果标记",
            rejudge_seq,
        )),
    }
}

fn append_chunk(chunk: &LogOutput, stdout_full: &mut String, stderr_buf: &mut String) {
    match chunk {
        LogOutput::StdOut { message } => {
            stdout_full.push_str(&String::from_utf8_lossy(message));
        }
        LogOutput::StdErr { message } => {
            stderr_buf.push_str(&String::from_utf8_lossy(message));
        }
        _ => {}
    }
}

#[cfg(test)]
mod tests {
    use super::extract_result_payload;

    #[test]
    fn test_extract_result_payload() {
        let out = "some logs\n---RESULT---\n{\"score\":1000,\"details\":{}}\ntrailing";
        assert_eq!(
            extract_result_payload(out).as_deref(),
            Some("{\"score\":1000,\"details\":{}}")
        );
        assert_eq!(extract_result_payload("no marker here"), None);
        assert_eq!(extract_result_payload("---RESULT---\n\n  \n"), None);
    }
}
