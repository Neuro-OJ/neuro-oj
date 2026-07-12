use std::path::Path;
use std::sync::Arc;

use anyhow::{Context, Result};
use serde_json::Value;
use tracing::{error, info, warn};

use crate::pool::copy::archive_and_copy;
use crate::pool::exec::execute_in_container;
use crate::pool::PoolManager;
use crate::sandbox::cache::SupportPackageCache;
use crate::sandbox::container::{self, ContainerOutput};
use crate::sandbox::download;
use crate::types::{JudgeResult, JudgeStatus};

/// Redis MQ 拉取到的评测任务。（引用 types::JudgeTask）
pub use crate::types::{JudgeMode, JudgeTask};

/// 评测任务分派入口（单/双容器自动分流）。
///
/// - `task.mode == 'single'`（默认）或缺省 → 单容器路径
/// - `task.mode == 'dual'` + `runtime_config` 非空 → 双容器路径
pub async fn evaluate(
    docker: bollard::Docker,
    task: &JudgeTask,
    _work_dir_root: &Path,
    _download_timeout_secs: u64,
    cache_dir: String,
    cache_max_items: usize,
    cache_max_mb: u64,
) -> Result<JudgeResult> {
    match task.mode {
        JudgeMode::Dual => {
            let rc = task
                .runtime_config
                .as_ref()
                .context("dual mode 要求 runtime_config 非空")?;
            crate::dual::evaluate_dual(
                docker,
                &task.submission_id,
                rc,
                &task.code,
                task.file_name.as_deref().unwrap_or("solution.py"),
                None, // 支持包挂载（v1 暂未实现，预留）
                &cache_dir,
                cache_max_items,
                cache_max_mb,
            )
            .await
        }
        JudgeMode::Single => {
            // 单容器路径使用 PoolManager；这里没有 PoolManager 因为 evaluate_with_pool
            // 已有完整实现，调用方应通过 evaluate_with_pool 而非本函数。
            anyhow::bail!("single 模式请调用 evaluate_with_pool，本入口仅支持 dual 路由");
        }
    }
}

/// 执行评测任务（单容器，with_container 闭包模式）。
///
/// 该入口会自行获取容器并在返回前释放；主循环可使用
/// `evaluate_with_container()` 复用已提前 acquire 的容器租约。
#[allow(dead_code)]
pub async fn evaluate_with_pool(
    pool: Arc<PoolManager>,
    task: &JudgeTask,
    work_dir_root: &Path,
    download_timeout_secs: u64,
    cache_dir: String,
    cache_max_items: usize,
    cache_max_mb: u64,
) -> Result<JudgeResult> {
    let lease = pool
        .acquire_container(&task.judge_image, task.memory_limit_mb)
        .await?;
    let result = evaluate_with_container(
        pool.clone(),
        task,
        lease.id(),
        work_dir_root,
        download_timeout_secs,
        cache_dir,
        cache_max_items,
        cache_max_mb,
    )
    .await;
    lease.release().await;
    result
}

/// 在已获取的容器中执行评测任务。
#[allow(clippy::too_many_arguments)]
pub async fn evaluate_with_container(
    pool: Arc<PoolManager>,
    task: &JudgeTask,
    container_id: &str,
    work_dir_root: &Path,
    download_timeout_secs: u64,
    cache_dir: String,
    cache_max_items: usize,
    cache_max_mb: u64,
) -> Result<JudgeResult> {
    // 计数器：任务开始
    pool.inc_tasks_total();

    // 创建临时工作目录（Drop 时自动清理）
    let temp_dir = container::TempDir::new(work_dir_root, &task.submission_id).await?;
    let work_dir_path: &Path = temp_dir.path();

    do_evaluate_with_pool(
        pool,
        task,
        container_id,
        work_dir_path,
        download_timeout_secs,
        &cache_dir,
        cache_max_items,
        cache_max_mb,
    )
    .await
}

/// 评测逻辑核心（不含资源获取/清理，方便确保 cleanup）。
#[allow(clippy::too_many_arguments)]
async fn do_evaluate_with_pool(
    pool: Arc<PoolManager>,
    task: &JudgeTask,
    container_id: &str,
    work_dir: &Path,
    download_timeout_secs: u64,
    cache_dir: &str,
    cache_max_items: usize,
    cache_max_mb: u64,
) -> Result<JudgeResult> {
    let submission_id = &task.submission_id;

    // 1. 获取并解压支持包（通过 download_url）
    if let Some(ref download_url) = task.download_url {
        if !download_url.is_empty() {
            match fetch_and_cache_support_package(
                download_url,
                download_timeout_secs,
                cache_dir,
                cache_max_items,
                cache_max_mb,
            )
            .await
            {
                Ok(zip_data) => {
                    container::extract_zip(&zip_data, work_dir).await?;
                    info!("支持包已解压: {} ({} bytes)", submission_id, zip_data.len());
                }
                Err(e) => {
                    error!("获取支持包失败: {}: {}", submission_id, e);
                    return Ok(JudgeResult::system_error(
                        submission_id,
                        &format!("获取支持包失败: {}", e),
                        task.rejudge_seq,
                    ));
                }
            }
        } else {
            info!("无支持包，跳过解压: {}", submission_id);
        }
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

    let (stdout, stderr, exit_code, time_ms) = execute_in_container(
        pool.docker(),
        container_id,
        &cmd_parts,
        timeout_ms,
        kill_grace,
    )
    .await?;

    info!(
        "评测执行完毕: {} (exit: {}, time: {}ms)",
        submission_id, exit_code, time_ms
    );

    // 5. 读取内存峰值
    let memory_kb = crate::pool::exec::read_memory_peak_kb(pool.docker(), container_id)
        .await
        .unwrap_or(0);

    // 6. 解析输出
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
            mode: crate::types::JudgeMode::Single,
            judge_image: "noj-judge-python".to_string(),
            judge_command: "python3 /tmp/evaluate.py".to_string(),
            download_url: None,
            runtime_config: None,
            language: "python3".to_string(),
            code: "print('hello')".to_string(),
            file_name: Some("main.py".to_string()),
            time_limit_ms: 5000,
            memory_limit_mb: 512,
            rejudge_seq: None,
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
            mode: crate::types::JudgeMode::Single,
            judge_image: "noj-judge-python".to_string(),
            judge_command: "python3 /tmp/evaluate.py".to_string(),
            download_url: None,
            runtime_config: None,
            language: "python3".to_string(),
            code: "".to_string(),
            file_name: None,
            time_limit_ms: 5000,
            memory_limit_mb: 512,
            rejudge_seq: None,
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
            mode: crate::types::JudgeMode::Single,
            judge_image: "noj-judge-python".to_string(),
            judge_command: "python3 /tmp/evaluate.py".to_string(),
            download_url: None,
            runtime_config: None,
            language: "python3".to_string(),
            code: "".to_string(),
            file_name: None,
            time_limit_ms: 5000,
            memory_limit_mb: 512,
            rejudge_seq: None,
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
            mode: crate::types::JudgeMode::Single,
            judge_image: "noj-judge-python".to_string(),
            judge_command: "python3 /tmp/evaluate.py".to_string(),
            download_url: None,
            runtime_config: None,
            language: "python3".to_string(),
            code: "".to_string(),
            file_name: None,
            time_limit_ms: 5000,
            memory_limit_mb: 512,
            rejudge_seq: None,
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
            mode: crate::types::JudgeMode::Single,
            judge_image: "noj-judge-python".to_string(),
            judge_command: "python3 /tmp/evaluate.py".to_string(),
            download_url: None,
            runtime_config: None,
            language: "python3".to_string(),
            code: "".to_string(),
            file_name: None,
            time_limit_ms: 5000,
            memory_limit_mb: 512,
            rejudge_seq: None,
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
