use anyhow::{Context, Result};
use redis::AsyncCommands;
use sha2::{Digest, Sha256};
use tracing::{error, info, warn};

use crate::types::{JudgeResult, JudgeTask};

/// BRPOPLPUSH 阻塞等待超时（秒）。
const BRPOP_TIMEOUT_SECS: f64 = 5.0;
const PROCESSING_SUFFIX: &str = ":processing";

/// 从 Redis 队列拉取并暂存到 processing 列表的任务。
pub struct PulledTask {
    pub task: JudgeTask,
    /// processing 列表中的原始消息，用于成功后 LREM 确认。
    pub raw: String,
}

fn processing_queue(queue: &str) -> String {
    format!("{}{}", queue, PROCESSING_SUFFIX)
}

/// 从 Redis 队列中拉取评测任务。
///
/// NOJ-179：使用 BRPOPLPUSH 把消息先移入 processing 列表，
/// 处理完成并成功投递结果后由 [`ack_task`] LREM 确认；
/// 崩溃时消息留在 processing，由 noj-core sweeper 超时重投。
pub async fn pull_task(
    conn: &mut redis::aio::MultiplexedConnection,
    queue: &str,
) -> Result<Option<PulledTask>> {
    let processing = processing_queue(queue);
    let raw: Option<String> = conn
        .brpoplpush(queue, &processing, BRPOP_TIMEOUT_SECS)
        .await
        .context("BRPOPLPUSH 拉取任务失败")?;

    match raw {
        Some(raw) => match parse_task_message(&raw) {
            Some(task) => Ok(Some(PulledTask { task, raw })),
            None => {
                // NOJ-181：坏消息记录原文并移出 processing，避免每次重启反复卡住。
                error!(
                    raw = %truncate_for_log(&raw),
                    "反序列化 JudgeTask 失败，消息已移入处理队列外（死信）"
                );
                let _: redis::RedisResult<usize> = conn.lrem(&processing, 1, &raw).await;
                Ok(None)
            }
        },
        None => Ok(None),
    }
}

fn truncate_for_log(raw: &str) -> String {
    if raw.len() <= 1024 {
        raw.to_string()
    } else {
        format!("{}...(truncated {} bytes)", &raw[..1024], raw.len())
    }
}

fn parse_task_message(value: &str) -> Option<JudgeTask> {
    match serde_json::from_str::<JudgeTask>(value) {
        Ok(task) => Some(task),
        Err(e) => {
            error!(error = %e, "反序列化 JudgeTask 失败");
            None
        }
    }
}

/// 确认任务完成：从 processing 列表移除原始消息。
///
/// 返回 false 表示确认失败（消息将由 sweeper 重投，at-least-once 可接受）。
pub async fn ack_task(redis_client: &redis::Client, judge_queue: &str, raw: &str) -> bool {
    match redis_client.get_multiplexed_async_connection().await {
        Ok(mut conn) => {
            let processing = processing_queue(judge_queue);
            let removed: std::result::Result<usize, redis::RedisError> =
                conn.lrem(&processing, 1, raw).await;
            match removed {
                Ok(_) => true,
                Err(e) => {
                    error!(error = %e, "任务 processing 确认失败");
                    false
                }
            }
        }
        Err(e) => {
            error!(error = %e, "任务 processing 确认时 Redis 连接失败");
            false
        }
    }
}

fn result_dedupe_key(json: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(json.as_bytes());
    format!("noj:judge:result:dedupe:{:x}", hasher.finalize())
}

/// 带重试的结果推送。
///
/// - 最多重试 3 次，间隔指数退避（1s, 2s, 4s）。
/// - NOJ-182：LPUSH 成功后以 SHA-256 key 标记 24h，重试/网络歧义时避免重复推送；
///   core 侧 `submission_id + rejudge_seq` 幂等作为最终兜底。
/// - 所有重试均失败后写 fallback 文件；返回 false 仅当 fallback 也失败
///   （此时调用方不得 ack 任务，等待 sweeper 重投）。
pub async fn push_result_with_retry(
    redis_client: &redis::Client,
    queue: &str,
    result: &JudgeResult,
    fallback_dir: &std::path::Path,
) -> bool {
    let submission_id = &result.submission_id;
    let json = match serde_json::to_string(result) {
        Ok(j) => j,
        Err(e) => {
            error!(submission_id, error = %e, "序列化评测结果失败，无法推送");
            return false;
        }
    };

    let dedupe_key = result_dedupe_key(&json);

    let mut last_error = String::new();
    for attempt in 1..=3 {
        match redis_client.get_multiplexed_async_connection().await {
            Ok(mut conn) => {
                let push_result: std::result::Result<usize, redis::RedisError> =
                    conn.lpush::<&str, &str, usize>(queue, &json).await;
                match push_result {
                    Ok(_) => {
                        // 标记成功后失败也无关紧要：core 幂等吸收。
                        let _: redis::RedisResult<bool> = conn
                            .set_ex::<&str, &str, bool>(&dedupe_key, "1", 86_400)
                            .await;
                        info!(submission_id, attempt, "评测结果已发布");
                        return true;
                    }
                    Err(e) => {
                        last_error = e.to_string();
                        warn!(submission_id, attempt, error = %e, "LPUSH 失败");
                    }
                }
            }
            Err(e) => {
                last_error = e.to_string();
                warn!(
                    submission_id,
                    attempt,
                    error = %e,
                    "Redis 连接失败（第 {}/3 次）",
                    attempt,
                );
            }
        }

        if attempt < 3 {
            let delay = std::time::Duration::from_secs(1 << (attempt - 1));
            tokio::time::sleep(delay).await;
        }
    }

    error!(
        submission_id,
        error = last_error,
        "评测结果推送失败（已重试 3 次），写入 fallback 文件"
    );

    if let Err(e) = tokio::fs::create_dir_all(fallback_dir).await {
        error!(submission_id, error = %e, "创建 fallback 目录失败");
        return false;
    }

    let fallback_path = fallback_dir.join(format!(
        "result-{}.json",
        sanitize_submission_id_for_filename(submission_id)
    ));
    match tokio::fs::write(&fallback_path, &json).await {
        Ok(_) => {
            info!(
                submission_id,
                path = %fallback_path.display(),
                "评测结果已写入 fallback 文件",
            );
            true
        }
        Err(e) => {
            error!(
                submission_id,
                error = %e,
                path = %fallback_path.display(),
                "写入 fallback 文件失败",
            );
            false
        }
    }
}

/// NOJ-180：启动时回放 fallback 结果文件，成功后删除原文件；
/// 坏文件改名 .dead 保留现场并记录原文。
pub async fn replay_fallback_results(
    redis_client: &redis::Client,
    queue: &str,
    fallback_dir: &std::path::Path,
) {
    let mut read_dir = match tokio::fs::read_dir(fallback_dir).await {
        Ok(d) => d,
        Err(_) => return,
    };

    while let Ok(Some(entry)) = read_dir.next_entry().await {
        let path = entry.path();
        if path.extension().and_then(|s| s.to_str()) != Some("json") {
            continue;
        }
        let file_name = match path.file_name().and_then(|s| s.to_str()) {
            Some(n) => n.to_string(),
            None => continue,
        };
        if !file_name.starts_with("result-") {
            continue;
        }

        let raw = match tokio::fs::read_to_string(&path).await {
            Ok(r) => r,
            Err(e) => {
                error!(path = %path.display(), error = %e, "读取 fallback 结果失败");
                continue;
            }
        };

        match serde_json::from_str::<JudgeResult>(&raw) {
            Ok(result) => {
                let json = match serde_json::to_string(&result) {
                    Ok(j) => j,
                    Err(e) => {
                        error!(error = %e, "重新序列化 fallback 结果失败");
                        continue;
                    }
                };
                match redis_client.get_multiplexed_async_connection().await {
                    Ok(mut conn) => match conn.lpush::<&str, &str, usize>(queue, &json).await {
                        Ok(_) => {
                            info!(
                                submission_id = %result.submission_id,
                                path = %path.display(),
                                "fallback 结果已重放",
                            );
                            if let Err(e) = tokio::fs::remove_file(&path).await {
                                error!(path = %path.display(), error = %e, "删除已重放 fallback 文件失败");
                            }
                        }
                        Err(e) => {
                            error!(submission_id = %result.submission_id, error = %e, "fallback 结果重放失败，保留文件");
                        }
                    },
                    Err(e) => {
                        error!(submission_id = %result.submission_id, error = %e, "fallback 重放连接 Redis 失败，保留文件");
                        break;
                    }
                }
            }
            Err(e) => {
                error!(
                    path = %path.display(),
                    error = %e,
                    raw = %truncate_for_log(&raw),
                    "fallback 文件反序列化失败，改名 .dead",
                );
                let dead = path.with_extension("json.dead");
                let _ = tokio::fs::rename(&path, &dead).await;
            }
        }
    }
}

fn sanitize_submission_id_for_filename(submission_id: &str) -> String {
    let sanitized: String = submission_id
        .chars()
        .map(|ch| match ch {
            'a'..='z' | 'A'..='Z' | '0'..='9' | '.' | '_' | '-' => ch,
            _ => '_',
        })
        .collect();

    if sanitized.is_empty() {
        "unknown".to_string()
    } else {
        sanitized
    }
}

#[cfg(test)]
mod tests {
    use super::parse_task_message;
    use super::sanitize_submission_id_for_filename;

    #[test]
    fn test_parse_task_message_invalid_json_returns_none() {
        assert!(parse_task_message("{invalid json").is_none());
    }

    #[test]
    fn test_parse_task_message_empty_string_returns_none() {
        assert!(parse_task_message("").is_none());
    }

    #[test]
    fn test_parse_task_message_empty_object_returns_none() {
        // 缺少必填字段的合法 JSON
        assert!(parse_task_message("{}").is_none());
    }

    #[test]
    fn test_parse_task_message_valid_json_returns_task() {
        let json = r#"{
            "submission_id":"sid-1",
            "problem_id":"1001",
            "runtime_config":{
                "evaluator":{"image":"noj-evaluator-python","command":"python3 /workspace/evaluate.py","time_limit_ms":5000,"memory_limit_mb":512},
                "solution":{"image":"noj-solution-python","call_timeout_ms":2000,"memory_limit_mb":512}
            },
            "language":"python3",
            "code":"print(1)"
        }"#;
        let task = parse_task_message(json).expect("应解析成功");
        assert_eq!(task.submission_id, "sid-1");
        assert_eq!(task.runtime_config.evaluator.image, "noj-evaluator-python");
    }

    #[test]
    fn test_sanitize_id_normal() {
        let id = "550e8400-e29b-41d4-a716-446655440000";
        assert_eq!(sanitize_submission_id_for_filename(id), id);
    }

    #[test]
    fn test_sanitize_id_special_chars_replaced() {
        let id = "abc/def:ghi";
        assert_eq!(sanitize_submission_id_for_filename(id), "abc_def_ghi");
    }

    #[test]
    fn test_sanitize_id_empty_returns_unknown() {
        assert_eq!(sanitize_submission_id_for_filename(""), "unknown");
    }

    #[test]
    fn test_sanitize_id_all_special_chars() {
        let id = "!@#$%^&*()";
        // 特殊字符被替换为 _，但结果非空
        assert_eq!(sanitize_submission_id_for_filename(id), "__________");
    }
}
