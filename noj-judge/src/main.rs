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
use std::sync::Arc;
use tokio::sync::Semaphore;
use tracing::{error, info, warn};

use crate::config::Config;
use crate::mq::PulledTask;
use noj_judge::metrics::{heartbeat_loop, JudgeMetrics};
// 跨 worker 的每用户评测占用（分布式 claim）：替代原先的进程内 HashSet。
use noj_judge::user_claim;

// merge_output 实现在 lib.rs；此处 use 使 bin 内的 `crate::merge_output` 路径可解析
use noj_judge::merge_output;

/// 拉取任务失败后的重试间隔。
const PULL_RETRY_DELAY: std::time::Duration = std::time::Duration::from_secs(1);

/// 评测结果 fallback 文件目录名（相对 work_dir）。
const FALLBACK_RESULTS_DIR: &str = "fallback-results";

/// 每用户活跃评测槽位的 RAII guard（**跨 worker 分布式**）。
///
/// 评测任务开始前在 Redis 上占用该用户的槽位，guard 析构时释放，
/// 避免任务 panic/异常路径导致用户槽位泄漏。
///
/// 修复（跨 worker 公平性）：原实现用进程内 `HashSet` 记录活跃用户，
/// 部署 N 个 worker 时每个进程各有一份集合，同一用户可同时跑 N 个评测，
/// 「同一用户同时最多 1 个评测」的公平性限制被静默放大 N 倍。
/// 现改为 Redis 全局 claim（见 `noj_judge::user_claim`），所有 worker 共享判定。
struct ActiveUserGuard {
    /// 专用 claim 连接（与主循环的阻塞连接分离，互不影响）。
    conn: redis::aio::MultiplexedConnection,
    prefix: String,
    user_id: String,
    member: String,
}

impl ActiveUserGuard {
    fn new(
        conn: redis::aio::MultiplexedConnection,
        prefix: String,
        user_id: String,
        member: String,
    ) -> Self {
        Self {
            conn,
            prefix,
            user_id,
            member,
        }
    }
}

impl Drop for ActiveUserGuard {
    fn drop(&mut self) {
        // Drop 不能 await：把释放操作 spawn 出去（MultiplexedConnection 的命令排队后
        // 会在后台完成）。同时 claim 自带 TTL，即使本次释放未送达也会自动过期。
        let (conn, prefix, user_id, member) = (
            self.conn.clone(),
            self.prefix.clone(),
            self.user_id.clone(),
            self.member.clone(),
        );
        if let Ok(handle) = tokio::runtime::Handle::try_current() {
            handle.spawn(async move {
                let mut conn = conn;
                noj_judge::user_claim::release_user(&mut conn, &prefix, &user_id, &member).await;
            });
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
        // F-07：全局并发闸门 + 每用户分布式 claim（同一用户跨 worker 同时最多 1 个评测）。
        // 先获取全局 Semaphore 槽位，再做 per-user 公平调度，避免不同用户任务无限制 spawn。
        let semaphore = Arc::new(Semaphore::new(max_concurrent_judges));
        // 跨 worker 的每用户占用走 Redis（见 noj_judge::user_claim 的模块文档）。
        let user_claim_prefix = config.user_claim_prefix.clone();
        let user_claim_ttl_ms = config.user_claim_ttl_ms;
        // 专用连接：不与主循环的 BRPOPLPUSH 连接共用，避免阻塞命令影响 claim 延迟。
        let claim_conn = redis_client
            .get_multiplexed_async_connection()
            .await
            .context("创建 per-user claim 连接失败")?;
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

        // ── 每用户 claim 的安全不变量校验（评审补充）────────────────────────
        //
        // per-user 互斥依赖「claim TTL > 单次评测最长可能耗时」。若 TTL 更短，
        // 长评测的 claim 会在跑完之前被判过期并被其他 worker 回收，同一用户于是
        // 并发跑了多个评测——正是本机制要消除的缺陷，且**难以察觉**：回收方不记录
        // 任何日志，受害方只在结束时打一条泛泛的"可能已过期"警告。
        //
        // 该不变量此前只写在注释里，没有任何运行时校验。这里在启动时检查：
        // 明显不安全（TTL <= 上限）直接拒绝启动；余量偏小（< 4 倍）给出警告。
        // 特殊语义：max_evaluator_time_ms == 0 表示**不设上限**（见 dual 侧
        // `clamp_runtime_config` 的 `if max > 0`），此时任何有限 TTL 都不再受保障，
        // 必须显式告警而不是静默放过。
        if max_evaluator_time_ms == 0 {
            warn!(
                "JUDGE_MAX_EVALUATOR_TIME_MS=0 表示不限制评测时长，而 \
                 JUDGE_USER_CLAIM_TTL_MS={}ms 是有限的——超长评测会中途丢失 claim，\
                 同一用户可能并发评测。建议设置有限的评测上限，或大幅提高 claim TTL。",
                user_claim_ttl_ms
            );
        } else if user_claim_ttl_ms <= max_evaluator_time_ms as i64 {
            anyhow::bail!(
                "配置不安全：JUDGE_USER_CLAIM_TTL_MS={}ms 不大于 \
                 JUDGE_MAX_EVALUATOR_TIME_MS={}ms。长评测会在完成前被判过期并被其他 \
                 worker 回收，导致同一用户并发评测（静默破坏每用户互斥）。\
                 请将 TTL 提高到评测上限的至少 4 倍。",
                user_claim_ttl_ms,
                max_evaluator_time_ms
            );
        } else if user_claim_ttl_ms < (max_evaluator_time_ms as i64).saturating_mul(4) {
            warn!(
                "JUDGE_USER_CLAIM_TTL_MS={}ms 相对 JUDGE_MAX_EVALUATOR_TIME_MS={}ms \
                 余量不足 4 倍；建议提高 TTL，避免长评测的 claim 被误回收。",
                user_claim_ttl_ms,
                max_evaluator_time_ms
            );
        }
        info!(
            "每用户 claim：命名空间前缀={}，TTL={}ms（评测上限 {}ms）",
            user_claim_prefix, user_claim_ttl_ms, max_evaluator_time_ms
        );

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
            // F-07：先获取全局并发槽位，再拉取任务。
            // 若先拉取再等槽位，任务已被移入 processing 却只是在排队等槽位，
            // 会被 sweeper 误判超时重投，造成同一提交重复评测。
            let shutdown = &mut shutdown_rx;
            let permit = tokio::select! {
                biased;
                _ = shutdown => {
                    drain::drain_tasks(&mut tasks, drain_timeout).await;
                    break;
                }
                acquired = semaphore.clone().acquire_owned() => {
                    match acquired {
                        Ok(permit) => permit,
                        Err(e) => {
                            error!("获取评测并发槽位失败: {}", e);
                            continue;
                        }
                    }
                }
            };

            // 只允许在等待关闭信号时响应关闭。拿到任务后必须完整执行
            // BRPOPLPUSH：Redis 可能已经把消息移入 processing，若此时取消
            // future，消息会留在 processing 却永远不会进入评测任务。
            let shutdown = &mut shutdown_rx;
            tokio::select! {
                biased;
                _ = shutdown => {
                    drop(permit);
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

                    // F-07 公平调度（跨 worker）：同一用户已有**未过期**评测 claim 时，
                    // 释放槽位并把任务放回队尾轮给他人。
                    // 判定走 Redis 全局状态，因此 N 个 worker 也严格保持「每用户 1 个」。
                    let claim_member =
                        user_claim::claim_member(&instance_id, &pulled.task.submission_id);
                    let is_active_user = {
                        let mut claim_conn = claim_conn.clone();
                        match user_claim::try_claim_user(
                            &mut claim_conn,
                            &user_claim_prefix,
                            &pulled.task.user_id,
                            &claim_member,
                            user_claim_ttl_ms,
                        )
                        .await
                        {
                            Ok(claimed) => !claimed,
                            Err(e) => {
                                // claim 失败（Redis 异常）：保守放回队尾重试，
                                // 不冒险并发跑同一用户的多个评测。
                                warn!(
                                    submission_id = %pulled.task.submission_id,
                                    error = %e,
                                    "占用用户槽位失败，任务放回队尾重试"
                                );
                                true
                            }
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
                    let guard_conn = claim_conn.clone();
                    let guard_prefix = user_claim_prefix.clone();
                    let guard_user_id = pulled.task.user_id.clone();
                    let guard_member = claim_member;
                    let task_metrics = Arc::clone(&judge_metrics);
                    task_metrics.task_started();

                    let handle = tokio::spawn(async move {
                        let raw = pulled.raw;
                        let task = pulled.task;
                        // RAII guard：任务结束（含 panic/异常路径）时自动释放用户 claim。
                        let _active_guard = ActiveUserGuard::new(
                            guard_conn,
                            guard_prefix,
                            guard_user_id,
                            guard_member,
                        );
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
    use crate::types::{EvaluatorRuntime, RuntimeConfig, SolutionRuntime};

    /// 队列 [userA 任务1, userA 任务2, userB 任务1] 的公平调度**决策语义**：
    /// 判定依据是「该用户是否已有未过期 claim」，因此 userA 已占用时应跳过其任务。
    ///
    /// 注：占用状态的**存储**已迁移到 Redis（见 noj_judge::user_claim 的测试）。
    /// 这里只保留调度决策本身的纯逻辑断言，不再复制一份进程内集合实现。
    #[test]
    fn per_user_limit_skips_active_users() {
        // 模拟 try_claim_user 的返回值：userA 已被占用 → claim 失败
        let claim_results = [("userA", false), ("userA", false), ("userB", true)];
        let mut picked: Option<&str> = None;
        for (user, claimed) in claim_results {
            if claimed {
                picked = Some(user);
                break;
            }
        }
        assert_eq!(picked, Some("userB"), "userA 已占用时应跳过并取 userB");
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
