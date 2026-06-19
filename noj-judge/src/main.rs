/// Neuro OJ 评测 Worker
///
/// 从 Redis 消息队列中拉取评测任务，在 Docker 容器中执行评测，
/// 并将结果返回给 noj-core。

#[tokio::main]
async fn main() -> redis::RedisResult<()> {
    let redis_url =
        std::env::var("REDIS_URL").unwrap_or_else(|_| "redis://127.0.0.1/".to_string());
    let client = redis::Client::open(redis_url)?;
    let mut conn = client.get_multiplexed_async_connection().await?;

    println!("noj-judge worker started, waiting for tasks...");

    // 验证 Redis 连接
    redis::cmd("PING").query_async::<String>(&mut conn).await?;
    println!("Redis connection established");

    // TODO: 从 Redis MQ (BLPOP / BRPOP) 拉取评测任务
    // TODO: 在 Docker 容器中执行评测代码
    // TODO: 将评测结果发布回 Redis (LPUSH)

    Ok(())
}
