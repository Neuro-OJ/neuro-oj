/// Neuro OJ 评测 Worker
///
/// 从 Redis 消息队列中拉取评测任务，在 Docker 容器中执行评测，
/// 并将结果返回给 noj-core。
mod config;
mod dual;
mod judge;
mod mq;
mod pool;
mod sandbox;
mod types;

use anyhow::{Context, Result};
use bollard::Docker;
use futures_util::stream::FuturesUnordered;
use futures_util::StreamExt;
use tracing::{error, info, warn};

use crate::config::Config;
use crate::pool::PoolManager;

/// 将 stdout 和 stderr 合并为单一输出字符串，中间以分隔符连接。
///
/// stderr 为空时直接返回 stdout，避免添加不必要的分隔符。
///
/// 实现在 lib.rs（单源，避免与集成测试的入径不同步）。
pub use noj_judge::merge_output;

/// 等待所有 in-flight 任务完成（带 30s 超时兜底）。
///
/// 超时后必须**显式** `abort()` 剩余 `JoinHandle`，否则：
/// 1. `FuturesUnordered` 在本函数返回后被 drop，drop 时**不会**等待 task 完成；
/// 2. task 内部的 future（如 `bollard` exec、cgroup read）会被取消；
/// 3. Docker exec 在 daemon 侧无法被取消，会残留到自然结束——这就是 exec 泄漏。
///
/// 因此超时分支里我们主动遍历 `tasks.iter_mut()` 调用 `abort()`，
/// 然后用 5s 兜底 `join_all` 收集结果（best-effort，不阻塞进程退出）。
async fn drain_tasks(tasks: &mut FuturesUnordered<tokio::task::JoinHandle<()>>) {
    info!(
        "关闭信号已接收，等待 {} 个正在执行的任务完成...",
        tasks.len()
    );
    let drain_timeout = std::time::Duration::from_secs(30);
    let deadline = tokio::time::sleep(drain_timeout);
    tokio::pin!(deadline);
    loop {
        tokio::select! {
            _ = &mut deadline => {
                warn!("等待超时，{} 个任务未完成，强制退出", tasks.len());
                break;
            }
            _ = tasks.next() => {
                if tasks.is_empty() {
                    info!("所有 in-flight 任务已完成");
                    return;
                }
            }
        }
    }

    // 显式 abort 所有剩余任务，阻止 FuturesUnordered drop 后 task 被悄悄取消
    let remaining = tasks.len();
    warn!("drain 超时，强制 abort {} 个剩余 task", remaining);
    for handle in tasks.iter_mut() {
        handle.abort();
    }
    // best-effort 等待 abort 完成，最多 5s（不阻塞进程退出）
    let drain = futures_util::future::join_all(tasks);
    match tokio::time::timeout(std::time::Duration::from_secs(5), drain).await {
        Ok(results) => {
            let aborted = results
                .iter()
                .filter(|r| r.as_ref().err().is_some_and(|e| e.is_cancelled()))
                .count();
            let finished = results.len() - aborted;
            info!(
                "剩余任务 abort 完成: finished={}, aborted={}",
                finished, aborted
            );
        }
        Err(_) => {
            warn!("abort 后 join_all 仍超时，进程将直接退出");
        }
    }
}

/// noj-judge 入口点。
///
/// 初始化 Tokio 运行时，连接 Redis 和 Docker，启动容器池管理器，
/// 然后进入主循环阻塞拉取评测任务。
fn main() -> Result<()> {
    let rt = tokio::runtime::Runtime::new().context("创建 Tokio 运行时失败")?;
    rt.block_on(async {
        tracing_subscriber::fmt()
            .with_env_filter(
                tracing_subscriber::EnvFilter::try_from_default_env()
                    .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("info,noj_judge=debug")),
            )
            .init();

        let config = Config::from_env();
        info!("noj-judge 启动 (pool_max_size={})", config.pool.max_size);

        // 检测已废弃的 POOL_ENABLED 环境变量
        if let Ok(val) = std::env::var("POOL_ENABLED") {
            warn!(
                "环境变量 POOL_ENABLED={} 已废弃（容器池始终启用），请移除该变量",
                val
            );
        }

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

        // ── 通过 Redis RPC 获取镜像白名单 ─────────────────
        let judge_id = std::env::var("JUDGE_ID")
            .unwrap_or_else(|_| gethostname::gethostname().to_string_lossy().to_string());
        info!("judge_id = {}", judge_id);

        // 创建专用于 RPC 的 Redis 连接（不与主循环共享）
        let rpc_conn = redis_client
            .get_multiplexed_async_connection()
            .await
            .context("创建 RPC Redis 连接失败")?;
        let mut rpc_client = mq::rpc::RpcClient::new(rpc_conn, judge_id);

        let images = match rpc_client.get_image_allowlist().await {
            Ok(list) => {
                // 仅 evaluator kind 的镜像入池；solution kind 仅记录
                let pool_images = if !list.evaluator.is_empty() {
                    info!(
                        "从 core 获取镜像白名单: evaluator={:?}, solution={:?}",
                        list.evaluator, list.solution
                    );
                    list.evaluator
                } else {
                    warn!(
                        "core 返回的 evaluator 镜像列表为空，回退至配置文件默认值"
                    );
                    config.pool.images.clone()
                };
                pool_images
            }
            Err(e) => {
                warn!("获取镜像白名单失败: {:#}，回退至配置文件默认值", e);
                config.pool.images.clone()
            }
        };

        // ── 初始化容器池 ──────────────────────────────
        let allowed: Vec<_> = images.iter().map(|img| pool::AllowedImage {
            image: img.clone(),
            mode: pool::AllowedImageMode::Exact,
        }).collect();
        let pool = PoolManager::init(docker, config.pool.clone(), &allowed)
            .await
            .context("初始化容器池失败")?;

        // 启动后台任务：健康检查（简化版，合并 Supervisor 日志）
        pool.start_background_tasks().await;

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

        // 克隆配置值供 tokio::spawn 使用
        let cache_dir = config.support_cache_dir.clone();
        let download_timeout = config.support_package_download_timeout_secs;
        let cache_max_items = config.support_cache_max_items;
        let cache_max_mb = config.support_cache_max_mb;

        loop {
            tokio::select! {
                biased;
                _ = &mut shutdown_rx => {
                    drain_tasks(&mut tasks).await;
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

                    let redis_client = redis_client.clone();
                    let result_queue = result_queue.clone();
                    let work_dir = work_dir.clone();
                    let cache_dir = cache_dir.clone();

                    let handle = tokio::spawn(async move {
                        let work_dir_path = std::path::Path::new(&work_dir);
                        let fallback_dir = std::path::Path::new(&work_dir).join("fallback-results");

                        // 统一使用双容器模式（Evaluator + Solution）
                        let docker = Docker::connect_with_local_defaults()
                            .expect("Docker 连接失败");
                        let result = match judge::runner::evaluate(
                            docker,
                            &task,
                            work_dir_path,
                            download_timeout,
                            cache_dir.clone(),
                            cache_max_items,
                            cache_max_mb,
                        ).await {
                            Ok(r) => r,
                            Err(e) => {
                                error!("双容器评测失败: {}: {:#}", task.submission_id, e);
                                types::JudgeResult::error(&task.submission_id, &e.to_string(), task.rejudge_seq)
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

        #[allow(unreachable_code)]
        Ok(())
    })
}
