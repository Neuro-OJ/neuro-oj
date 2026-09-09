/// Neuro OJ 评测 Worker
///
/// 从 Redis 消息队列中拉取评测任务，在 Docker 容器中执行评测，
/// 并将结果返回给 noj-core。
mod config;
mod docker;
mod drain;
mod dual;
mod judge;
mod mq;
mod sandbox;
mod types;

use anyhow::{Context, Result};
use futures_util::{stream::FuturesUnordered, FutureExt, StreamExt};
use std::collections::HashSet;
use std::sync::{Arc, Mutex};
use tokio::sync::Semaphore;
use tracing::{error, info};

use crate::config::Config;
use crate::mq::PulledTask;
use noj_judge::metrics::{heartbeat_loop, JudgeMetrics};

// merge_output 实现在 lib.rs；此处 use 使 bin 内的 `crate::merge_output` 路径可解析
use noj_judge::merge_output;

/// 拉取任务失败后的重试间隔。
const PULL_RETRY_DELAY: std::time::Duration = std::time::Duration::from_secs(1);

/// 评测结果 fallback 文件目录名（相对 work_dir）。
const FALLBACK_RESULTS_DIR: &str = "fallback-results";

/// 每用户活跃评测槽位的 RAII guard。
///
/// 评测任务开始前插入 `active_users`，guard 析构时自动移除，
/// 避免任务 panic/异常路径导致用户槽位泄漏。
struct ActiveUserGuard {
    active_users: Arc<Mutex<HashSet<String>>>,
    user_id: String,
}

impl ActiveUserGuard {
    fn new(active_users: Arc<Mutex<HashSet<String>>>, user_id: String) -> Self {
        Self {
            active_users,
            user_id,
        }
    }
}

impl Drop for ActiveUserGuard {
    fn drop(&mut self) {
        if let Ok(mut guard) = self.active_users.lock() {
            guard.remove(&self.user_id);
        }
    }
}

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
        let docker = docker::connect(&config.docker_host, config.require_isolated_docker)
            .context("连接 Docker daemon 失败（请检查 JUDGE_DOCKER_HOST 与 daemon 隔离配置）")?;
        docker
            .ping()
            .await
            .context("Docker daemon PING 失败（请确保 Docker 在运行中）")?;
        info!("Docker 连接成功");

        let result_queue = config.result_queue.clone();
        let judge_queues = config.judge_queues();
        let mut priority_cursor = 0usize;
        let priority_poll_timeout = config.priority_poll_timeout_secs;
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
        let evaluator_network_mode = config.evaluator_network_mode.clone();
        let allow_http_s3 = config.allow_http_s3;
        let image_prefix = config.image_prefix.clone();
        let command_whitelist = config.command_whitelist.clone();
        let drain_timeout = config.drain_timeout_secs();
        let max_concurrent_judges = config.max_concurrent_judges;
        let cpu_limit_millicores = config.cpu_limit_millicores;
        let max_evaluator_time_ms = config.max_evaluator_time_ms;
        let max_solution_call_timeout_ms = config.max_solution_call_timeout_ms;
        // F-07：全局并发闸门 + 每用户 active 集合（同一用户同时最多 1 个评测）。
        // 先获取全局 Semaphore 槽位，再做 per-user 公平调度，避免不同用户任务无限制 spawn。
        let semaphore = Arc::new(Semaphore::new(max_concurrent_judges));
        let active_users: Arc<Mutex<HashSet<String>>> = Arc::new(Mutex::new(HashSet::new()));
        let judge_metrics = Arc::new(JudgeMetrics::new(max_concurrent_judges));
        let heartbeat_metrics = Arc::clone(&judge_metrics);
        let heartbeat_redis = redis_client.clone();
        let heartbeat_docker = docker.clone();
        let heartbeat_instance_id = instance_id.clone();
        let heartbeat_cache_dir = std::path::PathBuf::from(cache_dir.clone());
        let heartbeat_work_dir = std::path::PathBuf::from(work_dir.clone());
        tokio::spawn(async move {
            heartbeat_loop(
                heartbeat_redis,
                heartbeat_docker,
                heartbeat_instance_id,
                heartbeat_metrics,
                heartbeat_cache_dir,
                heartbeat_work_dir,
            )
            .await;
        });
        info!("评测并发上限: {}", max_concurrent_judges);
        info!("每个评测容器 CPU 上限: {}m", cpu_limit_millicores);
        info!("Evaluator 时间硬上限: {}ms", max_evaluator_time_ms);
        info!("Solution 调用硬上限: {}ms", max_solution_call_timeout_ms);

        // NOJ-152/155：同时监听 SIGTERM 与 SIGINT 触发优雅关闭。
        let (shutdown_tx, mut shutdown_rx) = tokio::sync::oneshot::channel::<()>();
        tokio::spawn(async move {
            let mut sigterm =
                tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
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
            // 只允许在等待关闭信号时响应关闭。拿到任务后必须完整执行
            // BRPOPLPUSH：Redis 可能已经把消息移入 processing，若此时取消
            // future，消息会留在 processing 却永远不会进入评测任务。
            let shutdown = &mut shutdown_rx;
            tokio::select! {
                biased;
                _ = shutdown => {
                    drain::drain_tasks(&mut tasks, drain_timeout).await;
                    break;
                }
                task_result = mq::pull_task_priority(
                    &mut redis_conn,
                    &judge_queues,
                    &mut priority_cursor,
                    priority_poll_timeout,
                ) => {
                    let pulled: PulledTask = match task_result {
                        Ok(Some(pulled)) => pulled,
                        Ok(None) => continue,
                        Err(e) => {
                            error!("拉取任务失败: {}", e);
                            tokio::time::sleep(PULL_RETRY_DELAY).await;
                            continue;
                        }
                    };

                    // F-07 公平调度：先获取全局并发槽位，再检查同一用户是否已有评测在跑。
                    // 若用户已活跃则释放槽位并把任务放回队尾轮给他人。
                    let permit = match semaphore.clone().acquire_owned().await {
                        Ok(permit) => permit,
                        Err(e) => {
                            error!("获取评测并发槽位失败: {}", e);
                            continue;
                        }
                    };
                    let is_active_user = {
                        let mut guard = active_users.lock().unwrap();
                        if guard.contains(&pulled.task.user_id) {
                            true
                        } else {
                            guard.insert(pulled.task.user_id.clone());
                            false
                        }
                    };
                    if is_active_user {
                        drop(permit);
                        if let Err(e) =
                            mq::requeue_task(&redis_client, &pulled.queue, &pulled.raw).await
                        {
                            error!(
                                submission_id = %pulled.task.submission_id,
                                error = %e,
                                "活跃用户任务重投失败"
                            );
                        }
                        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
                        continue;
                    }

                    info!(
                        "收到评测任务: submission_id={}, language={}",
                        pulled.task.submission_id, pulled.task.language
                    );

                    let redis_client = redis_client.clone();
                    let result_queue = result_queue.clone();
                    let task_queue = pulled.queue.clone();
                    let cache_dir = cache_dir.clone();
                    let fallback_dir = fallback_dir.clone();
                    let task_work_dir = work_dir.clone();
                    let image_prefix = image_prefix.clone();
                    let evaluator_network_mode = evaluator_network_mode.clone();
                    let command_whitelist = command_whitelist.clone();
                    let docker = docker.clone();
                    let active_users = Arc::clone(&active_users);
                    let task_user_id = pulled.task.user_id.clone();
                    let task_metrics = Arc::clone(&judge_metrics);
                    task_metrics.task_started();

                    let handle = tokio::spawn(async move {
                        let raw = pulled.raw;
                        let task = pulled.task;
                        // RAII guard：任务结束（含 panic/异常路径）时自动释放用户槽位。
                        let _active_guard = ActiveUserGuard::new(active_users, task_user_id);
                        // 持有全局并发槽位直到任务结束。
                        let _permit = permit;

                        // 统一使用双容器模式（Evaluator + Solution）
                        let result = match judge::runner::evaluate_with_cpu_limit(
                            docker,
                            &task,
                            download_timeout,
                            cache_dir.clone(),
                            cache_max_items,
                            cache_max_mb,
                            task_work_dir,
                            cpu_limit_millicores,
                            allow_evaluator_network,
                            &evaluator_network_mode,
                            allow_http_s3,
                            &image_prefix,
                            &command_whitelist,
                            max_evaluator_time_ms,
                            max_solution_call_timeout_ms,
                        )
                        .await
                        {
                            Ok(r) => r,
                            Err(e) => {
                                error!(submission_id = %task.submission_id, error = %e, "双容器评测失败");
                                types::JudgeResult::error(&task.submission_id, task.rejudge_seq)
                            }
                        };

                        // 使用带重试的推送；成功后确认任务，崩溃/失败则留给 sweeper。
                        let push_succeeded = mq::push_result_with_retry(
                            &redis_client,
                            &result_queue,
                            &result,
                            &fallback_dir,
                        )
                        .await;
                        if push_succeeded {
                            mq::ack_task(&redis_client, &task_queue, &raw).await;
                        } else {
                            task_metrics.result_push_failed();
                        }
                        task_metrics.task_finished(result.status == "error");
                        // 用户槽位由 _active_guard 在任务退出时自动释放。
                    });
                    tasks.push(handle);
                }
            }

            // 不等待任务完成，只回收已经完成的 JoinHandle，避免长期运行时
            // FuturesUnordered 无限增长；BRPOPLPUSH 本身不会在此处被取消。
            while let Some(join_result) = tasks.next().now_or_never().flatten() {
                if let Err(e) = join_result {
                    error!("评测任务异步执行失败: {}", e);
                }
            }
        }

        Ok(())
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::{EvaluatorRuntime, RuntimeConfig, SolutionRuntime};

    /// F-07 公平调度纯逻辑测试：活跃用户集合的占位/释放语义。
    #[test]
    fn active_user_slot_is_exclusive_and_released() {
        let active: Arc<Mutex<HashSet<String>>> = Arc::new(Mutex::new(HashSet::new()));
        let user = "u-a".to_string();

        {
            let mut guard = active.lock().unwrap();
            assert!(!guard.contains(&user), "初始无活跃用户");
            guard.insert(user.clone());
        }
        {
            let guard = active.lock().unwrap();
            assert!(guard.contains(&user), "占位后应包含该用户");
        }
        {
            let mut guard = active.lock().unwrap();
            guard.remove(&user);
            assert!(!guard.contains(&user), "释放后应不再包含该用户");
        }
    }

    /// 队列 [userA 任务1, userA 任务2, userB 任务1]；userA active 时应跳到 userB 的任务。
    #[test]
    fn per_user_limit_skips_active_users() {
        let active: Arc<Mutex<HashSet<String>>> = Arc::new(Mutex::new(HashSet::new()));
        active.lock().unwrap().insert("userA".to_string());

        let queue = ["userA", "userA", "userB"];
        let mut picked: Option<String> = None;
        for user in queue {
            let mut guard = active.lock().unwrap();
            if guard.contains(user) {
                continue;
            }
            guard.insert(user.to_string());
            picked = Some(user.to_string());
            break;
        }
        assert_eq!(picked.as_deref(), Some("userB"), "应跳过活跃用户取 userB");
    }

    /// ActiveUserGuard 析构时自动释放用户槽位。
    #[test]
    fn active_user_guard_releases_on_drop() {
        let active: Arc<Mutex<HashSet<String>>> = Arc::new(Mutex::new(HashSet::new()));
        let user = "u-guard".to_string();
        active.lock().unwrap().insert(user.clone());
        {
            let _guard = ActiveUserGuard::new(Arc::clone(&active), user.clone());
            assert!(active.lock().unwrap().contains(&user));
        }
        assert!(!active.lock().unwrap().contains(&user));
    }

    /// JudgeTask 反序列化需要携带 user_id（公平调度字段）。
    #[test]
    fn judge_task_requires_user_id() {
        let json = serde_json::json!({
            "submission_id": "sid-1",
            "problem_id": "1001",
            "user_id": "u-1",
            "runtime_config": {
                "evaluator": {"image": "noj-evaluator-python", "command": "python3 /workspace/evaluate.py", "time_limit_ms": 5000, "memory_limit_mb": 512},
                "solution": {"image": "noj-solution-python", "call_timeout_ms": 2000, "memory_limit_mb": 512}
            },
            "language": "python3",
            "code": "print(1)"
        });
        let task: crate::types::JudgeTask = serde_json::from_value(json).unwrap();
        assert_eq!(task.user_id, "u-1");
    }

    /// 保证 RuntimeConfig 相关导入在测试中可用（与生产结构保持一致）。
    #[test]
    fn runtime_config_shape_matches_protocol() {
        let config = RuntimeConfig {
            evaluator: EvaluatorRuntime {
                image: "img".to_string(),
                command: "cmd".to_string(),
                time_limit_ms: 1000,
                memory_limit_mb: 256,
                network: None,
            },
            solution: SolutionRuntime {
                image: "img".to_string(),
                call_timeout_ms: 1000,
                memory_limit_mb: 256,
            },
        };
        assert_eq!(config.evaluator.time_limit_ms, 1000);
        assert_eq!(config.solution.call_timeout_ms, 1000);
    }
}
