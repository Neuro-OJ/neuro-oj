use std::path::Path;
use std::sync::Arc;

use anyhow::{Context, Result};
use serde_json::Value;
use tracing::{error, info, warn};

use crate::judge::standard;
use crate::pool::copy::archive_and_copy;
use crate::pool::exec::{execute_in_container, read_memory_peak_kb};
use crate::pool::PoolManager;
use crate::sandbox::container::{self, ContainerOutput};
use crate::types::{JudgeResult, JudgeStatus, JudgeType};

/// Redis MQ 拉取到的评测任务。（引用 types::JudgeTask）
pub use crate::types::JudgeTask;

/// 执行评测任务（池路径）。
///
/// 容器获取 / cleanup 由 `evaluate_with_pool` 负责，内部将评测逻辑委托给
/// `dispatch_evaluate`（按 `judge_type` 分流）。
pub async fn evaluate_with_pool(
    pool: Arc<PoolManager>,
    task: &JudgeTask,
    work_dir_root: &Path,
) -> Result<JudgeResult> {
    let submission_id = &task.submission_id;
    let image = &task.judge_image;

    // 计数器：任务开始
    pool.inc_tasks_total();

    // 1. 从池获取容器（带 RAII guard，? 提前返回时自动 cleanup）
    let guard = pool.acquire_guarded(image, task.memory_limit_mb).await?;
    let container_id = guard.container_id().to_string();

    // 2. 准备临时工作目录
    let work_dir = container::prepare_work_dir(work_dir_root, submission_id).await?;

    // 3. 分流执行评测逻辑
    let result = dispatch_evaluate(pool.clone(), task, &container_id, &work_dir).await;

    // 4. 清理临时目录
    let _ = tokio::fs::remove_dir_all(&work_dir).await;

    // 5. 手动释放 guard（触发 docker rm -f + in_flight-- + 回补检查）
    //    注意：不能同时调用 pool.release()，否则 in_flight 会被减两次
    guard.release().await;

    result
}

/// 评测逻辑核心入口——按 `task.judge_type` 分流到 standard / special 执行器。
///
/// standard 路径调用 `standard::run_standard_evaluate` 并由 orchestrator
/// 自己打印 `---RESULT---` 标记，结果由 `process_output` 统一解析。
/// special 路径保留原 `python3 /tmp/evaluate.py` 行为。
async fn dispatch_evaluate(
    pool: Arc<PoolManager>,
    task: &JudgeTask,
    container_id: &str,
    work_dir: &Path,
) -> Result<JudgeResult> {
    let submission_id = &task.submission_id;

    // 1. 解压支持包 + 写用户代码 + tar 注入容器（两个路径共享）
    prepare_workspace_and_archive(pool.as_ref(), container_id, task, work_dir).await?;
    info!("工作区准备完成: {}", submission_id);

    match task.judge_type {
        JudgeType::Standard => {
            // 2. 标准题：原生 Rust 执行器
            let (stdout, stderr, exit_code, time_ms, memory_kb) =
                standard::run_standard_evaluate(pool.as_ref(), container_id, work_dir, task)
                    .await
                    .context("standard 路径评测失败")?;

            info!(
                "标准评测完毕: {} (exit: {}, time: {}ms)",
                submission_id, exit_code, time_ms
            );

            let output = ContainerOutput {
                stdout,
                stderr,
                exit_code,
            };
            let mut result = process_output(task, &output);
            result.time_ms = Some(time_ms);
            result.memory_kb = Some(memory_kb);
            Ok(result)
        }
        JudgeType::Special => {
            // 2. SPJ 题：保留现有 python3 /tmp/evaluate.py 路径
            run_spj_evaluate(pool.as_ref(), container_id, task).await
        }
    }
}

/// 共享工作区准备：解压支持包 + 写用户代码 + tar 注入容器。
///
/// 两个评测路径（standard / special）都需要这一步骤，因此抽出来共享。
async fn prepare_workspace_and_archive(
    pool: &PoolManager,
    container_id: &str,
    task: &JudgeTask,
    work_dir: &Path,
) -> Result<()> {
    // 1. 解压支持包
    if let Some(zip_data) = container::get_support_package_bytes(task)? {
        container::extract_zip(&zip_data, work_dir).await?;
        info!(
            "支持包已解压: {} ({} bytes)",
            task.submission_id,
            zip_data.len()
        );
    } else {
        info!("无支持包，跳过解压: {}", task.submission_id);
    }

    // 2. 写入用户代码
    container::write_user_code(work_dir, task).await?;
    info!("用户代码已写入: {}", task.submission_id);

    // 3. tar 打包并注入到容器
    let max_archive_mb = pool.config().max_archive_mb;
    archive_and_copy(pool.docker(), container_id, work_dir, max_archive_mb)
        .await
        .context("archive_and_copy 失败")?;
    info!("文件已注入到容器: {}", task.submission_id);

    Ok(())
}

/// SPJ 路径：执行 `task.judge_command`（默认 `python3 /tmp/evaluate.py`），
/// 由 Python 脚本打印 `---RESULT---` 标记，`process_output` 解析后返回 JudgeResult。
async fn run_spj_evaluate(
    pool: &PoolManager,
    container_id: &str,
    task: &JudgeTask,
) -> Result<JudgeResult> {
    let submission_id = &task.submission_id;

    let cmd_parts = container::parse_command(&task.judge_command);
    let timeout_ms = task.time_limit_ms;
    let kill_grace = pool.config().kill_grace_secs;

    let (stdout, stderr, exit_code, time_ms) = execute_in_container(
        pool.docker(),
        container_id,
        &cmd_parts,
        timeout_ms,
        kill_grace,
    )
    .await?;

    info!(
        "SPJ 评测执行完毕: {} (exit: {}, time: {}ms)",
        submission_id, exit_code, time_ms
    );

    // 读取内存峰值
    let memory_kb = read_memory_peak_kb(pool.docker(), container_id)
        .await
        .unwrap_or(0);

    let output = ContainerOutput {
        stdout,
        stderr,
        exit_code,
    };
    let mut result = process_output(task, &output);
    result.time_ms = Some(time_ms);
    result.memory_kb = Some(memory_kb);
    Ok(result)
}

/// 执行评测任务（旧 Semaphore 路径）。
///
/// 使用 Semaphore + run_in_container，与原有行为一致。
///
/// standard 路径在旧路径下不支持（每次提交都新建容器，per-case 调度与
/// 容器生命周期不匹配），返回 SystemError 让操作者升级到池模式。
pub async fn evaluate_legacy(
    docker: &bollard::Docker,
    task: &JudgeTask,
    work_dir: &str,
) -> Result<JudgeResult> {
    use std::time::Instant;

    // standard 题在旧路径下不支持
    if task.judge_type == JudgeType::Standard {
        warn!(
            "standard 题在 legacy Semaphore 路径下不支持，请升级到池模式: {}",
            task.submission_id
        );
        return Ok(JudgeResult::system_error(
            &task.submission_id,
            "standard 评测模式需要 noj-judge 池模式，请联系管理员升级部署",
        ));
    }

    let start = Instant::now();
    let work_dir = Path::new(work_dir);
    let output = container::run_in_container(docker, task, work_dir).await?;
    let time_ms = start.elapsed().as_millis() as u64;

    // 内存峰值（容器在 run_in_container 末尾被 rm -f，需在之前读取）
    let memory_kb = 0; // 旧路径容器在 capture_logs 后立即被删除，无法读 cgroup

    let mut result = process_output(task, &output);
    result.time_ms = Some(time_ms);
    result.memory_kb = Some(memory_kb);
    Ok(result)
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
        .ok_or_else(|| anyhow::anyhow!("---RESULT--- 缺少 score 字段或类型错误"))?
        as i32;

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
            judge_type: JudgeType::Special,
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
            judge_type: JudgeType::Special,
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
            judge_type: JudgeType::Special,
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
            judge_type: JudgeType::Special,
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
            judge_type: JudgeType::Special,
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
