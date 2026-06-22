use std::path::Path;
use std::sync::Arc;

use anyhow::{Context, Result};
use serde_json::Value;
use tracing::{error, info, warn};

use crate::pool::exec::execute_in_container;
use crate::pool::copy::archive_and_copy;
use crate::pool::PoolManager;
use crate::sandbox::container::{self, ContainerOutput};
use crate::types::{JudgeResult, JudgeStatus};

/// Redis MQ 拉取到的评测任务。（引用 types::JudgeTask）
pub use crate::types::JudgeTask;

/// 执行评测任务（池路径）。
///
/// 获取容器后，将实际评测逻辑委托给 `do_evaluate_with_pool`，
/// 然后在函数返回前无条件执行 cleanup（释放容器 + 删除临时目录），
/// 确保不泄漏容器或磁盘空间。
pub async fn evaluate_with_pool(
    pool: Arc<PoolManager>,
    task: &JudgeTask,
    work_dir_root: &Path,
) -> Result<JudgeResult> {
    let submission_id = &task.submission_id;
    let image = &task.judge_image;

    // 1. 从池获取容器（带 RAII guard，? 提前返回时自动 cleanup）
    let guard = pool.acquire_guarded(image, task.memory_limit_mb).await?;
    let container_id = guard.container_id().to_string();

    // 2. 准备临时工作目录
    let work_dir = container::prepare_work_dir(work_dir_root, submission_id).await?;

    // 3. 执行评测逻辑
    let result = do_evaluate_with_pool(pool.clone(), task, &container_id, &work_dir).await;

    // 4. 无论成功或失败，均清理容器和临时目录
    if let Some(p) = pool.get_pool(image).await {
        pool.release(&p, &container_id).await;
    }
    let _ = tokio::fs::remove_dir_all(&work_dir).await;

    // 5. 手动释放 guard（防止 Drop 重复 cleanup）
    guard.release().await;

    result
}

/// 评测逻辑核心（不含资源获取/清理，方便确保 cleanup）。
async fn do_evaluate_with_pool(
    pool: Arc<PoolManager>,
    task: &JudgeTask,
    container_id: &str,
    work_dir: &Path,
) -> Result<JudgeResult> {
    let submission_id = &task.submission_id;

    // 1. 解压支持包
    if let Some(zip_data) = container::get_support_package_bytes(task)? {
        container::extract_zip(&zip_data, work_dir).await?;
        info!("支持包已解压: {} ({} bytes)", submission_id, zip_data.len());
    } else {
        info!("无支持包，跳过解压: {}", submission_id);
    }

    // 2. 写入用户代码
    container::write_user_code(work_dir, task).await?;
    info!("用户代码已写入: {}", submission_id);

    // 3. tar 打包并注入到容器
    let max_archive_mb = pool.config().max_archive_mb;
    archive_and_copy(pool.docker(), container_id, work_dir, max_archive_mb)
        .await
        .context("archive_and_copy 失败")?;
    info!("文件已注入到容器: {}", submission_id);

    // 4. docker exec 执行评测命令
    let cmd_parts = container::parse_command(&task.judge_command);
    let timeout_ms = task.time_limit_ms;
    let kill_grace = pool.config().kill_grace_secs;

    let (stdout, stderr, exit_code) = execute_in_container(
        pool.docker(),
        container_id,
        &cmd_parts,
        timeout_ms,
        kill_grace,
    )
    .await?;

    info!(
        "评测执行完毕: {} (exit: {})",
        submission_id, exit_code
    );

    // 5. 解析输出
    let output = ContainerOutput {
        stdout,
        stderr,
        exit_code,
    };
    Ok(process_output(task, &output))
}

/// 执行评测任务（旧路径）。
///
/// 使用 Semaphore + run_in_container，与原有行为一致。
pub async fn evaluate_legacy(
    docker: &bollard::Docker,
    task: &JudgeTask,
    work_dir: &str,
) -> Result<JudgeResult> {
    let work_dir = Path::new(work_dir);
    let output = container::run_in_container(docker, task, work_dir).await?;
    Ok(process_output(task, &output))
}

/// 处理容器输出，解析 ---RESULT--- 标记，构造 JudgeResult。
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
        return JudgeResult::timeout(submission_id, &full_output);
    }

    // OOM 检测（退出码 137 = 128 + SIGKILL(9)）
    if output.exit_code == 137 {
        warn!("评测 OOM: {}", submission_id);
        return JudgeResult::memory_exceeded(submission_id, &full_output);
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
            }
        }
        Ok(None) => {
            if output.exit_code == 0 {
                error!("评测无结果标记: {}", submission_id);
                JudgeResult::system_error(submission_id, &full_output)
            } else {
                error!(
                    "评测运行时错误: {} (exit: {})",
                    submission_id, output.exit_code
                );
                JudgeResult::runtime_error(submission_id, &full_output)
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
            }
        }
    }
}

/// 从 stdout 中解析 ---RESULT--- 标记后的 JSON。
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
    fn test_process_output_accepted() {
        let task = JudgeTask {
            submission_id: "test-123".to_string(),
            problem_id: "1001".to_string(),
            judge_image: "noj-judge-python".to_string(),
            judge_command: "python3 /tmp/evaluate.py".to_string(),
            support_package_base64: None,
            language: "python3".to_string(),
            code: "print('hello')".to_string(),
            file_name: Some("main.py".to_string()),
            time_limit_ms: 5000,
            memory_limit_mb: 512,
        };

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
        let task = JudgeTask {
            submission_id: "test-456".to_string(),
            problem_id: "1001".to_string(),
            judge_image: "noj-judge-python".to_string(),
            judge_command: "python3 /tmp/evaluate.py".to_string(),
            support_package_base64: None,
            language: "python3".to_string(),
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
        let task = JudgeTask {
            submission_id: "test-789".to_string(),
            problem_id: "1001".to_string(),
            judge_image: "noj-judge-python".to_string(),
            judge_command: "python3 /tmp/evaluate.py".to_string(),
            support_package_base64: None,
            language: "python3".to_string(),
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
        let task = JudgeTask {
            submission_id: "test-runtime".to_string(),
            problem_id: "1001".to_string(),
            judge_image: "noj-judge-python".to_string(),
            judge_command: "python3 /tmp/evaluate.py".to_string(),
            support_package_base64: None,
            language: "python3".to_string(),
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

    #[test]
    fn test_process_output_system_error() {
        let task = JudgeTask {
            submission_id: "test-no-marker".to_string(),
            problem_id: "1001".to_string(),
            judge_image: "noj-judge-python".to_string(),
            judge_command: "python3 /tmp/evaluate.py".to_string(),
            support_package_base64: None,
            language: "python3".to_string(),
            code: "".to_string(),
            file_name: None,
            time_limit_ms: 5000,
            memory_limit_mb: 512,
        };
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
