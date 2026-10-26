use anyhow::{Context, Result};

use crate::types::{result_kind_for_status, JudgeResult, JudgeTask};

const MAX_PLATFORM_ERROR_RETRIES: u32 = 3;
// 计数保留七天，覆盖 Worker 重启、sweeper 恢复和重复投递；不同 run 独立计数。
const RETRY_TTL_SECS: u64 = 7 * 24 * 60 * 60;

// 移走 processing 消息、扣减重试额度和重新入队必须原子执行。
// LPUSH 让重试排在其他待评测任务之后，释放当前用户 claim 与资源租约。
const RETRY_SCRIPT: &str = r#"
if not redis.call('LPOS', KEYS[1], ARGV[1]) then
    return -1
end
local retries = tonumber(redis.call('GET', KEYS[3]) or '0')
if retries >= tonumber(ARGV[2]) then
    return 0
end
redis.call('LREM', KEYS[1], 0, ARGV[1])
retries = redis.call('INCR', KEYS[3])
redis.call('EXPIRE', KEYS[3], ARGV[3])
redis.call('LPUSH', KEYS[2], ARGV[1])
return retries
"#;

#[derive(Debug, PartialEq, Eq)]
pub enum RetryOutcome {
    /// 正式判定、主动取消或重试耗尽，交给现有最终结果写回路径。
    Final,
    Requeued(u32),
    /// 原消息已被其他 Worker 或 sweeper 移走，本次不重复推送结果。
    AlreadyMoved,
}

fn is_retryable(result: &JudgeResult) -> bool {
    result.status != "cancelled"
        && result
            .result_kind
            .as_deref()
            .unwrap_or_else(|| result_kind_for_status(&result.status))
            == "platform_error"
}

/// 平台评测错误最多额外重试三次；原消息与版本/尝试/token 封套保持一致。
///
/// Redis 保存每个 run 的计数，跨 Worker、进程重启与重复投递共享上限。
/// 返回错误时必须保留 processing 等待恢复，不能提前写回失败终态。
pub async fn retry_platform_error(
    client: &redis::Client,
    queue: &str,
    raw: &str,
    task: &JudgeTask,
    result: &JudgeResult,
) -> Result<RetryOutcome> {
    if !is_retryable(result) {
        return Ok(RetryOutcome::Final);
    }
    let key = format!(
        "{queue}:platform-retries:{}:{}:{}",
        task.submission_id,
        task.run_id.as_deref().unwrap_or("legacy"),
        task.rejudge_seq.unwrap_or(0),
    );
    let mut conn = client
        .get_multiplexed_async_connection()
        .await
        .context("平台错误重试连接 Redis 失败")?;
    let retry: i64 = redis::Script::new(RETRY_SCRIPT)
        .key(format!("{queue}:processing"))
        .key(queue)
        .key(key)
        .arg(raw)
        .arg(MAX_PLATFORM_ERROR_RETRIES)
        .arg(RETRY_TTL_SECS)
        .invoke_async(&mut conn)
        .await
        .context("平台错误原子重投失败")?;
    Ok(match retry {
        -1 => RetryOutcome::AlreadyMoved,
        0 => RetryOutcome::Final,
        retry => RetryOutcome::Requeued(retry as u32),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_platform_errors_are_retried() {
        for status in [
            "finished",
            "WA",
            "CE",
            "TLE",
            "MLE",
            "RE",
            "TimeLimitExceeded",
        ] {
            let mut result = JudgeResult::error("sid", Some(1));
            result.status = status.into();
            result.result_kind = None;
            assert!(!is_retryable(&result), "正式判定 {status} 不应重试");
        }
        for status in ["error", "SystemError", "SE", "FE"] {
            let mut result = JudgeResult::error("sid", Some(1));
            result.status = status.into();
            result.result_kind = None;
            assert!(is_retryable(&result), "平台错误 {status} 应重试");
        }
        let mut result = JudgeResult::error("sid", Some(1));
        result.result_kind = Some("graded".into());
        assert!(!is_retryable(&result), "显式正式零分不能误重试");
        result.status = "finished".into();
        result.result_kind = Some("platform_error".into());
        assert!(is_retryable(&result), "显式平台错误优先于状态推导");
        result.status = "cancelled".into();
        assert!(!is_retryable(&result), "主动取消不能重试");
    }

    #[tokio::test]
    async fn redis_failure_preserves_error_for_recovery() {
        let client = redis::Client::open("redis://127.0.0.1:1/").unwrap();
        let task: JudgeTask = serde_json::from_str(include_str!(
            "../../../noj-tests/fixtures/judge-task.contract.json"
        ))
        .unwrap();
        let result = JudgeResult::error(&task.submission_id, task.rejudge_seq);
        assert!(retry_platform_error(&client, "test", "raw", &task, &result)
            .await
            .is_err());
    }
}
