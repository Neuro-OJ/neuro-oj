use std::path::Path;

use anyhow::{Context, Result};
use serde_json::Value;
use tracing::{error, info, warn};

use crate::sandbox::cache::SupportPackageCache;
use crate::sandbox::container::ContainerOutput;
use crate::sandbox::download;
use crate::types::{JudgeResult, JudgeStatus};

/// Redis MQ 拉取到的评测任务。（引用 types::JudgeTask）
pub use crate::types::JudgeTask;

/// 评测任务入口——统一使用双容器模式（Evaluator + Solution）。
pub async fn evaluate(
    docker: bollard::Docker,
    task: &JudgeTask,
    _work_dir_root: &Path,
    download_timeout_secs: u64,
    cache_dir: String,
    cache_max_items: usize,
    cache_max_mb: u64,
) -> Result<JudgeResult> {
    // 下载/获取支持包（含缓存）
    let support_pkg = if let Some(ref url) = task.download_url {
        if !url.is_empty() {
            match fetch_and_cache_support_package(
                url,
                download_timeout_secs,
                &cache_dir,
                cache_max_items,
                cache_max_mb,
            )
            .await
            {
                Ok(bytes) => {
                    info!(
                        submission_id = %task.submission_id,
                        size = bytes.len(),
                        "支持包已获取"
                    );
                    Some(bytes)
                }
                Err(e) => {
                    error!(
                        submission_id = %task.submission_id,
                        error = %e,
                        "支持包获取失败，继续执行（可能缺少评测文件）"
                    );
                    None
                }
            }
        } else {
            None
        }
    } else {
        None
    };

    crate::dual::evaluate_dual(
        docker,
        &task.submission_id,
        &task.runtime_config,
        &task.code,
        task.file_name.as_deref().unwrap_or("solution.py"),
        support_pkg.as_deref(),
        &cache_dir,
        cache_max_items,
        cache_max_mb,
        task.rejudge_seq,
    )
    .await
}

/// 获取支持包：缓存优先 → 按 host 分派下载 → SHA-256 校验 → 写缓存。
async fn fetch_and_cache_support_package(
    download_url: &str,
    download_timeout_secs: u64,
    cache_dir: &str,
    cache_max_items: usize,
    cache_max_mb: u64,
) -> Result<Vec<u8>> {
    // 尝试从缓存获取
    let cache = SupportPackageCache::new(cache_dir, cache_max_items, cache_max_mb).await?;

    // 先解析 URL 获取 checksum（用于缓存查找）
    let timeout = download_timeout_secs;
    let checksum = download::extract_checksum(download_url)?;
    if let Some(ref cs) = checksum {
        if let Some(cached) = cache.get(cs).await? {
            download::verify_checksum(&cached, Some(cs))?;
            return Ok(cached);
        }
    }

    let (zip_data, fetched_checksum) =
        download::fetch_support_package(download_url, timeout).await?;

    // SHA-256 校验
    download::verify_checksum(&zip_data, fetched_checksum.as_deref())?;

    // 写入缓存
    if let Some(ref cs) = fetched_checksum {
        if !cs.is_empty() {
            if let Err(e) = cache.set(cs, &zip_data).await {
                warn!("写入支持包缓存失败: {}", e);
            }
        }
    }

    Ok(zip_data)
}

/// 处理容器输出，解析 ---RESULT--- 标记，构造 JudgeResult。
#[allow(dead_code)]
pub fn process_output(task: &JudgeTask, output: &ContainerOutput) -> JudgeResult {
    let submission_id = &task.submission_id;
    let full_output = if output.stderr.is_empty() {
        output.stdout.clone()
    } else {
        format!("{}\n--- STDERR ---\n{}", output.stdout, output.stderr)
    };

    // 超时检测（exit_code = -1）
    if output.exit_code == -1 {
        warn!("评测超时: {}", submission_id);
        return JudgeResult::timeout(submission_id, &full_output, task.rejudge_seq);
    }

    // OOM 检测（退出码 137 = 128 + SIGKILL(9)）
    if output.exit_code == 137 {
        warn!("评测 OOM: {}", submission_id);
        return JudgeResult::memory_exceeded(submission_id, &full_output, task.rejudge_seq);
    }

    // 尝试解析 ---RESULT--- 标记
    match parse_result_marker(&output.stdout) {
        Ok(Some((status, score, details))) => {
            info!(
                "评测完成: {} -> {} (score: {})",
                submission_id, status, score
            );

            if output.exit_code != 0 {
                warn!(
                    "evaluate.py 有输出但退出码非零: {} (exit: {})",
                    submission_id, output.exit_code
                );
            }

            JudgeResult {
                submission_id: submission_id.to_string(),
                status,
                score,
                output: full_output,
                details,
                time_ms: None,
                memory_kb: None,
                rejudge_seq: task.rejudge_seq,
            }
        }
        Ok(None) => {
            if output.exit_code == 0 {
                error!("评测无结果标记: {}", submission_id);
                JudgeResult::system_error(submission_id, &full_output, task.rejudge_seq)
            } else {
                error!(
                    "评测运行时错误: {} (exit: {})",
                    submission_id, output.exit_code
                );
                JudgeResult::runtime_error(submission_id, &full_output, task.rejudge_seq)
            }
        }
        Err(e) => {
            error!("评测结果解析失败: {}: {}", submission_id, e);
            JudgeResult {
                submission_id: submission_id.to_string(),
                status: JudgeStatus::SystemError.as_str().to_string(),
                score: 0,
                output: full_output,
                details: Value::Null,
                time_ms: None,
                memory_kb: None,
                rejudge_seq: task.rejudge_seq,
            }
        }
    }
}

/// 从 stdout 中解析 ---RESULT--- 标记后的 JSON。
#[allow(dead_code)]
fn parse_result_marker(stdout: &str) -> Result<Option<(String, i32, Value)>> {
    const MARKER: &str = "---RESULT---";

    let marker_pos = match stdout.rfind(MARKER) {
        Some(pos) => pos,
        None => return Ok(None),
    };

    let after_marker = &stdout[marker_pos + MARKER.len()..];
    let json_str = match after_marker.lines().find(|line| !line.trim().is_empty()) {
        Some(s) => s,
        None => return Ok(None),
    };

    let parsed: Value = serde_json::from_str(json_str).context("解析 ---RESULT--- JSON 失败")?;

    let status = parsed
        .get("status")
        .and_then(|v| v.as_str())
        .ok_or_else(|| anyhow::anyhow!("---RESULT--- 缺少 status 字段"))?
        .to_string();

    let score = parsed
        .get("score")
        .and_then(|v| v.as_i64())
        .ok_or_else(|| anyhow::anyhow!("---RESULT--- 缺少 score 字段或类型错误"))?
        as i32;

    let details = parsed.get("details").cloned().unwrap_or(Value::Null);

    Ok(Some((status, score, details)))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::sandbox::container::ContainerOutput;

    fn make_test_task() -> JudgeTask {
        JudgeTask {
            submission_id: "test-123".to_string(),
            problem_id: "1001".to_string(),
            download_url: None,
            runtime_config: crate::types::RuntimeConfig {
                evaluator: crate::types::EvaluatorRuntime {
                    image: "noj-evaluator-python".to_string(),
                    command: "python3 /workspace/evaluate.py".to_string(),
                    time_limit_ms: 5000,
                    memory_limit_mb: 512,
                },
                solution: crate::types::SolutionRuntime {
                    image: "noj-solution-python".to_string(),
                    entry: "submission_sample.py".to_string(),
                    call_timeout_ms: 2000,
                    memory_limit_mb: 512,
                },
            },
            language: "python3".to_string(),
            code: "print('hello')".to_string(),
            file_name: Some("main.py".to_string()),
            rejudge_seq: None,
        }
    }

    #[test]
    fn test_parse_result_marker_valid() {
        let stdout = "\
Some debug output
---RESULT---
{\"status\":\"Accepted\",\"score\":1000,\"details\":{\"cases\":[]}}
";
        let result = parse_result_marker(stdout).unwrap();
        assert!(result.is_some());
        let (status, score, details) = result.unwrap();
        assert_eq!(status, "Accepted");
        assert_eq!(score, 1000);
        assert!(details.get("cases").is_some());
    }

    #[test]
    fn test_parse_result_marker_no_marker() {
        let stdout = "No marker here\n";
        let result = parse_result_marker(stdout).unwrap();
        assert!(result.is_none());
    }

    #[test]
    fn test_process_output_accepted() {
        let task = make_test_task();
        let output = ContainerOutput {
            stdout: "---RESULT---\n{\"status\":\"Accepted\",\"score\":1000,\"details\":{}}\n"
                .to_string(),
            stderr: String::new(),
            exit_code: 0,
        };

        let result = process_output(&task, &output);
        assert_eq!(result.status, "Accepted");
        assert_eq!(result.score, 1000);
    }

    #[test]
    fn test_process_output_timeout() {
        let task = make_test_task();
        let output = ContainerOutput {
            stdout: String::new(),
            stderr: "timed out".to_string(),
            exit_code: -1,
        };

        let result = process_output(&task, &output);
        assert_eq!(result.status, "TimeLimitExceeded");
    }

    #[test]
    fn test_process_output_oom() {
        let task = make_test_task();
        let output = ContainerOutput {
            stdout: String::new(),
            stderr: "Killed".to_string(),
            exit_code: 137,
        };

        let result = process_output(&task, &output);
        assert_eq!(result.status, "MemoryLimitExceeded");
    }

    #[test]
    fn test_process_output_runtime_error() {
        let task = make_test_task();
        let output = ContainerOutput {
            stdout: "something broke".to_string(),
            stderr: "Traceback (most recent call last):".to_string(),
            exit_code: 1,
        };

        let result = process_output(&task, &output);
        assert_eq!(result.status, "RuntimeError");
    }

    #[test]
    fn test_process_output_system_error() {
        let task = make_test_task();
        let output = ContainerOutput {
            stdout: "\u{8bc4}\u{6d4b}\u{6b63}\u{5e38}\u{6267}\u{884c}\u{4f46}\u{672a}\u{8f93}\u{51fa}---RESULT---".to_string(),
            stderr: String::new(),
            exit_code: 0,
        };
        let result = process_output(&task, &output);
        assert_eq!(result.status, "SystemError");
    }

    #[test]
    fn test_parse_result_marker_invalid_json() {
        let stdout = "---RESULT---\n{invalid json}\n";
        let result = parse_result_marker(stdout);
        assert!(result.is_err());
    }

    #[test]
    fn test_parse_result_marker_empty_after_marker() {
        let stdout = "---RESULT---\n  \n  \n";
        let result = parse_result_marker(stdout).unwrap();
        assert!(result.is_none());
    }

    #[test]
    fn test_parse_result_marker_missing_fields() {
        let stdout = "---RESULT---\n{\"status\":\"Accepted\"}\n";
        let result = parse_result_marker(stdout);
        assert!(result.is_err());
    }
}
