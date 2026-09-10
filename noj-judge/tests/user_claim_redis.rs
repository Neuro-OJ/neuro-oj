//! 跨 worker 每用户并发占用（分布式 claim）的集成测试。
//!
//! 需要真实 Redis：未设置 `REDIS_URL` 时跳过（与仓库既有 E2E 守卫一致）。
//!
//! 运行：
//! ```bash
//! REDIS_URL=redis://127.0.0.1:6379/9 cargo test --test user_claim_redis -- --nocapture
//! ```

use std::time::Duration;

use noj_judge::user_claim::{
    active_users_key, claim_member, count_active_claims, release_user, try_claim_user,
};

/// 连接 Redis（未配置 REDIS_URL 时返回 None → 跳过测试）。
async fn connect() -> Option<redis::aio::MultiplexedConnection> {
    let url = std::env::var("REDIS_URL").ok()?;
    redis::Client::open(url)
        .ok()?
        .get_multiplexed_async_connection()
        .await
        .ok()
}

/// 测试用命名空间（避免与真实部署/其他测试互相污染）。
fn test_prefix(tag: &str) -> String {
    format!("noj:test:user_claim:{tag}:{}", std::process::id())
}

/// 清理测试命名空间下的所有 key。
async fn cleanup(conn: &mut redis::aio::MultiplexedConnection, prefix: &str) {
    let pattern = format!("{prefix}:active_users:*");
    let keys: Vec<String> = redis::cmd("KEYS")
        .arg(&pattern)
        .query_async(conn)
        .await
        .unwrap_or_default();
    for key in keys {
        let _: Result<i64, _> = redis::cmd("DEL").arg(&key).query_async(conn).await;
    }
}

const TTL_MS: i64 = 60_000;

/// 同一用户的第二次占用必须失败（这正是跨 worker 公平性的核心保证：
/// 两个 worker 各自调用本函数时，只有一方能拿到 claim）。
#[tokio::test]
async fn second_claim_for_same_user_is_rejected() {
    let Some(mut conn) = connect().await else {
        eprintln!("跳过：未设置 REDIS_URL");
        return;
    };
    let prefix = test_prefix("same-user");
    cleanup(&mut conn, &prefix).await;

    let user = "user-A";
    // worker-1 占用
    let first = try_claim_user(
        &mut conn,
        &prefix,
        user,
        &claim_member("instance-1", "sub-1"),
        TTL_MS,
    )
    .await
    .expect("claim 应成功返回");
    assert!(first, "首次占用应成功");

    // worker-2（不同实例）尝试占用同一用户 → 必须被拒绝
    let second = try_claim_user(
        &mut conn,
        &prefix,
        user,
        &claim_member("instance-2", "sub-2"),
        TTL_MS,
    )
    .await
    .expect("claim 应成功返回");
    assert!(
        !second,
        "同一用户已有未过期 claim 时，另一 worker 的占用必须被拒绝（跨 worker 公平性）"
    );

    // 释放后应可再次占用
    release_user(
        &mut conn,
        &prefix,
        user,
        &claim_member("instance-1", "sub-1"),
    )
    .await;
    let third = try_claim_user(
        &mut conn,
        &prefix,
        user,
        &claim_member("instance-2", "sub-2"),
        TTL_MS,
    )
    .await
    .expect("claim 应成功返回");
    assert!(third, "释放后应可再次占用");

    cleanup(&mut conn, &prefix).await;
}

/// 不同用户互不影响（并发上限是「每用户」，不是全局单用户）。
#[tokio::test]
async fn different_users_do_not_block_each_other() {
    let Some(mut conn) = connect().await else {
        eprintln!("跳过：未设置 REDIS_URL");
        return;
    };
    let prefix = test_prefix("diff-users");
    cleanup(&mut conn, &prefix).await;

    let a = try_claim_user(
        &mut conn,
        &prefix,
        "user-A",
        &claim_member("i", "s1"),
        TTL_MS,
    )
    .await
    .unwrap();
    let b = try_claim_user(
        &mut conn,
        &prefix,
        "user-B",
        &claim_member("i", "s2"),
        TTL_MS,
    )
    .await
    .unwrap();
    assert!(a && b, "不同用户应可各自占用槽位");

    cleanup(&mut conn, &prefix).await;
}

/// 过期 claim 会被自动清理（worker 崩溃后的自愈）：
/// 用极短 TTL 占用一次，等待超过 TTL 后另一 worker 应能成功占用。
#[tokio::test]
async fn expired_claim_is_reclaimed() {
    let Some(mut conn) = connect().await else {
        eprintln!("跳过：未设置 REDIS_URL");
        return;
    };
    let prefix = test_prefix("expiry");
    cleanup(&mut conn, &prefix).await;

    let user = "user-crash";
    let short_ttl_ms: i64 = 300;

    let first = try_claim_user(
        &mut conn,
        &prefix,
        user,
        &claim_member("dead-worker", "s1"),
        short_ttl_ms,
    )
    .await
    .unwrap();
    assert!(first, "首次占用应成功");

    // 立即再占用 → 应被拒绝（claim 尚未过期）
    let immediate = try_claim_user(
        &mut conn,
        &prefix,
        user,
        &claim_member("other-worker", "s2"),
        short_ttl_ms,
    )
    .await
    .unwrap();
    assert!(!immediate, "未过期的 claim 应阻止占用");

    // 等待超过 TTL 后再占用 → 应成功（模拟崩溃 worker 的 claim 被回收）
    tokio::time::sleep(Duration::from_millis(500)).await;
    let after_expiry = try_claim_user(
        &mut conn,
        &prefix,
        user,
        &claim_member("other-worker", "s2"),
        short_ttl_ms,
    )
    .await
    .unwrap();
    assert!(
        after_expiry,
        "超过 TTL 的 claim 应被自动回收，允许其他 worker 占用（崩溃自愈）"
    );

    cleanup(&mut conn, &prefix).await;
}

/// 释放必须只删除**自己**的 claim，不能误删其他实例的 claim。
#[tokio::test]
async fn release_only_removes_own_claim() {
    let Some(mut conn) = connect().await else {
        eprintln!("跳过：未设置 REDIS_URL");
        return;
    };
    let prefix = test_prefix("release-own");
    cleanup(&mut conn, &prefix).await;

    let user = "user-X";
    try_claim_user(
        &mut conn,
        &prefix,
        user,
        &claim_member("instance-1", "s1"),
        TTL_MS,
    )
    .await
    .unwrap();

    // 用错误的 member 释放（模拟另一个实例误释放）→ 不应删除真实 claim
    release_user(&mut conn, &prefix, user, &claim_member("instance-2", "s9")).await;

    let count = count_active_claims(&mut conn, &prefix, user, TTL_MS)
        .await
        .unwrap();
    assert_eq!(count, 1, "误释放不应删除其他实例的 claim");

    // 用正确的 member 释放 → 应清空
    release_user(&mut conn, &prefix, user, &claim_member("instance-1", "s1")).await;
    let count_after = count_active_claims(&mut conn, &prefix, user, TTL_MS)
        .await
        .unwrap();
    assert_eq!(count_after, 0, "正确释放后应无剩余 claim");

    cleanup(&mut conn, &prefix).await;
}

/// **多 worker 竞争场景**：N 个并发 claim 同一用户，只能有 1 个成功。
///
/// 这是对「原实现按进程各存一份集合 → N 个 worker 可并发 N 个」缺陷的直接回归验证。
#[tokio::test]
async fn concurrent_claims_only_one_wins() {
    let Some(mut conn) = connect().await else {
        eprintln!("跳过：未设置 REDIS_URL");
        return;
    };
    let prefix = test_prefix("concurrent");
    cleanup(&mut conn, &prefix).await;

    let user = "user-contended";
    const WORKERS: usize = 8;

    let mut handles = Vec::with_capacity(WORKERS);
    for i in 0..WORKERS {
        let url = std::env::var("REDIS_URL").unwrap();
        let prefix = prefix.clone();
        handles.push(tokio::spawn(async move {
            // 每个「worker」用自己的连接，模拟真实多进程/多任务并发
            let mut conn = redis::Client::open(url)
                .unwrap()
                .get_multiplexed_async_connection()
                .await
                .unwrap();
            try_claim_user(
                &mut conn,
                &prefix,
                user,
                &claim_member(&format!("instance-{i}"), &format!("sub-{i}")),
                TTL_MS,
            )
            .await
            .unwrap()
        }));
    }

    let mut winners = 0;
    for handle in handles {
        if handle.await.unwrap() {
            winners += 1;
        }
    }

    assert_eq!(
        winners, 1,
        "{WORKERS} 个 worker 并发占用同一用户时，必须恰好 1 个成功（实测 {winners} 个）"
    );

    cleanup(&mut conn, &prefix).await;
}

/// key 命名包含前缀与用户，且与队列 key 不冲突（前缀派生正确）。
#[test]
fn claim_key_namespace_is_distinct_from_queue() {
    let key = active_users_key("noj:judge", "u-1");
    assert_eq!(key, "noj:judge:active_users:u-1");
    // 不得落在队列命名空间内（避免与队列 key 混淆）
    assert!(!key.starts_with("noj:judge:queue"));
}
