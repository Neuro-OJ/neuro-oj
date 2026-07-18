use anyhow::{Context, Result};
use redis::AsyncCommands;
use tracing::{error, info, warn};

use crate::types::{JudgeResult, JudgeTask};

pub mod rpc;

/// 从 Redis 队列中拉取评测任务。
///
/// 使用 BRPOP 阻塞等待，超时 5 秒后返回 None。
/// 返回的任务是队列中最老的（FIFO 顺序）。
pub async fn pull_task(
    conn: &mut redis::aio::MultiplexedConnection,
    queue: &str,
) -> Result<Option<JudgeTask>> {
    // BRPOP 返回 (key, value) tuple，超时单位是秒
    let result: Option<(String, String)> =
        conn.brpop(queue, 5.0).await.context("BRPOP 拉取任务失败")?;

    match result {
        Some((_key, value)) => Ok(parse_task_message(&value)),
        None => {
            // 超时返回，继续下一轮循环
            Ok(None)
        }
    }
}

fn parse_task_message(value: &str) -> Option<JudgeTask> {
    match serde_json::from_str::<JudgeTask>(value) {
        Ok(task) => Some(task),
        Err(e) => {
            error!(error = %e, "反序列化 JudgeTask 失败，跳过该消息");
            None
        }
    }
}

/// 发布“开始评测”事件。
///
/// 该事件仅用于 noj-core 更新 `judge_started_at`，失败不影响评测主流程。
#[allow(dead_code)]
pub async fn push_started_event(redis_client: &redis::Client, submission_id: &str) {
    let payload = serde_json::json!({ "submission_id": submission_id });
    let json = match serde_json::to_string(&payload) {
        Ok(value) => value,
        Err(e) => {
            warn!(submission_id, error = %e, "序列化 started 事件失败");
            return;
        }
    };

    match redis_client.get_multiplexed_async_connection().await {
        Ok(mut conn) => {
            let push_result: std::result::Result<usize, redis::RedisError> =
                conn.lpush("noj:judge:started", json).await;
            if let Err(e) = push_result {
                warn!(submission_id, error = %e, "推送 started 事件失败");
            }
        }
        Err(e) => {
            warn!(submission_id, error = %e, "创建 started 事件 Redis 连接失败");
        }
    }
}

#[allow(dead_code)]
/// 将尚未开始执行的任务重新放回队列尾部，保持 FIFO 顺序。
pub async fn requeue_task(
    redis_client: &redis::Client,
    queue: &str,
    task: &JudgeTask,
) -> Result<()> {
    let json = serde_json::to_string(task).context("序列化 JudgeTask 失败")?;
    let mut conn = redis_client
        .get_multiplexed_async_connection()
        .await
        .context("创建 requeue Redis 连接失败")?;
    conn.rpush::<&str, &str, usize>(queue, &json)
        .await
        .context("RPUSH 回队失败")?;
    Ok(())
}

/// 带重试的结果推送。
///
/// 最多重试 3 次，间隔指数退避（1s, 2s, 4s）。
/// 所有重试均失败后，将结果序列化到 `fallback_dir` 下的文件，
/// 供运维恢复使用。
pub async fn push_result_with_retry(
    redis_client: &redis::Client,
    queue: &str,
    result: &JudgeResult,
    fallback_dir: &std::path::Path,
) {
    let submission_id = &result.submission_id;
    let json = match serde_json::to_string(result) {
        Ok(j) => j,
        Err(e) => {
            error!(submission_id, error = %e, "序列化评测结果失败，无法推送");
            return;
        }
    };

    // 3 次指数退避重试
    let mut last_error = String::new();
    for attempt in 1..=3 {
        match redis_client.get_multiplexed_async_connection().await {
            Ok(mut conn) => {
                let push_result: std::result::Result<usize, redis::RedisError> =
                    conn.lpush::<&str, &str, usize>(queue, &json).await;
                match push_result {
                    Ok(_) => {
                        info!(submission_id, attempt, "评测结果已发布",);
                        return;
                    }
                    Err(e) => {
                        last_error = e.to_string();
                        warn!(
                            submission_id,
                            attempt,
                            error = %e,
                            "LPUSH 失败（第 {}/3 次）",
                            attempt,
                        );
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
            let delay = std::time::Duration::from_secs(1 << (attempt - 1)); // 1s, 2s, 4s
            tokio::time::sleep(delay).await;
        }
    }

    // 所有重试均失败，序列化到本地文件系统
    error!(
        submission_id,
        error = last_error,
        "评测结果推送失败（已重试 3 次），序列化到本地: {}",
        submission_id,
    );

    // 确保 fallback 目录存在
    if let Err(e) = tokio::fs::create_dir_all(fallback_dir).await {
        error!(
            submission_id,
            error = %e,
            "创建 fallback 目录失败",
        );
        return;
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
        }
        Err(e) => {
            error!(
                submission_id,
                error = %e,
                path = %fallback_path.display(),
                "写入 fallback 文件失败",
            );
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

    #[test]
    fn test_parse_task_message_invalid_json_returns_none() {
        assert!(parse_task_message("{invalid json").is_none());
    }

    #[test]
    fn test_parse_task_message_valid_json_returns_task() {
        let json = r#"{
            "submission_id":"sid-1",
            "problem_id":"1001",
            "judge_image":"noj-judge-python",
            "judge_command":"python3 /tmp/evaluate.py",
            "language":"python3",
            "code":"print(1)",
            "time_limit_ms":1000,
            "memory_limit_mb":64
        }"#;
        let task = parse_task_message(json).expect("应解析成功");
        assert_eq!(task.submission_id, "sid-1");
        assert_eq!(task.judge_image, "noj-judge-python");
    }
}
