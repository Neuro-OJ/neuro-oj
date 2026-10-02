//! go-judge 专用节点的跨 worker 资源租约。
//!
//! 每个远端 OI 子任务占用一个 Redis 有序集合槽位。租约的过期时间由 Redis
//! `TIME` 决定，worker 崩溃时不会永久占用资源；释放使用同一个 member，避免
//! 误删其他 worker 的租约。这个模块不保存进程级计数器，所有并发状态都在 Redis。

use std::time::Duration;

use anyhow::{Context, Result};
use uuid::Uuid;

const DEFAULT_CAPACITY: i64 = 2;
const DEFAULT_TTL_MS: i64 = 360_000;
const DEFAULT_WAIT_MS: u64 = 300_000;
const POLL_INTERVAL: Duration = Duration::from_millis(100);

/// 远端 go-judge 节点的共享资源配置。
#[derive(Clone)]
pub struct ResourceLeaseConfig {
    pub client: redis::Client,
    pub key: String,
    pub capacity: i64,
    pub ttl_ms: i64,
    pub wait_ms: u64,
}

impl ResourceLeaseConfig {
    /// 从 worker 环境构造配置。`REDIS_URL` 已由主循环校验过，这里仍重新解析，
    /// 使 OI 执行器可以作为库被单独调用。容量以远端节点的并发测试点数表示。
    pub fn from_client(client: redis::Client) -> Result<Self> {
        let capacity = parse_positive_i64("JUDGE_GO_JUDGE_RESOURCE_CAPACITY", DEFAULT_CAPACITY)?;
        let ttl_ms = parse_positive_i64("JUDGE_GO_JUDGE_RESOURCE_TTL_MS", DEFAULT_TTL_MS)?;
        let wait_ms = parse_positive_u64("JUDGE_GO_JUDGE_RESOURCE_WAIT_MS", DEFAULT_WAIT_MS)?;
        let prefix = std::env::var("JUDGE_GO_JUDGE_RESOURCE_KEY")
            .ok()
            .filter(|value| !value.trim().is_empty())
            .unwrap_or_else(|| "noj:judge:oi:go-judge".to_string());
        if !is_safe_key(&prefix) {
            anyhow::bail!("JUDGE_GO_JUDGE_RESOURCE_KEY 含非法 Redis key 字符");
        }
        Ok(Self {
            client,
            key: prefix,
            capacity,
            ttl_ms,
            wait_ms,
        })
    }
}

fn parse_positive_i64(name: &str, default: i64) -> Result<i64> {
    let value = std::env::var(name)
        .ok()
        .filter(|raw| !raw.trim().is_empty())
        .map(|raw| {
            raw.parse::<i64>()
                .with_context(|| format!("{name} 必须是正整数"))
        })
        .transpose()?
        .unwrap_or(default);
    if value <= 0 {
        anyhow::bail!("{name} 必须是正整数");
    }
    Ok(value)
}

fn parse_positive_u64(name: &str, default: u64) -> Result<u64> {
    let value = std::env::var(name)
        .ok()
        .filter(|raw| !raw.trim().is_empty())
        .map(|raw| {
            raw.parse::<u64>()
                .with_context(|| format!("{name} 必须是正整数"))
        })
        .transpose()?
        .unwrap_or(default);
    if value == 0 {
        anyhow::bail!("{name} 必须是正整数");
    }
    Ok(value)
}

fn is_safe_key(value: &str) -> bool {
    value.len() <= 128
        && !value
            .chars()
            .any(|ch| matches!(ch, ' ' | '\n' | '\r' | '\0'))
        && !value.is_empty()
}

/// 一个已占用的租约。显式 `release` 是正常路径；如果 worker 被强制终止，
/// Redis 中的 score 会自然过期。
pub struct ResourceLease {
    conn: redis::aio::MultiplexedConnection,
    key: String,
    member: String,
}

impl ResourceLease {
    /// 等待并原子占用一个远端节点槽位。
    pub async fn acquire(config: &ResourceLeaseConfig, owner: &str) -> Result<Self> {
        let deadline = tokio::time::Instant::now() + Duration::from_millis(config.wait_ms);
        let member = format!("{}:{}", owner, Uuid::new_v4());
        let mut conn = config
            .client
            .get_multiplexed_async_connection()
            .await
            .context("创建 go-judge 资源租约 Redis 连接失败")?;
        loop {
            if try_acquire(
                &mut conn,
                &config.key,
                &member,
                config.capacity,
                config.ttl_ms,
            )
            .await?
            {
                return Ok(Self {
                    conn,
                    key: config.key.clone(),
                    member,
                });
            }
            if tokio::time::Instant::now() >= deadline {
                anyhow::bail!("等待 go-judge 资源租约超时");
            }
            tokio::time::sleep(POLL_INTERVAL).await;
        }
    }

    /// 释放本次租约；失败时只记录告警，TTL 仍会回收它。
    pub async fn release(mut self) {
        let result: redis::RedisResult<i64> = redis::cmd("ZREM")
            .arg(&self.key)
            .arg(&self.member)
            .query_async(&mut self.conn)
            .await;
        if let Err(error) = result {
            tracing::warn!(error = %error, "释放 go-judge 资源租约失败（将由 TTL 兜底）");
        }
    }
}

async fn try_acquire(
    conn: &mut redis::aio::MultiplexedConnection,
    key: &str,
    member: &str,
    capacity: i64,
    ttl_ms: i64,
) -> Result<bool> {
    // 有序集合 score 是服务端时间计算出的过期时刻。脚本内先清理过期槽位，
    // 再检查容量并写入，避免多个 worker 同时观察到相同的空位。
    const SCRIPT: &str = r#"
        local t = redis.call('TIME')
        local now = t[1] * 1000 + math.floor(t[2] / 1000)
        redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', now)
        if redis.call('ZCARD', KEYS[1]) >= tonumber(ARGV[1]) then
            return 0
        end
        redis.call('ZADD', KEYS[1], now + tonumber(ARGV[2]), ARGV[3])
        redis.call('PEXPIRE', KEYS[1], math.max(tonumber(ARGV[2]) * 2, 60000))
        return 1
    "#;
    let acquired: i64 = redis::Script::new(SCRIPT)
        .key(key)
        .arg(capacity)
        .arg(ttl_ms)
        .arg(member)
        .invoke_async(conn)
        .await
        .context("占用 go-judge 资源租约失败")?;
    Ok(acquired == 1)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_capacity_and_safe_key_are_stable() {
        assert_eq!(DEFAULT_CAPACITY, 2);
        assert!(is_safe_key("noj:judge:oi:go-judge"));
        assert!(!is_safe_key("bad key"));
    }
}
