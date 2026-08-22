/// Neuro OJ 评测 Worker
///
/// 从 Redis 消息队列中拉取评测任务，在 Docker 容器中执行评测，
/// 并将结果返回给 noj-core。
mod config;
mod drain;
mod dual;
mod judge;
mod mq;
mod sandbox;
mod types;

use anyhow::{Context, Result};
use bollard::Docker;
use futures_util::{stream::FuturesUnordered, StreamExt};
use std::sync::Arc;
use tokio::sync::Semaphore;
use tracing::{error, info};

use crate::config::Config;
use crate::mq::PulledTask;

// merge_output 实现在 lib.rs；此处 use 使 bin 内的 `crate::merge_output` 路径可解析
use noj_judge::merge_output;

/// 拉取任务失败后的重试间隔。
const PULL_RETRY_DELAY: std::time::Duration = std::time::Duration::from_secs(1);

/// 评测结果 fallback 文件目录名（相对 work_dir）。
const FALLBACK_RESULTS_DIR: &str = "fallback-results";

/// 初始化 Tokio 运行时，连接 Redis 与 Docker，进入主循环阻塞拉取评测任务。
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
        info!("noj-judge 启动");

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

        let result_queue = config.result_queue.clone();
        let judge_queue = config.judge_queue.clone();
        let work_dir = config.work_dir.clone();
        let instance_id = config.instance_id.clone();

        // fallback 目录在循环外构造一次，供所有任务 spawn 复用
        let fallback_dir = std::path::Path::new(&work_dir).join(FALLBACK_RESULTS_DIR);

        // NOJ-180：启动时回放上次未投递成功的 fallback 结果。
        mq::replay_fallback_results(&redis_client, &result_queue, &fallback_dir).await;

        // NOJ-154：启动时清理本实例残留的孤儿容器。
        crate::sandbox::cleanup::cleanup_orphan_containers(&docker, &instance_id).await;

        // ── 初始化缓存与下载配置 ────────────────────────
        let cache_dir = config.support_cache_dir.clone();
        let download_timeout = config.support_package_download_timeout_secs;
        let cache_max_items = config.support_cache_max_items;
        let cache_max_mb = config.support_cache_max_mb;
        let allow_evaluator_network = config.allow_evaluator_network;
        let image_prefix = config.image_prefix.clone();
        let command_whitelist = config.command_whitelist.clone();
        let drain_timeout = config.drain_timeout_secs();
        let max_concurrent_judges = config.max_concurrent_judges;
        let cpu_limit_millicores = config.cpu_limit_millicores;
        let judge_semaphore = Arc::new(Semaphore::new(max_concurrent_judges));
        info!("评测并发上限: {}", max_concurrent_judges);
        info!("每个评测容器 CPU 上限: {}m", cpu_limit_millicores);

        // NOJ-152/155：同时监听 SIGTERM 与 SIGINT 触发优雅关闭。
        let (shutdown_tx, mut shutdown_rx) = tokio::sync::oneshot::channel::<()>();
        tokio::spawn(async move {
            let mut sigterm = tokio::signal::unix::signal(
                tokio::signal::unix::SignalKind::terminate(),
            )
            .expect("注册 SIGTERM 处理器失败");
            tokio::select! {
                _ = tokio::signal::ctrl_c() => {
                    info!("收到 SIGINT，开始优雅关闭...");
                }
                _ = sigterm.recv() => {
                    info!("收到 SIGTERM，开始优雅关闭...");
                }
            }
            let _ = shutdown_tx.send(());
        });

        info!("等待评测任务...");

        // 使用 FuturesUnordered 跟踪所有 in-flight 任务
        let mut tasks = FuturesUnordered::new();

        loop {
            // 先取得一个并发许可，再执行 BRPOPLPUSH。许可在任务完成、失败或
            // drain 时分别由任务结束/取消自动释放，确保 Redis processing 中的
            // in-flight 任务数不超过配置上限。
            let pull_next = async {
                let permit = Arc::clone(&judge_semaphore)
                    .acquire_owned()
                    .await
                    .context("获取评测并发许可失败")?;
                let task_result = mq::pull_task(&mut redis_conn, &judge_queue).await;
                Ok::<_, anyhow::Error>((permit, task_result))
            };

            tokio::select! {
                biased;
                _ = &mut shutdown_rx => {
                    drain::drain_tasks(&mut tasks, drain_timeout).await;
                    break;
                }
                pulled_result = pull_next => {
                    let (permit, task_result) = match pulled_result {
                        Ok(value) => value,
                        Err(e) => return Err(e),
                    };

                    let pulled: PulledTask = match task_result {
                        Ok(Some(pulled)) => pulled,
                        Ok(None) => {
                            drop(permit);
                            continue;
                        }
                        Err(e) => {
                            drop(permit);
                            error!("拉取任务失败: {}", e);
                            tokio::time::sleep(PULL_RETRY_DELAY).await;
                            continue;
                        }
                    };

                    info!(
                        "收到评测任务: submission_id={}, language={}",
                        pulled.task.submission_id, pulled.task.language
                    );

                    let redis_client = redis_client.clone();
                    let result_queue = result_queue.clone();
                    let judge_queue = judge_queue.clone();
                    let cache_dir = cache_dir.clone();
                    let fallback_dir = fallback_dir.clone();
                    let image_prefix = image_prefix.clone();
                    let command_whitelist = command_whitelist.clone();
                    let docker = docker.clone();

                    let handle = tokio::spawn(async move {
                        let _permit = permit;
                        let raw = pulled.raw;
                        let task = pulled.task;

                        // 统一使用双容器模式（Evaluator + Solution）
                        let result = match judge::runner::evaluate_with_cpu_limit(
                            docker,
                            &task,
                            download_timeout,
                            cache_dir.clone(),
                            cache_max_items,
                            cache_max_mb,
                            cpu_limit_millicores,
                            allow_evaluator_network,
                            &image_prefix,
                            &command_whitelist,
                        ).await {
                            Ok(r) => r,
                            Err(e) => {
                                error!(submission_id = %task.submission_id, error = %e, "双容器评测失败");
                                types::JudgeResult::error(&task.submission_id, task.rejudge_seq)
                            }
                        };

                        // 使用带重试的推送；成功后确认任务，崩溃/失败则留给 sweeper。
                        if mq::push_result_with_retry(
                            &redis_client,
                            &result_queue,
                            &result,
                            &fallback_dir,
                        ).await {
                            mq::ack_task(&redis_client, &judge_queue, &raw).await;
                        }
                    });
                    tasks.push(handle);
                }
                Some(join_result) = tasks.next(), if !tasks.is_empty() => {
                    if let Err(e) = join_result {
                        error!("评测任务异步执行失败: {}", e);
                    }
                }
            }
        }

        Ok(())
    })
}
