/// Neuro OJ 评测 Worker
///
/// 从 Redis 消息队列中拉取评测任务，在 Docker 容器中执行评测，
/// 并将结果返回给 noj-core。
///
/// # 工作流程
///
/// 1. 连接 Redis（PING 验证）和 Docker daemon（PING 验证）
/// 2. BRPOP 阻塞拉取 noj:judge:queue 的任务
/// 3. 通过 Semaphore 控制并发数，spawn tokio task 处理
/// 4. 每个 task：解压支持包 → 写入用户代码 → Docker 执行 → 解析结果 → LPUSH 返回
mod config;
mod judge;
mod mq;
mod pool;
mod sandbox;
mod types;

use std::sync::Arc;

use anyhow::{Context, Result};
use bollard::Docker;
use tokio::sync::Semaphore;
use tracing::{error, info};

use crate::config::Config;

#[tokio::main]
async fn main() -> Result<()> {
    tracing_subscriber::fmt::init();

    let config = Config::from_env();

    info!(
        "noj-judge 启动 (queue={}, result_queue={})",
        config.judge_queue, config.result_queue
    );

    // 连接 Redis
    let redis_client =
        redis::Client::open(config.redis_url.as_str()).context("创建 Redis 客户端失败")?;
    let mut redis_conn = redis_client
        .get_multiplexed_async_connection()
        .await
        .context("连接 Redis 失败")?;
    redis::cmd("PING")
        .query_async::<String>(&mut redis_conn)
        .await
        .context("Redis PING 失败")?;
    info!("Redis 连接成功");

    // 连接 Docker
    let docker = Docker::connect_with_local_defaults()
        .context("连接 Docker daemon 失败（请确保 Docker 在运行中）")?;
    docker
        .ping()
        .await
        .context("Docker daemon PING 失败（请确保 Docker 在运行中）")?;
    info!("Docker 连接成功");

    // 并发控制
    let semaphore = Arc::new(Semaphore::new(config.max_concurrent()));
    let redis_url = config.redis_url.clone();
    let result_queue = config.result_queue.clone();
    let work_dir = config.work_dir.clone();

    info!("等待评测任务...");

    // 主循环
    loop {
        let task = match mq::pull_task(&mut redis_conn, &config.judge_queue).await {
            Ok(Some(task)) => task,
            Ok(None) => continue,
            Err(e) => {
                error!("拉取任务失败: {}", e);
                tokio::time::sleep(std::time::Duration::from_secs(1)).await;
                continue;
            }
        };

        info!(
            "收到评测任务: submission_id={}, language={}",
            task.submission_id, task.language
        );

        let permit = semaphore
            .clone()
            .acquire_owned()
            .await
            .expect("信号量关闭，无法继续处理");
        let docker = docker.clone();
        let redis_url = redis_url.clone();
        let result_queue = result_queue.clone();
        let work_dir = work_dir.clone();

        tokio::spawn(async move {
            let _permit = permit;

            let result = match judge::runner::evaluate(&docker, &task, &work_dir).await {
                Ok(r) => r,
                Err(e) => {
                    error!("评测失败: {}: {}", task.submission_id, e);
                    types::JudgeResult::error(&task.submission_id, &e.to_string())
                }
            };

            // 建立独立连接发布结果
            if let Ok(mut conn) = redis_client_conn(&redis_url).await {
                if let Err(e) = mq::push_result(&mut conn, &result_queue, &result).await {
                    error!(
                        "发布评测结果失败: {} (submission: {})",
                        e, task.submission_id
                    );
                } else {
                    info!(
                        "评测结果已发布: {} -> {}",
                        task.submission_id, result.status
                    );
                }
            } else {
                error!(
                    "无法连接 Redis 发布结果 (submission: {})",
                    task.submission_id
                );
            }
        });
    }
}

/// 创建并验证 Redis 连接。
async fn redis_client_conn(redis_url: &str) -> Result<redis::aio::MultiplexedConnection> {
    let client = redis::Client::open(redis_url).context("创建 Redis 客户端失败")?;
    let conn = client
        .get_multiplexed_async_connection()
        .await
        .context("连接 Redis 失败")?;
    Ok(conn)
}
