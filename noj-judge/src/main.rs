/// Neuro OJ 评测 Worker
///
/// 从 Redis 消息队列中拉取评测任务，在 Docker 容器中执行评测，
/// 并将结果返回给 noj-core。
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
use crate::pool::PoolManager;

fn main() -> Result<()> {
    let rt = tokio::runtime::Runtime::new().context("创建 Tokio 运行时失败")?;
    rt.block_on(async {
    tracing_subscriber::fmt::init();

    let config = Config::from_env();
    info!("noj-judge 启动 (pool_enabled={})", config.pool.enabled);

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

    let redis_url = config.redis_url.clone();
    let result_queue = config.result_queue.clone();
    let work_dir = config.work_dir.clone();

    if config.pool.enabled {
        // ── Pool 模式 ──────────────────────────────
        let pool = PoolManager::init(docker, config.pool.clone())
            .await
            .context("初始化容器池失败")?;

        let pool_ref = pool.clone();
        // 启动后台任务（健康检查）
        pool.start_background_tasks().await;
        // 注册 SIGTERM 处理
        tokio::spawn(async move {
            tokio::signal::ctrl_c().await.ok();
            info!("收到 SIGTERM，开始优雅关闭...");
            pool_ref.shutdown().await;
        });

        info!("等待评测任务（池模式）...");

        loop {
            if pool.is_shutting_down() {
                info!("池管理器正在关闭，退出主循环");
                break;
            }

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

            let pool = pool.clone();
            let redis_client = redis_client.clone();
            let result_queue = result_queue.clone();
            let work_dir = work_dir.clone();

            tokio::spawn(async move {
                let work_dir_path = std::path::Path::new(&work_dir);

                let result = match judge::runner::evaluate_with_pool(pool.clone(), &task, work_dir_path).await {
                    Ok(r) => r,
                    Err(e) => {
                        error!("评测失败: {}: {:#}", task.submission_id, e);
                        types::JudgeResult::error(&task.submission_id, &e.to_string())
                    }
                };

                if let Ok(mut conn) = redis_client.get_multiplexed_async_connection().await {
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
                }
            });
        }
    } else {
        // ── 旧 Semaphore 模式 ──────────────────────
        let semaphore = Arc::new(Semaphore::new(config.max_concurrent()));

        info!("等待评测任务（Semaphore 模式）...");

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

            let permit = semaphore
                .clone()
                .acquire_owned()
                .await
                .expect("信号量关闭，无法继续处理");
            let docker = docker.clone();
            let redis_client = redis_client.clone();
            let result_queue = result_queue.clone();
            let work_dir = work_dir.clone();

            tokio::spawn(async move {
                let _permit = permit;

                let result = match judge::runner::evaluate_legacy(&docker, &task, &work_dir).await {
                    Ok(r) => r,
                    Err(e) => {
                        error!("评测失败: {}: {:#}", task.submission_id, e);
                        types::JudgeResult::error(&task.submission_id, &e.to_string())
                    }
                };

                if let Ok(mut conn) = redis_client.get_multiplexed_async_connection().await {
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
                }
            });
        }
    }

    #[allow(unreachable_code)]
    Ok(())
    })
}
