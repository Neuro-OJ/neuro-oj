//! 平台错误重试的 Redis 原子性与跨 Worker 上限回归。
//! CI 的 judge-test 提供 REDIS_URL；本地未配置时明确跳过。
use noj_judge::judge::retry::{retry_platform_error, RetryOutcome};
use noj_judge::types::{JudgeResult, JudgeTask};
use redis::AsyncCommands;

async fn setup() -> Option<(
    redis::Client,
    redis::aio::MultiplexedConnection,
    String,
    JudgeTask,
    String,
)> {
    let Ok(url) = std::env::var("REDIS_URL") else {
        eprintln!("跳过：未设置 REDIS_URL，平台错误重试 Redis 断言未执行");
        return None;
    };
    let client = redis::Client::open(url).expect("REDIS_URL 必须合法");
    let conn = client
        .get_multiplexed_async_connection()
        .await
        .expect("配置 Redis 后必须可连接");
    let queue = format!("noj:test:platform-retry:{}", uuid::Uuid::new_v4());
    let task: JudgeTask = serde_json::from_str(include_str!(
        "../../noj-tests/fixtures/judge-task.contract.json"
    ))
    .unwrap();
    let raw = serde_json::to_string(&task).unwrap();
    Some((client, conn, queue, task, raw))
}

async fn cleanup(conn: &mut redis::aio::MultiplexedConnection, queue: &str) {
    let keys: Vec<String> = conn.keys(format!("{queue}*")).await.unwrap();
    if !keys.is_empty() {
        let _: usize = conn.del(keys).await.unwrap();
    }
}

#[tokio::test]
async fn three_retries_preserve_original_task_and_survive_new_connections() {
    let Some((client, mut conn, queue, task, raw)) = setup().await else {
        return;
    };
    let processing = format!("{queue}:processing");
    let result = JudgeResult::error(&task.submission_id, task.rejudge_seq);
    let _: usize = conn.lpush(&processing, &raw).await.unwrap();
    for retry in 1..=3 {
        // 新客户端模拟不同 Worker 或进程重启，不依赖进程内计数。
        let worker = redis::Client::open(client.get_connection_info().clone()).unwrap();
        assert_eq!(
            retry_platform_error(&worker, &queue, &raw, &task, &result)
                .await
                .unwrap(),
            RetryOutcome::Requeued(retry)
        );
        let len: usize = conn.llen(&processing).await.unwrap();
        assert_eq!(len, 0);
        let moved: String = conn.rpoplpush(&queue, &processing).await.unwrap();
        assert_eq!(moved, raw, "版本、attempt、run、token 与源码必须原样保留");
    }
    assert_eq!(
        retry_platform_error(&client, &queue, &raw, &task, &result)
            .await
            .unwrap(),
        RetryOutcome::Final
    );
    let len: usize = conn.llen(&queue).await.unwrap();
    assert_eq!(len, 0, "第四次失败不能继续重试");
    let len: usize = conn.llen(&processing).await.unwrap();
    assert_eq!(len, 1, "耗尽后原消息留待最终结果推送成功再确认");

    // 管理员新建的重测有独立 run，不受上一轮额度影响。
    let mut new_task = task.clone();
    new_task.run_id = Some(uuid::Uuid::new_v4().to_string());
    new_task.attempt_id = new_task.run_id.clone();
    let new_raw = serde_json::to_string(&new_task).unwrap();
    let _: usize = conn.lpush(&processing, &new_raw).await.unwrap();
    assert_eq!(
        retry_platform_error(&client, &queue, &new_raw, &new_task, &result)
            .await
            .unwrap(),
        RetryOutcome::Requeued(1)
    );
    cleanup(&mut conn, &queue).await;
}

#[tokio::test]
async fn concurrent_duplicate_errors_only_enqueue_once() {
    let Some((client, mut conn, queue, task, raw)) = setup().await else {
        return;
    };
    let processing = format!("{queue}:processing");
    // sweeper 重投后的重复 processing 副本也必须合并。
    let _: usize = conn.lpush(&processing, &[&raw, &raw]).await.unwrap();
    let result = JudgeResult::error(&task.submission_id, task.rejudge_seq);
    let (first, second) = tokio::join!(
        retry_platform_error(&client, &queue, &raw, &task, &result),
        retry_platform_error(&client, &queue, &raw, &task, &result),
    );
    let outcomes = [first.unwrap(), second.unwrap()];
    assert!(outcomes.contains(&RetryOutcome::Requeued(1)));
    assert!(outcomes.contains(&RetryOutcome::AlreadyMoved));
    let queued: Vec<String> = conn.lrange(&queue, 0, -1).await.unwrap();
    assert_eq!(queued, vec![raw]);
    let remaining: usize = conn.llen(&processing).await.unwrap();
    assert_eq!(remaining, 0);
    cleanup(&mut conn, &queue).await;
}

#[tokio::test]
async fn successful_zero_score_and_cancellation_do_not_requeue() {
    let Some((client, mut conn, queue, task, raw)) = setup().await else {
        return;
    };
    let processing = format!("{queue}:processing");
    let _: usize = conn.lpush(&processing, &raw).await.unwrap();
    let mut result = JudgeResult::error(&task.submission_id, task.rejudge_seq);
    result.result_kind = Some("graded".into());
    result.status = "finished".into();
    assert_eq!(
        retry_platform_error(&client, &queue, &raw, &task, &result)
            .await
            .unwrap(),
        RetryOutcome::Final
    );
    result.status = "cancelled".into();
    result.result_kind = Some("platform_error".into());
    assert_eq!(
        retry_platform_error(&client, &queue, &raw, &task, &result)
            .await
            .unwrap(),
        RetryOutcome::Final
    );
    let keys: Vec<String> = conn
        .keys(format!("{queue}:platform-retries:*"))
        .await
        .unwrap();
    assert!(keys.is_empty());
    let queued: usize = conn.llen(&queue).await.unwrap();
    assert_eq!(queued, 0);
    cleanup(&mut conn, &queue).await;
}

#[tokio::test]
async fn retry_yields_to_waiting_tasks_and_stops_after_success() {
    let Some((client, mut conn, queue, task, raw)) = setup().await else {
        return;
    };
    let processing = format!("{queue}:processing");
    let _: usize = conn.lpush(&processing, &raw).await.unwrap();
    let _: usize = conn.lpush(&queue, "other-task").await.unwrap();
    let mut result = JudgeResult::error(&task.submission_id, task.rejudge_seq);
    assert_eq!(
        retry_platform_error(&client, &queue, &raw, &task, &result)
            .await
            .unwrap(),
        RetryOutcome::Requeued(1)
    );
    let next: String = conn.rpop(&queue, None).await.unwrap();
    assert_eq!(next, "other-task", "重试必须让已排队任务先执行");
    let retry_raw: String = conn.rpoplpush(&queue, &processing).await.unwrap();
    assert_eq!(retry_raw, raw);
    result.status = "finished".into();
    result.result_kind = Some("graded".into());
    result.score = 8000;
    assert_eq!(
        retry_platform_error(&client, &queue, &raw, &task, &result)
            .await
            .unwrap(),
        RetryOutcome::Final
    );
    let queued: usize = conn.llen(&queue).await.unwrap();
    assert_eq!(queued, 0, "恢复成功后不再重试");
    let keys: Vec<String> = conn
        .keys(format!("{queue}:platform-retries:*"))
        .await
        .unwrap();
    assert_eq!(keys.len(), 1);
    let count: u32 = conn.get(&keys[0]).await.unwrap();
    assert_eq!(count, 1, "成功不消耗剩余重试额度");
    let ttl: i64 = conn.ttl(&keys[0]).await.unwrap();
    assert!(ttl > 0 && ttl <= 7 * 24 * 60 * 60, "计数必须有界保留");
    cleanup(&mut conn, &queue).await;
}
