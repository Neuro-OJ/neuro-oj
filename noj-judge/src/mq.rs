use anyhow::{Context, Result};
use redis::AsyncCommands;

use crate::types::{JudgeResult, JudgeTask};

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
        Some((_key, value)) => {
            let task: JudgeTask =
                serde_json::from_str(&value).context("反序列化 JudgeTask 失败")?;
            Ok(Some(task))
        }
        None => {
            // 超时返回，继续下一轮循环
            Ok(None)
        }
    }
}

/// 将评测结果推送到 Redis 结果列表。
///
/// 使用 LPUSH 将结果 JSON 添加到结果列表头部。
/// noj-core 通过 BRPOP 从同一列表消费。
pub async fn push_result(
    conn: &mut redis::aio::MultiplexedConnection,
    queue: &str,
    result: &JudgeResult,
) -> Result<()> {
    let json = serde_json::to_string(result).context("序列化 JudgeResult 失败")?;
    conn.lpush::<&str, String, usize>(queue, json)
        .await
        .context("LPUSH 评测结果失败")?;
    Ok(())
}
