//! 活跃用户任务重投的**方向语义**回归（NOJ-A7）。
//!
//! 队列方向约定（全仓一致，勿凭直觉改）：
//! - 入队：core 用 `LPUSH`（`noj-core/src/domains/submission/mq/producer.ts`）
//! - 消费：judge 用 `RPOPLPUSH` / `BRPOPLPUSH` 从**右端**取（最旧一条）→ FIFO
//!
//! 因此"把任务放回队尾（本次先让给别的用户）"必须 `LPUSH` 回**左端**。
//! 原实现用 `RPUSH`——与消费端同端，重投的消息立刻又成为下一个弹出候选，
//! 加上每轮固定 `sleep(100ms)`，退化成"取回-比较-重投"的空转循环（每轮还新建
//! 一条 Redis 连接），公平调度的退避意图完全失效。
//!
//! 需要真实 Redis：未设置 `REDIS_URL` 时跳过（与 `user_claim_redis.rs` 同一守卫）。
//!
//! 运行：
//! ```bash
//! REDIS_URL=redis://127.0.0.1:6379/9 cargo test --test requeue_redis -- --nocapture
//! ```

use redis::AsyncCommands;

/// 连接 Redis 客户端。
///
/// 与 `user_claim_redis.rs` 同口径：只对"未配置 REDIS_URL"跳过；
/// 配置了却连不上必须 panic（否则 CI 基础设施故障会表现为绿色）。
async fn connect() -> Option<redis::Client> {
    let Some(url) = std::env::var("REDIS_URL").ok() else {
        eprintln!(
            "⚠ 跳过：未设置 REDIS_URL —— 本用例未执行任何断言。\
             如需运行：REDIS_URL=redis://127.0.0.1:6379/9 cargo test --test requeue_redis"
        );
        return None;
    };
    let client = redis::Client::open(url.as_str())
        .unwrap_or_else(|e| panic!("REDIS_URL 不是合法的 Redis URL（{url}）：{e}"));
    client
        .get_multiplexed_async_connection()
        .await
        .unwrap_or_else(|e| {
            panic!(
                "已设置 REDIS_URL={url} 但无法连接 Redis：{e}。\
                 本用例必须真实执行（不得记为 passed）；请检查 Redis 是否可用。"
            )
        });
    Some(client)
}

/// 重投后的任务必须回到**队头**（最后才会被服务），而不是被立刻重新消费。
///
/// 反向验证：把 `REQUEUE_SCRIPT` 的 `LPUSH` 改回 `RPUSH`，本用例立即失败
/// （首个断言 head 会得到 "old-2"）—— 那正是 NOJ-A7 的缺陷形态。
#[tokio::test]
async fn requeued_task_goes_to_the_back_of_the_line() {
    let Some(client) = connect().await else {
        return;
    };
    let mut conn = client
        .get_multiplexed_async_connection()
        .await
        .expect("获取连接应成功");

    let queue = format!("noj:test:requeue:{}:high", std::process::id());
    // `mq::processing_queue` 为私有，此处按同一约定构造（`{queue}:processing`）。
    let processing = format!("{queue}:processing");
    let _: Result<i64, _> = redis::cmd("DEL")
        .arg(&queue)
        .arg(&processing)
        .query_async(&mut conn)
        .await;

    // 队列（LPUSH 入队）：head→tail = [old-2, old-1]，最旧一条在最右端。
    let _: i64 = conn.lpush(&queue, "old-1").await.expect("入队应成功");
    let _: i64 = conn.lpush(&queue, "old-2").await.expect("入队应成功");

    // 模拟 judge 拉取：从右端取最旧一条。
    let pulled: String = conn
        .rpoplpush(&queue, &processing)
        .await
        .expect("拉取应成功");
    assert_eq!(pulled, "old-1", "前置条件：最先被消费的应是最旧一条");

    // 被测函数：把该任务放回队列（模拟"该用户已有评测在跑，让给其他用户"）。
    noj_judge::mq::requeue_task(&client, &queue, "old-1")
        .await
        .expect("重投应成功");

    let head: String = conn.lindex(&queue, 0).await.expect("读取应成功");
    let tail: String = conn.lindex(&queue, -1).await.expect("读取应成功");
    assert_eq!(
        head, "old-1",
        "重投的任务必须放回队头（LPUSH）：放右端会被立刻重新弹出，退避失效"
    );
    assert_eq!(tail, "old-2", "队尾应仍是原本最旧、下一个将被消费的任务");

    // 实质性质：下一个被消费的**不是**刚重投的那条。
    let next: String = conn
        .rpoplpush(&queue, &processing)
        .await
        .expect("拉取应成功");
    assert_eq!(
        next, "old-2",
        "重投的任务不得被立刻重新消费（否则每 100ms 一轮空转，且每轮新建 Redis 连接）"
    );

    let _: Result<i64, _> = redis::cmd("DEL")
        .arg(&queue)
        .arg(&processing)
        .query_async(&mut conn)
        .await;
}
