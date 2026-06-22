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
use futures_util::stream::FuturesUnordered;
use futures_util::StreamExt;
use tokio::sync::Semaphore;
use tracing::{error, info, warn};

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

    let _redis_url = config.redis_url.clone();
    let result_queue = config.result_queue.clone();
    let work_dir = config.work_dir.clone();

    if config.pool.enabled {
        // ── Pool 模式 ──────────────────────────────
        let pool = PoolManager::init(docker, config.pool.clone())
            .await
            .context("初始化容器池失败")?;

        let pool_ref = pool.clone();
        // 注册优雅关闭信号处理
        let (shutdown_tx, mut shutdown_rx) = tokio::sync::oneshot::channel::<()>();
        tokio::spawn(async move {
            tokio::signal::ctrl_c().await.ok();
            info!("收到 SIGINT，开始优雅关闭...");
            pool_ref.shutdown().await;
            let _ = shutdown_tx.send(());
        });

        info!("等待评测任务（池模式）...");

        // 使用 FuturesUnordered 跟踪所有 in-flight 任务
        let mut tasks = FuturesUnordered::new();

        loop {
            tokio::select! {
                biased;
                _ = &mut shutdown_rx => {
                    info!("关闭信号已接收，等待 {} 个正在执行的任务完成...", tasks.len());
                    // 等待所有 in-flight 任务完成（带 30s 超时）
                    let timeout_dur = std::time::Duration::from_secs(30);
                    let timeout = tokio::time::sleep(timeout_dur);
                    tokio::pin!(timeout);
                    loop {
                        tokio::select! {
                            _ = &mut timeout => {
                                warn!("等待超时，{} 个任务未完成，强制退出", tasks.len());
                                break;
                            }
                            _ = tasks.next() => {
                                if tasks.is_empty() {
                                    info!("所有 in-flight 任务已完成");
                                    break;
                                }
                            }
                        }
                    }
                    break;
                }
                task_result = mq::pull_task(&mut redis_conn, &config.judge_queue) => {
                    let task = match task_result {
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

                    let handle = tokio::spawn(async move {
                        let work_dir_path = std::path::Path::new(&work_dir);
                        let fallback_dir = std::path::Path::new(&work_dir).join("fallback-results");

                        let result = match judge::runner::evaluate_with_pool(pool.clone(), &task, work_dir_path).await {
                            Ok(r) => {
                                // 根据结果状态更新计数器
                                match r.status.as_str() {
                                    "TimeLimitExceeded" => pool.inc_timeouts_total(),
                                    "SystemError" | "RuntimeError" => pool.inc_errors_total(),
                                    _ => {}
                                }
                                r
                            }
                            Err(e) => {
                                error!("评测失败: {}: {:#}", task.submission_id, e);
                                pool.inc_errors_total();
                                types::JudgeResult::error(&task.submission_id, &e.to_string())
                            }
                        };

                        // 使用带重试的推送
                        mq::push_result_with_retry(
                            &redis_client,
                            &result_queue,
                            &result,
                            &fallback_dir,
                        ).await;
                    });
                    tasks.push(handle);
                }
            }
        }
    } else {
        // ── 旧 Semaphore 模式 ──────────────────────
        let semaphore = Arc::new(Semaphore::new(config.max_concurrent()));

        info!("等待评测任务（Semaphore 模式）...");

        // 注册优雅关闭信号
        let (shutdown_tx, mut shutdown_rx) = tokio::sync::oneshot::channel::<()>();
        tokio::spawn(async move {
            tokio::signal::ctrl_c().await.ok();
            info!("收到 SIGINT，开始优雅关闭（Semaphore 模式）...");
            let _ = shutdown_tx.send(());
        });

        let mut tasks = FuturesUnordered::new();

        loop {
            tokio::select! {
                biased;
                _ = &mut shutdown_rx => {
                    info!("关闭信号已接收，等待 {} 个正在执行的任务完成...", tasks.len());
                    let timeout_dur = std::time::Duration::from_secs(30);
                    let timeout = tokio::time::sleep(timeout_dur);
                    tokio::pin!(timeout);
                    loop {
                        tokio::select! {
                            _ = &mut timeout => {
                                warn!("等待超时，{} 个任务未完成，强制退出", tasks.len());
                                break;
                            }
                            _ = tasks.next() => {
                                if tasks.is_empty() {
                                    info!("所有 in-flight 任务已完成");
                                    break;
                                }
                            }
                        }
                    }
                    break;
                }
                task_result = mq::pull_task(&mut redis_conn, &config.judge_queue) => {
                    let task = match task_result {
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

                    let handle = tokio::spawn(async move {
                        let _permit = permit;
                        let fallback_dir = std::path::Path::new(&work_dir).join("fallback-results");

                        let result = match judge::runner::evaluate_legacy(&docker, &task, &work_dir).await {
                            Ok(r) => r,
                            Err(e) => {
                                error!("评测失败: {}: {:#}", task.submission_id, e);
                                types::JudgeResult::error(&task.submission_id, &e.to_string())
                            }
                        };

                        // 使用带重试的推送
                        mq::push_result_with_retry(
                            &redis_client,
                            &result_queue,
                            &result,
                            &fallback_dir,
                        ).await;
                    });
                    tasks.push(handle);
                }
            }
        }
    }

    #[allow(unreachable_code)]
    Ok(())
    })
}
