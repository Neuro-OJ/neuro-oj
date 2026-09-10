//! 跨 worker 的每用户评测并发占用（分布式 claim）。
//!
//! # 为什么需要 Redis 而不是进程内集合
//!
//! F-07 的公平调度要求「同一用户同时最多 1 个评测」。原实现用进程内的
//! `Arc<Mutex<HashSet<String>>>` 记录活跃用户，**只在单 worker 下成立**：
//! 部署 N 个 worker 时每个进程各有一份集合，同一用户最多可同时跑 N 个评测，
//! 公平性限制被静默放大 N 倍（并发刷分/抢占评测资源的窗口随之放大）。
//!
//! 本模块把「用户占用」提升为 **Redis 上的全局状态**，所有 worker 共享同一判定。
//!
//! # 数据结构与原子性
//!
//! 每个用户一个有序集合 `{prefix}:active_users:{user_id}`：
//! - member = `{instance_id}:{submission_id}`（可精确定位与释放）
//! - score  = 占用时刻（毫秒时间戳，用于过期清理）
//!
//! 「清理过期 + 判定 + 占用」在**单条 Lua 脚本**内完成，避免
//! `ZCARD` 与 `ZADD` 之间的竞态窗口（与该仓库既有的
//! `producer.ts` 背压 Lua 脚本同一思路）。
//!
//! # 崩溃与泄漏
//!
//! worker 崩溃时其 claim 会留在集合里。因此**每个 claim 自带时间戳**，
//! 任何 worker 在下次占用该用户时会先清理超过 `ttl` 的旧 claim ——
//! 过期的判定是「这条 claim 有多旧」，而不是「整个 key 何时过期」，
//! 因此不会因为一个用户的 key 存在就永久阻塞该用户。
//!
//! `ttl` 必须 **大于单次评测的最长可能耗时**（否则长评测会被误判为过期，
//! 破坏互斥）；默认 3600s，远大于 evaluator 的硬上限（默认 300s）。

use std::time::{SystemTime, UNIX_EPOCH};

use anyhow::{Context, Result};
use redis::AsyncCommands;
use tracing::warn;

/// 用户占用 key 的命名空间后缀（最终 key 为 `{prefix}:active_users:{user_id}`）。
pub const ACTIVE_USERS_SUFFIX: &str = "active_users";

/// 生成某用户的占用 key。
pub fn active_users_key(prefix: &str, user_id: &str) -> String {
    format!("{prefix}:{ACTIVE_USERS_SUFFIX}:{user_id}")
}

/// 构造 claim 成员标识（实例 + 提交，便于精确定位与人工排查）。
pub fn claim_member(instance_id: &str, submission_id: &str) -> String {
    format!("{instance_id}:{submission_id}")
}

/// 当前 Unix 毫秒时间戳（用于 score）。系统时间异常时回退 0。
fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// 尝试占用某用户的评测槽位。
///
/// 单条 Lua 脚本内原子完成：清理过期 claim → 若集合为空则写入本次 claim。
/// 返回 `true` 表示占用成功（调用方应对该用户的任务继续评测）；
/// `false` 表示该用户已有**未过期**的评测在跑（调用方应释放槽位并把任务放回队尾）。
///
/// @param ttl_ms 过期阈值（毫秒）。必须大于单次评测的最长可能耗时。
pub async fn try_claim_user(
    conn: &mut redis::aio::MultiplexedConnection,
    prefix: &str,
    user_id: &str,
    member: &str,
    ttl_ms: i64,
) -> Result<bool> {
    let key = active_users_key(prefix, user_id);
    let now = now_ms();

    // KEYS[1]=key ARGV[1]=now_ms ARGV[2]=ttl_ms ARGV[3]=member ARGV[4]=expire_ms
    //
    // 1) 清理过期 claim（score < now - ttl）
    // 2) 集合仍非空 → 该用户有活跃评测，返回 0
    // 3) 否则写入 claim，并给 key 一个宽限 TTL（即使 release 丢失也会自然回收）
    const SCRIPT: &str = r"
        redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', ARGV[1])
        if redis.call('ZCARD', KEYS[1]) > 0 then
            return 0
        end
        redis.call('ZADD', KEYS[1], ARGV[2], ARGV[3])
        redis.call('PEXPIRE', KEYS[1], ARGV[4])
        return 1
    ";

    let cutoff = now - ttl_ms;
    // key 级兜底过期：给 claim TTL 留 2 倍余量后再过期整个 key。
    let expire_ms = ttl_ms.saturating_mul(2).max(60_000);
    let member_value = now.to_string();

    let claimed: i64 = redis::Script::new(SCRIPT)
        .key(&key)
        .arg(cutoff)
        .arg(&member_value)
        .arg(member)
        .arg(expire_ms)
        .invoke_async(conn)
        .await
        .with_context(|| format!("占用用户槽位失败（user_id={user_id}）"))?;

    Ok(claimed == 1)
}

/// 释放某用户的评测槽位（任务结束/失败/panic 路径都应调用）。
///
/// 释放失败**不抛出**：claim 自带 TTL，最坏情况会在 ttl 后被自动清理，
/// 不应因为清理失败而影响任务结果的投递。
pub async fn release_user(
    conn: &mut redis::aio::MultiplexedConnection,
    prefix: &str,
    user_id: &str,
    member: &str,
) {
    let key = active_users_key(prefix, user_id);
    let result: Result<i64, _> = conn.zrem(&key, member).await;
    match result {
        Ok(0) => {
            // 未删除任何成员：claim 已过期被清理，或 member 不匹配。
            warn!(user_id = %user_id, member = %member, "释放用户槽位时未找到对应 claim（可能已过期）");
        }
        Ok(_) => {}
        Err(e) => {
            warn!(user_id = %user_id, error = %e, "释放用户槽位失败（将由 TTL 兜底）");
        }
    }
}

/// 查询某用户当前**未过期**的 claim 数量（用于诊断与测试）。
pub async fn count_active_claims(
    conn: &mut redis::aio::MultiplexedConnection,
    prefix: &str,
    user_id: &str,
    ttl_ms: i64,
) -> Result<i64> {
    let key = active_users_key(prefix, user_id);
    let cutoff = now_ms() - ttl_ms;
    let _: () = conn.zrembyscore(&key, "-inf", cutoff).await.unwrap_or(());
    let count: i64 = conn.zcard(&key).await.context("查询活跃 claim 数失败")?;
    Ok(count)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn active_users_key_uses_prefix_and_user() {
        assert_eq!(
            active_users_key("noj:judge", "u-1"),
            "noj:judge:active_users:u-1"
        );
    }

    #[test]
    fn claim_member_contains_instance_and_submission() {
        let member = claim_member("instance-a", "sub-1");
        assert_eq!(member, "instance-a:sub-1");
        // 不同实例的同一提交必须产生不同 member，避免互相误删。
        assert_ne!(member, claim_member("instance-b", "sub-1"));
    }

    #[test]
    fn now_ms_is_positive() {
        // 仅断言可用性；不断言具体时间（避免脆弱测试）。
        assert!(now_ms() > 0);
    }
}
