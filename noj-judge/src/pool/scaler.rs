//! 自动扩缩容模块。
//!
//! 每个 noj-judge 实例独立运行扩缩容循环，
//! 根据 QPS、排队时间、空闲率等本地指标调整目标池深度。

use std::collections::VecDeque;
use std::sync::Arc;
use std::time::{Duration, Instant};

use tokio::time::sleep;
use tracing::info;

use super::Pool;
use crate::config::PoolConfig;

/// 扩缩容评估器。
///
/// 维护滑动窗口指标，定期调整各池的目标深度。
pub struct Scaler {
    /// 每个池的指标记录
    metrics: Vec<PoolMetrics>,
}

/// 单个池的滑动窗口指标。
struct PoolMetrics {
    /// 池引用
    pool: Arc<Pool>,
    /// 到达时间戳滑动窗口（用于计算 QPS）
    arrival_timestamps: VecDeque<Instant>,
    /// 排队时间滑动窗口（毫秒）
    queue_wait_times: VecDeque<u64>,
    /// 采样次数
    sample_count: u64,
    /// 即时创建次数（池空）
    miss_count: u64,
    /// 上次评估时的 idle 计数快照
    prev_idle_count: usize,
    /// 连续高空闲周期数（用于缩容判断）
    high_idle_cycles: u32,
    /// 配置
    config: Arc<PoolConfig>,
}

impl Scaler {
    /// 创建 Scaler。
    pub fn new(pools: Vec<Arc<Pool>>, config: Arc<PoolConfig>) -> Self {
        let metrics = pools
            .into_iter()
            .map(|pool| PoolMetrics {
                pool,
                arrival_timestamps: VecDeque::with_capacity(1024),
                queue_wait_times: VecDeque::with_capacity(512),
                sample_count: 0,
                miss_count: 0,
                prev_idle_count: 0,
                high_idle_cycles: 0,
                config: config.clone(),
            })
            .collect();

        Scaler { metrics }
    }

    /// 记录一次任务到达。
    pub fn record_arrival(&mut self, pool: &str) {
        for m in &mut self.metrics {
            if m.pool.image() == pool {
                m.arrival_timestamps.push_back(Instant::now());
                if m.arrival_timestamps.len() > 1024 {
                    m.arrival_timestamps.pop_front();
                }
                break;
            }
        }
    }

    /// 记录一次 acquire 排队时间（毫秒）。
    pub fn record_queue_wait(&mut self, pool: &str, wait_ms: u64) {
        for m in &mut self.metrics {
            if m.pool.image() == pool {
                m.queue_wait_times.push_back(wait_ms);
                if m.queue_wait_times.len() > 512 {
                    m.queue_wait_times.pop_front();
                }
                m.sample_count += 1;
                break;
            }
        }
    }

    /// 记录一次即时创建（池空 miss）。
    pub fn record_miss(&mut self, pool: &str) {
        for m in &mut self.metrics {
            if m.pool.image() == pool {
                m.miss_count += 1;
                break;
            }
        }
    }

    /// 启动周期性扩缩容循环。
    pub async fn start(mut self) {
        let interval = self
            .metrics
            .first()
            .map(|m| m.config.scale_interval_secs)
            .unwrap_or(60);

        info!("扩缩容循环启动 (间隔={}s)", interval);

        loop {
            sleep(Duration::from_secs(interval)).await;

            for m in &mut self.metrics {
                let pool = &m.pool;
                let target = pool.target_depth();
                let idle = pool.idle_count().await;
                let in_flight = pool.in_flight();
                let _total = idle + in_flight;

                // 计算窗口内的 QPS
                let now = Instant::now();
                let window_secs = interval as f64;
                while let Some(&t) = m.arrival_timestamps.front() {
                    if now.duration_since(t).as_secs_f64() > window_secs * 1.5 {
                        m.arrival_timestamps.pop_front();
                    } else {
                        break;
                    }
                }
                let qps = m.arrival_timestamps.len() as f64 / window_secs;

                // 平均排队时间
                let avg_queue_wait = if !m.queue_wait_times.is_empty() {
                    m.queue_wait_times.iter().sum::<u64>() as f64 / m.queue_wait_times.len() as f64
                } else {
                    0.0
                };

                // miss_rate
                let total_tasks = m.sample_count.max(1);
                let miss_rate = m.miss_count as f64 / total_tasks as f64;

                // idle_ratio
                let idle_ratio = if target > 0 {
                    idle as f64 / target as f64
                } else {
                    1.0
                };

                // 评估是否需要扩缩容
                let mut scale_up = 0i32;
                let mut scale_down = 0i32;

                // 扩：排队太久或池空太频繁
                if avg_queue_wait > 1000.0 {
                    scale_up += 2;
                }
                if avg_queue_wait > 500.0 {
                    scale_up += 1;
                }
                if miss_rate > 0.3 {
                    scale_up += 1;
                }

                // 缩：长期利用率低
                if idle_ratio > 0.4 {
                    m.high_idle_cycles += 1;
                    if m.high_idle_cycles >= 2 {
                        scale_down += 1;
                    }
                    if m.high_idle_cycles >= 3 && idle_ratio > 0.6 {
                        scale_down += 1;
                    }
                } else {
                    m.high_idle_cycles = 0;
                }

                let adjustment = scale_up - scale_down;
                if adjustment != 0 {
                    let new_target = (target as i32 + adjustment).max(m.config.min_size as i32)
                        .min(m.config.max_size as i32) as usize;
                    pool.set_target_depth(new_target, m.config.min_size, m.config.max_size);

                    info!(
                        "扩缩容: image={}, target={}->{}, qps={:.1}, queue_wait={:.0}ms, \
                         miss_rate={:.1}%, idle_ratio={:.1}%, in_flight={}, idle={}",
                        pool.image(),
                        target,
                        new_target,
                        qps,
                        avg_queue_wait,
                        miss_rate * 100.0,
                        idle_ratio * 100.0,
                        in_flight,
                        idle,
                    );
                }

                // 重置计数器
                m.miss_count = 0;
                m.queue_wait_times.clear();
            }
        }
    }
}
