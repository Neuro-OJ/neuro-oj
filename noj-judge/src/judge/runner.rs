use anyhow::{Context, Result};
use bollard::Docker;
use serde_json::Value;
use std::path::Path;
use tracing::{error, info, warn};

use crate::sandbox::container::{run_in_container, ContainerOutput};
use crate::types::{JudgeResult, JudgeStatus};

/// 执行评测任务。
///
/// 编排完整流程：解压支持包 → 写入用户代码 → Docker 容器执行 → 解析结果 → 清理。
pub async fn evaluate(
    docker: &Docker,
    task: &crate::types::JudgeTask,
    work_dir: &str,
) -> Result<JudgeResult> {
    let work_dir = Path::new(work_dir);

    // 1. 在 Docker 容器中执行评测
    let output = run_in_container(docker, task, work_dir).await?;

    // 2. 根据退出码和输出构造结果
    let result = process_output(task, &output);

    Ok(result)
}

/// 处理容器输出，解析 ---RESULT--- 标记，构造 JudgeResult。
fn process_output(task: &crate::types::JudgeTask, output: &ContainerOutput) -> JudgeResult {
    let submission_id = &task.submission_id;
    let full_output = if output.stderr.is_empty() {
        output.stdout.clone()
    } else {
        format!("{}\n--- STDERR ---\n{}", output.stdout, output.stderr)
    };

    // 超时检测（exit_code = -1 由容器超时逻辑设置）
    if output.exit_code == -1 {
        warn!("评测超时: {}", submission_id);
        return JudgeResult::timeout(submission_id, &full_output);
    }

    // OOM 检测（Docker OOM kill 退出码为 137 = 128 + SIGKILL(9)）
    if output.exit_code == 137 {
        warn!("评测 OOM: {}", submission_id);
        return JudgeResult::memory_exceeded(submission_id, &full_output);
    }

    // 尝试解析 ---RESULT--- 标记
    match parse_result_marker(&output.stdout) {
        Ok(Some((status, score, details))) => {
            info!("评测完成: {} -> {} (score: {})", submission_id, status, score);

            // 非零退出码 + 有 ---RESULT--- → 以 evaluate.py 的输出为准，但记录 warn
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
            }
        }
        Ok(None) => {
            // 无 ---RESULT--- 标记
            if output.exit_code == 0 {
                // 正常退出但没有结果标记 → 可能是评测脚本有 bug
                error!("评测无结果标记: {}", submission_id);
                JudgeResult::runtime_error(submission_id, &full_output)
            } else {
                error!("评测运行时错误: {} (exit: {})", submission_id, output.exit_code);
                JudgeResult::runtime_error(submission_id, &full_output)
            }
        }
        Err(e) => {
            // JSON 解析失败
            error!("评测结果解析失败: {}: {}", submission_id, e);
            JudgeResult {
                submission_id: submission_id.to_string(),
                status: JudgeStatus::SystemError.as_str().to_string(),
                score: 0,
                output: full_output,
                details: Value::Null,
                time_ms: None,
                memory_kb: None,
            }
        }
    }
}

/// 从 stdout 中解析 ---RESULT--- 标记后的 JSON。
///
/// 返回 (status, score, details) 元组。
fn parse_result_marker(stdout: &str) -> Result<Option<(String, i32, Value)>> {
    const MARKER: &str = "---RESULT---";

    // 从后往前找最后一个 ---RESULT--- 标记
    let marker_pos = match stdout.rfind(MARKER) {
        Some(pos) => pos,
        None => return Ok(None),
    };

    // 标记后的第一行非空文本
    let after_marker = &stdout[marker_pos + MARKER.len()..];
    let json_str = match after_marker
        .lines()
        .find(|line| !line.trim().is_empty())
    {
        Some(s) => s,
        None => return Ok(None), // 标记后无有效内容，视作无结果
    };

    let parsed: Value =
        serde_json::from_str(json_str).context("解析 ---RESULT--- JSON 失败")?;

    let status = parsed
        .get("status")
        .and_then(|v| v.as_str())
        .ok_or_else(|| anyhow::anyhow!("---RESULT--- 缺少 status 字段"))?
        .to_string();

    let score = parsed
        .get("score")
        .and_then(|v| v.as_i64())
        .ok_or_else(|| anyhow::anyhow!("---RESULT--- 缺少 score 字段或类型错误"))? as i32;

    let details = parsed.get("details").cloned().unwrap_or(Value::Null);

    Ok(Some((status, score, details)))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::sandbox::container::ContainerOutput;

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
    fn test_parse_result_marker_invalid_json() {
        let stdout = "\
---RESULT---
{invalid json}
";
        let result = parse_result_marker(stdout);
        assert!(result.is_err());
    }

    #[test]
    fn test_parse_result_marker_empty_after_marker() {
        let stdout = "---RESULT---\n  \n  \n";
        let result = parse_result_marker(stdout).unwrap();
        // 标记后无有效内容
        assert!(result.is_none());
    }

    #[test]
    fn test_parse_result_marker_missing_fields() {
        let stdout = "\
---RESULT---
{\"status\":\"Accepted\"}
";
        let result = parse_result_marker(stdout);
        assert!(result.is_err()); // 缺少 score
    }

    #[test]
    fn test_process_output_accepted() {
        let task = crate::types::JudgeTask {
            submission_id: "test-123".to_string(),
            problem_id: "1001".to_string(),
            judge_image: "noj-judge-python".to_string(),
            judge_command: "python3 /tmp/evaluate.py".to_string(),
            support_package_base64: None,
            language:"python3".to_string(),
            code: "print('hello')".to_string(),
            file_name: Some("main.py".to_string()),
            time_limit_ms: 5000,
            memory_limit_mb: 512,
        };

        let output = ContainerOutput {
            stdout: "---RESULT---\n{\"status\":\"Accepted\",\"score\":1000,\"details\":{}}\n".to_string(),
            stderr: String::new(),
            exit_code: 0,
        };

        let result = process_output(&task, &output);
        assert_eq!(result.status, "Accepted");
        assert_eq!(result.score, 1000);
    }

    #[test]
    fn test_process_output_timeout() {
        let task = crate::types::JudgeTask {
            submission_id: "test-456".to_string(),
            problem_id: "1001".to_string(),
            judge_image: "noj-judge-python".to_string(),
            judge_command: "python3 /tmp/evaluate.py".to_string(),
            support_package_base64: None,
            language:"python3".to_string(),
            code: "".to_string(),
            file_name: None,
            time_limit_ms: 5000,
            memory_limit_mb: 512,
        };

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
        let task = crate::types::JudgeTask {
            submission_id: "test-789".to_string(),
            problem_id: "1001".to_string(),
            judge_image: "noj-judge-python".to_string(),
            judge_command: "python3 /tmp/evaluate.py".to_string(),
            support_package_base64: None,
            language:"python3".to_string(),
            code: "".to_string(),
            file_name: None,
            time_limit_ms: 5000,
            memory_limit_mb: 512,
        };

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
        let task = crate::types::JudgeTask {
            submission_id: "test-runtime".to_string(),
            problem_id: "1001".to_string(),
            judge_image: "noj-judge-python".to_string(),
            judge_command: "python3 /tmp/evaluate.py".to_string(),
            support_package_base64: None,
            language:"python3".to_string(),
            code: "".to_string(),
            file_name: None,
            time_limit_ms: 5000,
            memory_limit_mb: 512,
        };

        let output = ContainerOutput {
            stdout: "something broke".to_string(),
            stderr: "Traceback (most recent call last):".to_string(),
            exit_code: 1,
        };

        let result = process_output(&task, &output);
        assert_eq!(result.status, "RuntimeError");
    }
}
