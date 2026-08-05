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
use futures_util::stream::FuturesUnordered;
use tracing::{error, info};

use crate::config::Config;

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
        let work_dir = config.work_dir.clone();

        // fallback 目录在循环外构造一次，供所有任务 spawn 复用
        let fallback_dir = std::path::Path::new(&work_dir).join(FALLBACK_RESULTS_DIR);

        // ── 初始化缓存与下载配置 ────────────────────────
        let cache_dir = config.support_cache_dir.clone();
        let download_timeout = config.support_package_download_timeout_secs;
        let cache_max_items = config.support_cache_max_items;
        let cache_max_mb = config.support_cache_max_mb;

        // 注册优雅关闭信号处理（排空 in-flight 任务）
        let (shutdown_tx, mut shutdown_rx) = tokio::sync::oneshot::channel::<()>();
        tokio::spawn(async move {
            tokio::signal::ctrl_c().await.ok();
            info!("收到 SIGINT，开始优雅关闭...");
            let _ = shutdown_tx.send(());
        });

        info!("等待评测任务...");

        // 使用 FuturesUnordered 跟踪所有 in-flight 任务
        let mut tasks = FuturesUnordered::new();

        loop {
            tokio::select! {
                biased;
                _ = &mut shutdown_rx => {
                    drain::drain_tasks(&mut tasks).await;
                    break;
                }
                task_result = mq::pull_task(&mut redis_conn, &config.judge_queue) => {
                    let task = match task_result {
                        Ok(Some(task)) => task,
                        Ok(None) => continue,
                        Err(e) => {
                            error!("拉取任务失败: {}", e);
                            tokio::time::sleep(PULL_RETRY_DELAY).await;
                            continue;
                        }
                    };

                    info!(
                        "收到评测任务: submission_id={}, language={}",
                        task.submission_id, task.language
                    );

                    let redis_client = redis_client.clone();
                    let result_queue = result_queue.clone();
                    let cache_dir = cache_dir.clone();
                    let fallback_dir = fallback_dir.clone();

                    let handle = tokio::spawn(async move {
                        // 统一使用双容器模式（Evaluator + Solution）
                        let docker = match Docker::connect_with_local_defaults() {
                            Ok(d) => d,
                            Err(e) => {
                                error!(submission_id = %task.submission_id, error = %e, "连接 Docker daemon 失败");
                                let result = types::JudgeResult::error(
                                    &task.submission_id,
                                    task.rejudge_seq,
                                );
                                mq::push_result_with_retry(
                                    &redis_client,
                                    &result_queue,
                                    &result,
                                    &fallback_dir,
                                ).await;
                                return;
                            }
                        };
                        let result = match judge::runner::evaluate(
                            docker,
                            &task,
                            download_timeout,
                            cache_dir.clone(),
                            cache_max_items,
                            cache_max_mb,
                        ).await {
                            Ok(r) => r,
                            Err(e) => {
                                error!(submission_id = %task.submission_id, error = %e, "双容器评测失败");
                                types::JudgeResult::error(&task.submission_id, task.rejudge_seq)
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

        Ok(())
    })
}
