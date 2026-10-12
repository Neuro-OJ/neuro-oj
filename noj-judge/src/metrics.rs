//! Judge Worker 运行指标与 Redis TTL 心跳。

use bollard::models::ContainerSummaryStateEnum;
use bollard::query_parameters::ListContainersOptionsBuilder;
use bollard::Docker;
use serde::Serialize;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Duration;
use tokio::fs;
use tracing::warn;

const HEARTBEAT_INTERVAL: Duration = Duration::from_secs(10);
const HEARTBEAT_TTL_SECONDS: u64 = 30;
const HEARTBEAT_PREFIX: &str = "noj:observability:judge:";

/// Judge Worker 的聚合运行指标。
pub struct JudgeMetrics {
    active_tasks: AtomicU64,
    completed_tasks_total: AtomicU64,
    failed_tasks_total: AtomicU64,
    result_push_failures_total: AtomicU64,
    max_concurrent_tasks: u64,
}

impl JudgeMetrics {
    pub fn new(max_concurrent_tasks: usize) -> Self {
        Self {
            active_tasks: AtomicU64::new(0),
            completed_tasks_total: AtomicU64::new(0),
            failed_tasks_total: AtomicU64::new(0),
            result_push_failures_total: AtomicU64::new(0),
            max_concurrent_tasks: max_concurrent_tasks as u64,
        }
    }

    pub fn task_started(&self) {
        self.active_tasks.fetch_add(1, Ordering::Relaxed);
    }

    pub fn task_finished(&self, failed: bool) {
        self.active_tasks
            .try_update(Ordering::Relaxed, Ordering::Relaxed, |value| {
                Some(value.saturating_sub(1))
            })
            .ok();
        if failed {
            self.failed_tasks_total.fetch_add(1, Ordering::Relaxed);
        } else {
            self.completed_tasks_total.fetch_add(1, Ordering::Relaxed);
        }
    }

    pub fn result_push_failed(&self) {
        self.result_push_failures_total
            .fetch_add(1, Ordering::Relaxed);
    }

    fn snapshot(
        &self,
        orphan_containers: usize,
        cache_items: usize,
        cache_bytes: u64,
        work_dir_bytes: u64,
    ) -> Heartbeat {
        Heartbeat {
            active_tasks: self.active_tasks.load(Ordering::Relaxed),
            max_concurrent_tasks: self.max_concurrent_tasks,
            completed_tasks_total: self.completed_tasks_total.load(Ordering::Relaxed),
            failed_tasks_total: self.failed_tasks_total.load(Ordering::Relaxed),
            result_push_failures_total: self.result_push_failures_total.load(Ordering::Relaxed),
            orphan_containers,
            cache_items,
            cache_bytes,
            work_dir_bytes,
            updated_at_ms: chrono_like_now_ms(),
        }
    }
}

#[derive(Debug, Serialize)]
struct Heartbeat {
    active_tasks: u64,
    max_concurrent_tasks: u64,
    completed_tasks_total: u64,
    failed_tasks_total: u64,
    result_push_failures_total: u64,
    orphan_containers: usize,
    cache_items: usize,
    cache_bytes: u64,
    work_dir_bytes: u64,
    updated_at_ms: u64,
}

fn chrono_like_now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

/// 启动 Judge 心跳任务。Redis 暂时不可用只记录告警，不影响评测主循环。
#[allow(dead_code)]
pub async fn heartbeat_loop(
    redis_client: redis::Client,
    docker: Docker,
    instance_id: String,
    metrics: Arc<JudgeMetrics>,
    cache_dir: PathBuf,
    work_dir: PathBuf,
) {
    heartbeat_loop_with_resources(
        redis_client,
        docker,
        instance_id,
        metrics,
        cache_dir,
        work_dir,
        None,
    )
    .await
}

#[allow(clippy::too_many_arguments)]
pub async fn heartbeat_loop_with_resources(
    redis_client: redis::Client,
    docker: Docker,
    instance_id: String,
    metrics: Arc<JudgeMetrics>,
    cache_dir: PathBuf,
    work_dir: PathBuf,
    resource: Option<(String, String, Vec<String>, serde_json::Value)>,
) {
    let mut interval = tokio::time::interval(HEARTBEAT_INTERVAL);
    interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    loop {
        interval.tick().await;
        let (orphan_containers, (cache_items, cache_bytes), (_, work_dir_bytes)) = tokio::join!(
            count_orphan_containers(&docker, &instance_id),
            directory_stats(&cache_dir, true),
            directory_stats(&work_dir, false),
        );
        let mut heartbeat = serde_json::to_value(metrics.snapshot(
            orphan_containers,
            cache_items,
            cache_bytes,
            work_dir_bytes,
        ))
        .expect("观测快照字段固定且可序列化");
        if let Some((group, resource_key, enabled, capacities)) = &resource {
            if let Ok(mut connection) = redis_client.get_multiplexed_async_connection().await {
                use redis::AsyncCommands;
                let rss = fs::read_to_string("/proc/self/statm")
                    .await
                    .ok()
                    .and_then(|value| value.split_whitespace().nth(1)?.parse::<u64>().ok())
                    .map(|pages| {
                        // 当前正式平台为 Linux amd64；页大小按运行环境读取。
                        let page_bytes = unsafe { libc::sysconf(libc::_SC_PAGESIZE) };
                        pages
                            .saturating_mul(if page_bytes > 0 {
                                page_bytes as u64
                            } else {
                                4096
                            })
                            .div_ceil(1024 * 1024)
                    })
                    .unwrap_or(0);
                // 租约过期与准入都使用 Redis 时间，避免多 Worker 时钟偏差。
                let server_time: redis::RedisResult<(u64, u64)> =
                    redis::cmd("TIME").query_async(&mut connection).await;
                let Ok((seconds, micros)) = server_time else {
                    continue;
                };
                let now = seconds.saturating_mul(1000) + micros / 1000;
                let rss_key = format!("{resource_key}:rss");
                let sample = serde_json::json!({"mb":rss,"expires":now+30_000}).to_string();
                let _: redis::RedisResult<usize> =
                    connection.hset(&rss_key, &instance_id, sample).await;
                let _: redis::RedisResult<bool> = connection.expire(&rss_key, 60).await;
                let leases: redis::RedisResult<std::collections::HashMap<String, String>> =
                    connection.hgetall(resource_key).await;
                if let Ok(leases) = leases {
                    let mut counts = std::collections::HashMap::<String, u64>::new();
                    let mut parents = std::collections::HashMap::<String, (u64, u64)>::new();
                    let mut children = std::collections::HashMap::<String, u64>::new();
                    for (id, raw) in leases {
                        let Ok(item) = serde_json::from_str::<serde_json::Value>(&raw) else {
                            continue;
                        };
                        if item["expires"].as_u64().unwrap_or(0) <= now {
                            continue;
                        }
                        let kind = item["kind"].as_str().unwrap_or_default().to_owned();
                        let parent = item["parent"].as_str().unwrap_or_default();
                        // 领取前的零内存容量探针不作为活跃提交展示。
                        if !parent.is_empty()
                            || item["base"].as_u64().unwrap_or(0) != 0
                            || item["headroom"].as_u64().unwrap_or(0) != 0
                        {
                            *counts.entry(kind).or_default() += 1;
                        }
                        if parent.is_empty() {
                            parents.insert(
                                id,
                                (
                                    item["base"].as_u64().unwrap_or(0),
                                    item["headroom"].as_u64().unwrap_or(0),
                                ),
                            );
                        } else {
                            *children.entry(parent.to_owned()).or_default() +=
                                item["memory"].as_u64().unwrap_or(0);
                        }
                    }
                    let reserved = parents
                        .into_iter()
                        .map(|(id, (base, headroom))| {
                            base + headroom.max(children.get(&id).copied().unwrap_or(0))
                        })
                        .sum::<u64>();
                    heartbeat["scheduling_version"] = serde_json::json!(1);
                    heartbeat["resource_group"] = serde_json::json!(group);
                    heartbeat["resource_pools"] = serde_json::json!(enabled);
                    heartbeat["resources"] = serde_json::json!({"capacities":capacities,"active":counts,"reserved_memory_mb":reserved,"worker_rss_mb":rss});
                }
            }
        }
        let payload = heartbeat.to_string();
        let key = format!("{}{}", HEARTBEAT_PREFIX, instance_id);
        match redis_client.get_multiplexed_async_connection().await {
            Ok(mut conn) => {
                let result: redis::RedisResult<()> = redis::cmd("SET")
                    .arg(&key)
                    .arg(payload)
                    .arg("EX")
                    .arg(HEARTBEAT_TTL_SECONDS)
                    .query_async(&mut conn)
                    .await;
                if let Err(err) = result {
                    warn!(error = %err, "写入 Judge 观测心跳失败");
                }
            }
            Err(err) => warn!(error = %err, "连接 Redis 写入 Judge 观测心跳失败"),
        }
    }
}

async fn count_orphan_containers(docker: &Docker, instance_id: &str) -> usize {
    // 与启动清扫共用同一过滤器（实例标签精准匹配，VULN-15）。
    let filters = crate::sandbox::cleanup::instance_label_filter(instance_id);
    let options = ListContainersOptionsBuilder::new()
        .all(true)
        .filters(&filters)
        .build();
    docker
        .list_containers(Some(options))
        .await
        .map(|containers| {
            containers
                .into_iter()
                .filter(|container| container.state != Some(ContainerSummaryStateEnum::RUNNING))
                .count()
        })
        .unwrap_or(0)
}

async fn directory_stats(path: &Path, zip_only: bool) -> (usize, u64) {
    let mut stack = vec![path.to_path_buf()];
    let mut files = 0usize;
    let mut bytes = 0u64;
    while let Some(current) = stack.pop() {
        let mut entries = match fs::read_dir(&current).await {
            Ok(entries) => entries,
            Err(_) => continue,
        };
        while let Ok(Some(entry)) = entries.next_entry().await {
            let entry_path = entry.path();
            match entry.metadata().await {
                Ok(metadata) if metadata.is_dir() => stack.push(entry_path),
                Ok(metadata)
                    if metadata.is_file()
                        && (!zip_only
                            || entry_path.extension().and_then(|s| s.to_str()) == Some("zip")) =>
                {
                    files += 1;
                    bytes = bytes.saturating_add(metadata.len());
                }
                _ => {}
            }
        }
    }
    (files, bytes)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn metrics_track_active_and_finished_tasks() {
        let metrics = JudgeMetrics::new(2);
        metrics.task_started();
        assert_eq!(metrics.active_tasks.load(Ordering::Relaxed), 1);
        metrics.task_finished(false);
        metrics.task_started();
        metrics.task_finished(true);
        metrics.result_push_failed();
        assert_eq!(metrics.active_tasks.load(Ordering::Relaxed), 0);
        assert_eq!(metrics.completed_tasks_total.load(Ordering::Relaxed), 1);
        assert_eq!(metrics.failed_tasks_total.load(Ordering::Relaxed), 1);
        assert_eq!(
            metrics.result_push_failures_total.load(Ordering::Relaxed),
            1
        );
    }

    #[test]
    fn heartbeat_prefix_is_stable() {
        assert_eq!(
            format!("{}worker-1", HEARTBEAT_PREFIX),
            "noj:observability:judge:worker-1"
        );
    }
}
