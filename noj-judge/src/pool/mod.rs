//! 统一容器池模块。
//!
//! PoolManager 统一管理所有评测容器的生命周期。
//! 所有容器（预创建和即时创建）都通过池统一管理。

pub mod copy;
pub mod exec;
pub mod metrics;
pub mod scaler;

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use anyhow::Result;
use bollard::Docker;
use futures_util::StreamExt;
use tokio::sync::{mpsc, Mutex, Notify, RwLock};
use tokio_util::sync::CancellationToken;
use tracing::{error, info, warn};

use crate::config::PoolConfig;
use crate::pool::scaler::ScalerEvent;

// ── 常量 ───────────────────────────────────────────────

/// 健康检查间隔（秒）。
#[allow(dead_code)]
const HEALTH_CHECK_INTERVAL_SECS: u64 = 5;
/// Supervisor 状态检查间隔（秒）。
#[allow(dead_code)]
const SUPERVISOR_INTERVAL_SECS: u64 = 30;
/// 回补 debounce 窗口（毫秒）。
const REFILL_DEBOUNCE_MS: u64 = 200;
/// acquire 阻塞等待超时（秒）。
const ACQUIRE_TIMEOUT_SECS: u64 = 60;
/// docker rm -f 重试延迟序列（毫秒）。
const RM_F_RETRY_DELAYS: &[u64] = &[100, 500, 2000];

// ── 容器状态机 ──────────────────────────────────────────

/// 容器生命周期状态。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ContainerStatus {
    /// 就绪，在空闲队列中等待分配
    Idle,
    /// 已分配给某个任务，正在使用
    InUse,
    /// 健康检查发现异常，等待摘除
    #[allow(dead_code)]
    Dead,
}

/// 池中容器的完整状态。
#[derive(Debug, Clone)]
pub struct ContainerState {
    /// Docker 容器 ID
    #[allow(dead_code)]
    pub container_id: String,
    /// 当前生命周期状态
    pub status: ContainerStatus,
    /// 进入 Idle 状态的时间戳（用于空闲超时检测）
    pub idle_since: Option<Instant>,
    /// 容器所属镜像名
    #[allow(dead_code)]
    pub image: String,
}

// ── 每个镜像的独立池 ────────────────────────────────────

/// 单个镜像的池。
pub struct Pool {
    /// 容器状态映射：container_id → ContainerState
    containers: RwLock<HashMap<String, ContainerState>>,
    /// 等待队列——池满时 acquire 在此阻塞
    notify: Notify,
    /// 当前目标深度（受 Scaler 调控）
    target_depth: AtomicUsize,
    /// 当前忙碌（InUse）容器数
    in_flight: AtomicUsize,
    /// 该池的镜像名
    image: String,
    /// 该池的内存上限 MB
    memory_mb: u64,
    /// 回补进行中标记（debounce）
    refill_in_progress: AtomicBool,
}

impl Pool {
    /// 创建一个新的池。
    fn new(image: String, memory_mb: u64, initial_target: usize) -> Self {
        Self {
            containers: RwLock::new(HashMap::new()),
            notify: Notify::new(),
            target_depth: AtomicUsize::new(initial_target),
            in_flight: AtomicUsize::new(0),
            image,
            memory_mb,
            refill_in_progress: AtomicBool::new(false),
        }
    }

    /// 获取一个空闲容器。
    /// 返回容器 ID，或 None 表示需要即时创建。
    pub async fn acquire(&self) -> Option<String> {
        let mut guard = self.containers.write().await;
        for (id, state) in guard.iter_mut() {
            if state.status == ContainerStatus::Idle {
                state.status = ContainerStatus::InUse;
                state.idle_since = None;
                self.in_flight.fetch_add(1, Ordering::SeqCst);
                return Some(id.clone());
            }
        }
        None
    }

    /// 标记容器为 InUse（即时创建后直接分配）。
    pub async fn mark_in_use(&self, container_id: &str) {
        let mut guard = self.containers.write().await;
        if let Some(state) = guard.get_mut(container_id) {
            state.status = ContainerStatus::InUse;
            state.idle_since = None;
        } else {
            guard.insert(
                container_id.to_string(),
                ContainerState {
                    container_id: container_id.to_string(),
                    status: ContainerStatus::InUse,
                    idle_since: None,
                    image: self.image.clone(),
                },
            );
        }
        self.in_flight.fetch_add(1, Ordering::SeqCst);
    }

    /// 释放容器（删除后调用）。
    pub async fn release(&self, container_id: &str) {
        let mut guard = self.containers.write().await;
        guard.remove(container_id);
        self.in_flight.fetch_sub(1, Ordering::SeqCst);
        self.notify.notify_one();
    }

    /// 将新建的容器放入空闲队列。
    pub async fn push_idle(&self, container_id: String) {
        let mut guard = self.containers.write().await;
        let id = container_id.clone();
        guard.insert(
            container_id,
            ContainerState {
                container_id: id,
                status: ContainerStatus::Idle,
                idle_since: Some(Instant::now()),
                image: self.image.clone(),
            },
        );
    }

    /// 等待有容器释放。
    pub async fn wait_for_slot(&self) {
        self.notify.notified().await;
    }

    /// 收集并移除所有 Dead 容器。
    /// 返回被移除的容器 ID 列表（调用方需 docker rm -f）。
    #[allow(dead_code)]
    pub async fn collect_dead(&self) -> Vec<String> {
        let mut guard = self.containers.write().await;
        let mut to_remove = Vec::new();
        guard.retain(|id, state| {
            if state.status == ContainerStatus::Dead {
                to_remove.push(id.clone());
                return false;
            }
            true
        });
        to_remove
    }

    /// 触发空闲超时清理和健康检查。
    #[allow(dead_code)]
    pub async fn collect_idle_timeout(&self, idle_timeout: std::time::Duration) -> Vec<String> {
        let mut guard = self.containers.write().await;
        let mut to_remove = Vec::new();
        let now = Instant::now();
        guard.retain(|id, state| {
            if state.status == ContainerStatus::Idle {
                if let Some(since) = state.idle_since {
                    if now.duration_since(since) > idle_timeout {
                        to_remove.push(id.clone());
                        return false;
                    }
                }
            }
            true
        });
        to_remove
    }

    /// 获取 len（用于统计）。
    #[allow(dead_code)]
    pub async fn len(&self) -> usize {
        self.containers.read().await.len()
    }

    /// 检查池是否为空。
    #[allow(dead_code)]
    pub async fn is_empty(&self) -> bool {
        self.containers.read().await.is_empty()
    }

    /// 获取 idle 容器数。
    pub async fn idle_count(&self) -> usize {
        let guard = self.containers.read().await;
        guard
            .values()
            .filter(|s| s.status == ContainerStatus::Idle)
            .count()
    }

    /// 获取 in_flight。
    pub fn in_flight(&self) -> usize {
        self.in_flight.load(Ordering::SeqCst)
    }

    /// 获取 target_depth。
    pub fn target_depth(&self) -> usize {
        self.target_depth.load(Ordering::SeqCst)
    }

    /// 设置 target_depth。
    pub fn set_target_depth(&self, n: usize, min: usize, max: usize) {
        let clamped = n.clamp(min, max);
        self.target_depth.store(clamped, Ordering::SeqCst);
    }

    /// 获取池对应的镜像名。
    pub fn image(&self) -> &str {
        &self.image
    }

    /// 获取池的内存上限 MB。
    #[allow(dead_code)]
    pub fn memory_mb(&self) -> u64 {
        self.memory_mb
    }

    /// 获取当前总容器数。
    #[allow(dead_code)]
    pub async fn total_containers(&self) -> usize {
        self.containers.read().await.len()
    }

    /// 获取 (idle, in_flight, total) 快照。
    #[allow(dead_code)]
    pub async fn snapshot(&self) -> (usize, usize, usize) {
        let guard = self.containers.read().await;
        let idle = guard
            .values()
            .filter(|s| s.status == ContainerStatus::Idle)
            .count();
        let in_flight = self.in_flight.load(Ordering::SeqCst);
        (idle, in_flight, guard.len())
    }
}

// ── PoolManager ──────────────────────────────────────────

/// 统一容器池管理器。
///
/// 替代原有的 Semaphore 模型，管理所有评测容器的生命周期。
pub struct PoolManager {
    /// 每个镜像的独立池
    pools: Mutex<HashMap<String, Arc<Pool>>>,
    /// Docker 客户端
    docker: Docker,
    /// 配置
    config: PoolConfig,
    /// 是否正在关闭
    shutting_down: AtomicBool,
    /// 关闭通知
    shutdown_token: CancellationToken,
    /// Scaler 事件发送端（由 start_scaler 初始化）
    scaler_tx: tokio::sync::Mutex<Option<mpsc::UnboundedSender<ScalerEvent>>>,
    /// rm -f 最终失败的泄漏容器（健康检查定期清理）
    leaked_containers: Mutex<Vec<String>>,
    /// 累积任务数（counter 指标）
    tasks_total: AtomicUsize,
    /// 累积错误数（counter 指标）
    errors_total: AtomicUsize,
    /// 累积超时数（counter 指标）
    timeouts_total: AtomicUsize,
    /// 累积池 miss 数（counter 指标）
    pool_misses_total: AtomicUsize,
}

impl PoolManager {
    /// 创建并初始化池管理器。
    ///
    /// 遍历 `POOL_IMAGES` 逐个 `docker pull`（含重试），
    /// 然后为每个镜像创建 `POOL_INITIAL_SIZE` 个容器。
    pub async fn init(docker: Docker, config: PoolConfig) -> Result<Arc<Self>> {
        // 清理孤儿容器
        Self::cleanup_orphans(&docker, &config.label_prefix).await;

        let manager = Arc::new(Self {
            pools: Mutex::new(HashMap::new()),
            docker,
            config,
            shutting_down: AtomicBool::new(false),
            shutdown_token: CancellationToken::new(),
            scaler_tx: tokio::sync::Mutex::new(None),
            leaked_containers: Mutex::new(Vec::new()),
            tasks_total: AtomicUsize::new(0),
            errors_total: AtomicUsize::new(0),
            timeouts_total: AtomicUsize::new(0),
            pool_misses_total: AtomicUsize::new(0),
        });

        // 按镜像初始化池
        for image in &manager.config.images {
            info!("预热镜像: {}", image);

            // 先检查镜像是否已存在于本地
            let image_exists = match manager.image_exists_locally(image).await {
                Ok(true) => true,
                Ok(false) => false,
                Err(_) => {
                    warn!("无法检查镜像状态，将尝试拉取: {}", image);
                    false
                }
            };
            if image_exists {
                info!("镜像已存在本地，跳过拉取: {}", image);

                let normalized = Self::normalize_image(image);
                let image_memory = manager.config.memory_mb_for_image(image);
                let pool = Arc::new(Pool::new(
                    normalized.clone(),
                    image_memory,
                    manager.config.initial_size,
                ));

                for i in 0..manager.config.initial_size {
                    match manager.create_container(image).await {
                        Ok(container_id) => {
                            pool.push_idle(container_id).await;
                            info!(
                                "创建预热容器 [{}/{}] 镜像={}",
                                i + 1,
                                manager.config.initial_size,
                                image
                            );
                        }
                        Err(e) => {
                            warn!("创建预热容器失败: {}: {}", image, e);
                        }
                    }
                }

                manager.pools.lock().await.insert(normalized, pool);
                continue;
            }

            // 镜像不在本地，需要拉取（重试 3 次）
            let mut pulled = false;
            for attempt in 1..=3 {
                let options = bollard::query_parameters::CreateImageOptions {
                    from_image: Some(image.clone()),
                    from_src: Some(image.clone()),
                    repo: Some(image.clone()),
                    tag: Some("latest".to_string()),
                    message: None,
                    platform: String::new(),
                    changes: vec![],
                };
                let mut stream = manager.docker.create_image(
                    Some(options),
                    None,
                    None::<bollard::auth::DockerCredentials>,
                );
                let mut pull_ok = false;
                while let Some(result) = stream.next().await {
                    match result {
                        Ok(_info) => {
                            pull_ok = true;
                        }
                        Err(e) => {
                            warn!("拉取镜像失败 (attempt {}/3): {}: {}", attempt, image, e);
                            pull_ok = false;
                            break;
                        }
                    }
                }
                if pull_ok {
                    pulled = true;
                    break;
                }
                tokio::time::sleep(std::time::Duration::from_secs(5)).await;
            }

            if !pulled {
                let build_hint = image
                    .strip_prefix("noj-judge-")
                    .map(|s| {
                        format!(
                            "docker build -t {} -f noj-judge/docker/{}/Dockerfile .",
                            image, s
                        )
                    })
                    .unwrap_or_else(|| format!("docker build -t {} .", image));
                warn!(
                    "跳过镜像 {}: 拉取失败，任务将使用即时创建路径。如需本地构建：{}",
                    image, build_hint
                );
                continue;
            }

            let image_memory = manager.config.memory_mb_for_image(image);
            let normalized = Self::normalize_image(image);
            let pool = Arc::new(Pool::new(
                normalized.clone(),
                image_memory,
                manager.config.initial_size,
            ));

            // 创建初始容器
            for i in 0..manager.config.initial_size {
                match manager.create_container(image).await {
                    Ok(container_id) => {
                        pool.push_idle(container_id).await;
                        info!(
                            "创建预热容器 [{}/{}] 镜像={}",
                            i + 1,
                            manager.config.initial_size,
                            image
                        );
                    }
                    Err(e) => {
                        warn!("创建预热容器失败: {}: {}", image, e);
                    }
                }
            }

            manager.pools.lock().await.insert(normalized, pool);
        }

        info!("容器池初始化完成 (镜像数={})", manager.config.images.len());
        Ok(manager)
    }

    /// 检查镜像是否存在于本地 Docker 仓库。
    async fn image_exists_locally(&self, image: &str) -> Result<bool> {
        let result = self
            .timed_bollard(5, "list_images", async {
                self.docker
                    .list_images(None::<bollard::query_parameters::ListImagesOptions>)
                    .await
                    .map_err(anyhow::Error::from)
            })
            .await;
        match result {
            Ok(images) => Ok(images.iter().any(|i| {
                i.repo_tags
                    .iter()
                    .any(|tag| tag == image || tag.starts_with(&format!("{}:", image)))
            })),
            Err(e) => {
                warn!("检查本地镜像失败: {}: {}", image, e);
                Err(e)
            }
        }
    }

    /// 使用容器执行闭包，闭包返回后自动释放容器。
    ///
    /// 容器获取 → 闭包执行 → 自动 release（无论 Ok/Err 均执行）
    /// 所有清理在同一个 async 上下文中完成，不会被 tokio::spawn 静默丢弃。
    pub async fn with_container<F, Fut, T>(
        self: &Arc<Self>,
        image: &str,
        memory_mb: u64,
        f: F,
    ) -> Result<T>
    where
        F: FnOnce(String) -> Fut,
        Fut: std::future::Future<Output = Result<T>>,
    {
        let (id, pool) = self.acquire_with_pool(image, memory_mb).await?;
        let result = f(id.clone()).await;
        self.release(&pool, &id).await;
        result
    }

    /// 内部 acquire 实现（返回容器 ID + 所属 Pool）。
    async fn acquire_with_pool(&self, image: &str, memory_mb: u64) -> Result<(String, Arc<Pool>)> {
        let pool = self.get_or_create_pool(image).await?;

        // 快速路径：尝试获取空闲容器
        if let Some(id) = pool.acquire().await {
            self.send_scaler_event(ScalerEvent::Arrival {
                pool: image.to_string(),
                timestamp: Instant::now(),
            })
            .await;
            if let Err(e) = self.update_container_memory(&id, memory_mb).await {
                self.release(&pool, &id).await;
                return Err(e);
            }
            return Ok((id, pool.clone()));
        }

        // 池空：检查是否可即时创建
        if pool.in_flight() < pool.target_depth() {
            let id = self.create_container(image).await?;
            pool.mark_in_use(&id).await;
            self.send_scaler_event(ScalerEvent::Arrival {
                pool: image.to_string(),
                timestamp: Instant::now(),
            })
            .await;
            self.send_scaler_event(ScalerEvent::Miss {
                pool: image.to_string(),
            })
            .await;
            self.inc_pool_misses_total();
            // 快速扩容触发器：排队时立即扩容
            if pool.target_depth() < self.config.max_size {
                pool.set_target_depth(
                    pool.target_depth() + 1,
                    self.config.min_size,
                    self.config.max_size,
                );
                info!("快速扩容: {} -> {}", image, pool.target_depth());
            }
            if let Err(e) = self.update_container_memory(&id, memory_mb).await {
                self.release(&pool, &id).await;
                return Err(e);
            }
            return Ok((id, pool.clone()));
        }

        // 已达上限：阻塞等待（带超时）
        let wait_start = Instant::now();
        let deadline = wait_start + Duration::from_secs(ACQUIRE_TIMEOUT_SECS);
        loop {
            if self.shutting_down.load(Ordering::SeqCst) {
                anyhow::bail!("池管理器正在关闭");
            }
            let remaining = deadline.saturating_duration_since(Instant::now());
            if remaining.is_zero() {
                anyhow::bail!("acquire 等待超时 (>{})s", ACQUIRE_TIMEOUT_SECS);
            }
            tokio::select! {
                _ = pool.wait_for_slot() => {}
                _ = tokio::time::sleep(remaining) => {
                    anyhow::bail!("acquire 等待超时 (>{})s", ACQUIRE_TIMEOUT_SECS);
                }
            }
            if let Some(id) = pool.acquire().await {
                let wait_ms = wait_start.elapsed().as_millis() as u64;
                self.send_scaler_event(ScalerEvent::Arrival {
                    pool: image.to_string(),
                    timestamp: Instant::now(),
                })
                .await;
                self.send_scaler_event(ScalerEvent::QueueWait {
                    pool: image.to_string(),
                    wait_ms,
                })
                .await;
                if let Err(e) = self.update_container_memory(&id, memory_mb).await {
                    self.release(&pool, &id).await;
                    return Err(e);
                }
                return Ok((id, pool.clone()));
            }
        }
    }

    /// 释放容器。
    ///
    /// 由 with_container() 在闭包返回后自动调用。
    pub async fn release(&self, pool: &Arc<Pool>, container_id: &str) {
        // docker rm -f 带退避重试
        let mut success = false;
        for (i, delay_ms) in RM_F_RETRY_DELAYS.iter().enumerate() {
            let cid = container_id.to_string();
            match self
                .timed_bollard(10, "remove_container", async {
                    self.docker
                        .remove_container(
                            &cid,
                            Some(bollard::query_parameters::RemoveContainerOptions {
                                force: true,
                                ..Default::default()
                            }),
                        )
                        .await
                        .map_err(anyhow::Error::from)
                })
                .await
            {
                Ok(_) => {
                    success = true;
                    break;
                }
                Err(e) => {
                    if i < RM_F_RETRY_DELAYS.len() - 1 {
                        warn!(
                            task = "release",
                            action = "rm_retry",
                            container_id = container_id,
                            image = pool.image(),
                            attempt = i + 1,
                            max_attempts = RM_F_RETRY_DELAYS.len(),
                            error = %e,
                            "rm -f 失败，将重试"
                        );
                        tokio::time::sleep(std::time::Duration::from_millis(*delay_ms)).await;
                    } else {
                        error!(
                            task = "release",
                            action = "rm_final_failed",
                            container_id = container_id,
                            image = pool.image(),
                            error = %e,
                            "rm -f 最终失败，加入泄漏追踪列表"
                        );
                        let mut leaked = self.leaked_containers.lock().await;
                        leaked.push(container_id.to_string());
                    }
                }
            }
        }

        pool.release(container_id).await;

        // 检查是否需回补（带 debounce）
        if success {
            let idle = pool.idle_count().await;
            let target = pool.target_depth();
            if (idle as f64) < (target as f64) * 0.5 {
                self.trigger_replenish(pool);
            }
        }
    }

    /// 回补一个容器。
    async fn replenish_one(
        docker: &Docker,
        image: &str,
        label_prefix: &str,
        cpu: f64,
        pool: &Arc<Pool>,
    ) -> Result<String> {
        let id = Self::create_container_inner(docker, image, label_prefix, cpu).await?;
        pool.push_idle(id.clone()).await;
        Ok(id)
    }

    /// 触发带 debounce 的批量回补。
    ///
    /// 计算缺口 `target - idle - in_flight` 并循环补齐，最多补齐到 target。
    fn trigger_replenish(&self, pool: &Arc<Pool>) {
        if pool.refill_in_progress.swap(true, Ordering::SeqCst) {
            return; // 已有回补进行中
        }
        let pool = pool.clone();
        let docker = self.docker.clone();
        let label_prefix = self.config.label_prefix.clone();
        let cpu = self.config.cpu;
        tokio::spawn(async move {
            // debounce 窗口
            tokio::time::sleep(std::time::Duration::from_millis(REFILL_DEBOUNCE_MS)).await;

            // 批量补齐缺口（最多 3 次尝试，避免无限循环）
            for _ in 0..3 {
                let idle = pool.idle_count().await;
                let in_flight = pool.in_flight();
                let target = pool.target_depth();
                let gap = (target as i64 - idle as i64 - in_flight as i64).max(0) as usize;
                if gap == 0 {
                    break;
                }

                match Self::replenish_one(&docker, pool.image(), &label_prefix, cpu, &pool).await {
                    Ok(id) => {
                        info!(
                            task = "replenish",
                            action = "success",
                            container_id = id,
                            image = pool.image(),
                            gap = gap - 1,
                            "回补容器完成"
                        );
                    }
                    Err(e) => {
                        warn!(
                            task = "replenish",
                            action = "failed",
                            image = pool.image(),
                            error = %e,
                            "回补容器失败"
                        );
                        break;
                    }
                }
            }
            pool.refill_in_progress.store(false, Ordering::SeqCst);
        });
    }

    /// 归一化镜像名：剥离 `:latest` 后缀用于池 key 匹配。
    fn normalize_image(image: &str) -> String {
        if let Some(stripped) = image.strip_suffix(":latest") {
            stripped.to_string()
        } else {
            image.to_string()
        }
    }

    /// 获取或创建镜像的池。
    async fn get_or_create_pool(&self, image: &str) -> Result<Arc<Pool>> {
        let normalized = Self::normalize_image(image);
        let pools = self.pools.lock().await;
        if let Some(pool) = pools.get(&normalized) {
            return Ok(pool.clone());
        }
        // 没有对应池，创建一个新的
        drop(pools); // 释放锁，后面需要重新获取可变锁
        let mut pools = self.pools.lock().await;
        // 检查是否被其他线程创建了
        if let Some(pool) = pools.get(&normalized) {
            return Ok(pool.clone());
        }
        // 没有对应池，创建一个新的（使用 per-image 内存配置）
        let pool = Arc::new(Pool::new(
            normalized.clone(),
            self.config.memory_mb_for_image(image),
            self.config.initial_size,
        ));
        // 这里简化处理：即时池不预创建容器
        pools.insert(normalized, pool.clone());
        Ok(pool)
    }

    /// 创建容器。
    async fn create_container(&self, image: &str) -> Result<String> {
        Self::create_container_inner(
            &self.docker,
            image,
            &self.config.label_prefix,
            self.config.cpu,
        )
        .await
    }

    /// 创建并启动一个评测容器。
    ///
    /// 容器安全配置（cap_drop ALL、no-new-privileges、network_mode none 等）
    /// 在宿主机侧的 HostConfig 中设置。容器 CMD 设为 `sleep infinity`，
    /// 通过 docker exec 执行实际评测命令。
    async fn create_container_inner(
        docker: &Docker,
        image: &str,
        label_prefix: &str,
        cpu: f64,
    ) -> Result<String> {
        let options = bollard::query_parameters::CreateContainerOptions {
            ..Default::default()
        };

        let label_key = format!("{}.pool", label_prefix);
        let mut labels = HashMap::new();
        labels.insert(label_key, "true".to_string());

        let nano_cpus = if cpu > 0.0 {
            Some((cpu * 1_000_000_000.0) as i64)
        } else {
            None
        };

        // 显式 tmpfs 挂载确保 /tmp 可写（readonly_rootfs 时 Docker 默认创建但存在兼容性问题）
        let mut tmpfs = HashMap::new();
        tmpfs.insert("/tmp".to_string(), "size=256M".to_string());

        let config = bollard::models::ContainerCreateBody {
            image: Some(image.to_string()),
            cmd: Some(vec!["sleep".to_string(), "infinity".to_string()]),
            labels: Some(labels),
            host_config: Some(bollard::models::HostConfig {
                cap_drop: Some(vec!["ALL".to_string()]),
                security_opt: Some(vec!["no-new-privileges:true".to_string()]),
                privileged: Some(false),
                // 注意：不使用 readonly_rootfs，因为 Docker put_archive API 与此不兼容
                // 安全通过 CapDrop ALL + no-new-privileges + network_mode none 保证
                readonly_rootfs: Some(false),
                network_mode: Some("none".to_string()),
                ipc_mode: Some("none".to_string()),
                pids_limit: Some(256),
                tmpfs: Some(tmpfs),
                nano_cpus,
                ..Default::default()
            }),
            ..Default::default()
        };

        let result = with_timeout(30, "create_container", async {
            docker
                .create_container(Some(options), config)
                .await
                .map_err(anyhow::Error::from)
        })
        .await?;
        let start_result = with_timeout(5, "start_container", async {
            docker
                .start_container(&result.id, None)
                .await
                .map_err(anyhow::Error::from)
        })
        .await;
        if let Err(start_err) = start_result {
            // 启动失败：清理已创建但未启动的容器，避免 zombie 容器泄漏
            if let Err(rm_err) = docker
                .remove_container(
                    &result.id,
                    Some(bollard::query_parameters::RemoveContainerOptions {
                        force: true,
                        ..Default::default()
                    }),
                )
                .await
            {
                warn!(
                    container_id = %result.id,
                    error = %rm_err,
                    "create_container 启动失败后清理容器也失败，可能存在 zombie 容器"
                );
            }
            return Err(start_err);
        }
        Ok(result.id)
    }

    /// docker update 下调内存限制。
    async fn update_container_memory(&self, container_id: &str, memory_mb: u64) -> Result<()> {
        let bytes = (memory_mb as i64) * 1024 * 1024;
        let opts = bollard::models::ContainerUpdateBody {
            memory: Some(bytes),
            memory_swap: Some(bytes), // 禁用 swap
            memory_swappiness: Some(0),
            ..Default::default()
        };
        let cid = container_id.to_string();
        self.timed_bollard(5, "update_container", async {
            self.docker
                .update_container(&cid, opts)
                .await
                .map_err(anyhow::Error::from)
        })
        .await?;
        Ok(())
    }

    /// 清理孤儿容器。
    async fn cleanup_orphans(docker: &Docker, label_prefix: &str) {
        let filter_label = format!("{}.pool=true", label_prefix);
        let options = bollard::query_parameters::ListContainersOptions {
            all: true,
            size: false,
            filters: Some(HashMap::from([("label".to_string(), vec![filter_label])])),
            ..Default::default()
        };

        match with_timeout(10, "list_containers", async {
            docker
                .list_containers(Some(options))
                .await
                .map_err(anyhow::Error::from)
        })
        .await
        {
            Ok(containers) => {
                for c in &containers {
                    if let Some(ref id) = c.id {
                        warn!("清理孤儿容器: {}", id);
                        let _ = with_timeout(10, "remove_container", async {
                            docker
                                .remove_container(
                                    id.as_str(),
                                    Some(bollard::query_parameters::RemoveContainerOptions {
                                        force: true,
                                        ..Default::default()
                                    }),
                                )
                                .await
                                .map_err(anyhow::Error::from)
                        })
                        .await;
                    }
                }
            }
            Err(e) => {
                warn!("孤儿容器清理失败: {}", e);
            }
        }
    }

    /// 获取镜像的池引用。
    #[allow(dead_code)]
    pub async fn get_pool(&self, image: &str) -> Option<Arc<Pool>> {
        let normalized = Self::normalize_image(image);
        self.pools.lock().await.get(&normalized).cloned()
    }

    /// 获取所有池（用于健康检查等）。
    #[allow(dead_code)]
    pub async fn all_pools(&self) -> Vec<Arc<Pool>> {
        self.pools.lock().await.values().cloned().collect()
    }

    /// 触发优雅关闭。
    pub async fn shutdown(&self) {
        self.shutting_down.store(true, Ordering::SeqCst);
        self.shutdown_token.cancel();
        // 通知所有等待者
        let pools = self.pools.lock().await;
        for pool in pools.values() {
            pool.notify.notify_waiters();
        }
    }

    /// 获取内部 Docker 客户端引用。
    pub fn docker(&self) -> &Docker {
        &self.docker
    }

    /// 获取池配置引用。
    pub fn config(&self) -> &PoolConfig {
        &self.config
    }

    /// 检查池管理器是否正在关闭中。
    ///
    /// 关闭中时应避免创建新容器或阻塞等待。
    #[allow(dead_code)]
    pub fn is_shutting_down(&self) -> bool {
        self.shutting_down.load(Ordering::SeqCst)
    }

    /// 获取泄漏容器列表（用于 metrics）。
    #[allow(dead_code)]
    pub fn leaked_containers(&self) -> &Mutex<Vec<String>> {
        &self.leaked_containers
    }

    /// 获取累积任务数（counter）。
    #[allow(dead_code)]
    pub fn tasks_total(&self) -> usize {
        self.tasks_total.load(Ordering::Relaxed)
    }

    /// 获取累积错误数（counter）。
    #[allow(dead_code)]
    pub fn errors_total(&self) -> usize {
        self.errors_total.load(Ordering::Relaxed)
    }

    /// 获取累积超时数（counter）。
    #[allow(dead_code)]
    pub fn timeouts_total(&self) -> usize {
        self.timeouts_total.load(Ordering::Relaxed)
    }

    /// 获取累积池 miss 数（counter）。
    #[allow(dead_code)]
    pub fn pool_misses_total(&self) -> usize {
        self.pool_misses_total.load(Ordering::Relaxed)
    }

    /// 增加任务计数。
    pub fn inc_tasks_total(&self) {
        self.tasks_total.fetch_add(1, Ordering::Relaxed);
    }

    /// 增加错误计数。
    pub fn inc_errors_total(&self) {
        self.errors_total.fetch_add(1, Ordering::Relaxed);
    }

    /// 增加超时计数。
    pub fn inc_timeouts_total(&self) {
        self.timeouts_total.fetch_add(1, Ordering::Relaxed);
    }

    /// 增加池 miss 计数。
    pub fn inc_pool_misses_total(&self) {
        self.pool_misses_total.fetch_add(1, Ordering::Relaxed);
    }

    // ── 后台任务 ──────────────────────────────────

    /// 启动健康检查循环。
    ///
    /// 每 5 秒检查空闲容器状态，移除异常容器并触发回补。
    #[allow(dead_code)]
    pub async fn start_health_check(self: &Arc<Self>) {
        let manager = self.clone();
        tokio::spawn(async move {
            let idle_timeout = std::time::Duration::from_secs(manager.config.idle_timeout_secs);

            loop {
                if manager.is_shutting_down() {
                    break;
                }

                tokio::time::sleep(std::time::Duration::from_secs(HEALTH_CHECK_INTERVAL_SECS))
                    .await;

                let pool_refs: Vec<Arc<Pool>> =
                    manager.pools.lock().await.values().cloned().collect();
                for pool in &pool_refs {
                    // 空闲超时清理
                    let expired = pool.collect_idle_timeout(idle_timeout).await;
                    for id in &expired {
                        if let Err(e) = manager
                            .timed_bollard(10, "remove_container", async {
                                let cid = id.clone();
                                manager
                                    .docker
                                    .remove_container(
                                        &cid,
                                        Some(bollard::query_parameters::RemoveContainerOptions {
                                            force: true,
                                            ..Default::default()
                                        }),
                                    )
                                    .await
                                    .map_err(anyhow::Error::from)
                            })
                            .await
                        {
                            warn!(
                                task = "health_check",
                                action = "remove_idle_timeout",
                                container_id = id,
                                error = %e,
                                "健康检查: 移除超时空闲容器失败"
                            );
                            manager.leaked_containers.lock().await.push(id.clone());
                        } else {
                            info!(
                                task = "health_check",
                                action = "remove_idle_timeout",
                                container_id = id,
                                "健康检查: 移除空闲超时容器"
                            );
                        }
                    }

                    // 检查空闲容器是否存活
                    let idle_containers: Vec<String> = {
                        let guard = pool.containers.read().await;
                        guard
                            .values()
                            .filter(|s| s.status == ContainerStatus::Idle)
                            .map(|s| s.container_id.clone())
                            .collect()
                    };

                    for id in &idle_containers {
                        let inspect_result = manager
                            .timed_bollard(5, "inspect_container", async {
                                let cid = id.clone();
                                manager
                                    .docker
                                    .inspect_container(
                                        &cid,
                                        None::<bollard::query_parameters::InspectContainerOptions>,
                                    )
                                    .await
                                    .map_err(anyhow::Error::from)
                            })
                            .await;
                        match inspect_result {
                            Ok(info) => {
                                let running =
                                    info.state.as_ref().and_then(|s| s.running).unwrap_or(false);
                                if !running {
                                    warn!(
                                        task = "health_check",
                                        action = "container_anomaly",
                                        container_id = id,
                                        image = pool.image(),
                                        "健康检查: 容器异常（非 running）"
                                    );
                                    let mut guard = pool.containers.write().await;
                                    if let Some(state) = guard.get_mut(id) {
                                        if state.status == ContainerStatus::Idle {
                                            state.status = ContainerStatus::Dead;
                                        }
                                    }
                                }
                            }
                            Err(e) => {
                                warn!(
                                    task = "health_check",
                                    action = "inspect_failed",
                                    container_id = id,
                                    image = pool.image(),
                                    error = %e,
                                    "健康检查: inspect 失败"
                                );
                                let mut guard = pool.containers.write().await;
                                if let Some(state) = guard.get_mut(id) {
                                    if state.status == ContainerStatus::Idle {
                                        state.status = ContainerStatus::Dead;
                                    }
                                }
                            }
                        }
                    }

                    // 清理 Dead 容器
                    let dead = pool.collect_dead().await;
                    for id in &dead {
                        if let Err(e) = manager
                            .timed_bollard(10, "remove_container_dead", async {
                                let cid = id.clone();
                                manager
                                    .docker
                                    .remove_container(
                                        &cid,
                                        Some(bollard::query_parameters::RemoveContainerOptions {
                                            force: true,
                                            ..Default::default()
                                        }),
                                    )
                                    .await
                                    .map_err(anyhow::Error::from)
                            })
                            .await
                        {
                            warn!(
                                task = "health_check",
                                action = "remove_dead_failed",
                                container_id = id,
                                image = pool.image(),
                                error = %e,
                                "健康检查: 移除 Dead 容器失败"
                            );
                            manager.leaked_containers.lock().await.push(id.clone());
                        } else {
                            info!(
                                task = "health_check",
                                action = "remove_dead",
                                container_id = id,
                                image = pool.image(),
                                "健康检查: 已移除 Dead 容器"
                            );
                        }
                    }

                    // 清理泄漏容器（rm -f 全失败的）
                    let mut leaked = manager.leaked_containers.lock().await;
                    let retry: Vec<String> = leaked.drain(..).collect();
                    drop(leaked);
                    for id in &retry {
                        if (manager
                            .timed_bollard(10, "remove_container_leak", async {
                                let cid = id.clone();
                                manager
                                    .docker
                                    .remove_container(
                                        &cid,
                                        Some(bollard::query_parameters::RemoveContainerOptions {
                                            force: true,
                                            ..Default::default()
                                        }),
                                    )
                                    .await
                                    .map_err(anyhow::Error::from)
                            })
                            .await)
                            .is_ok()
                        {
                            info!(
                                task = "health_check",
                                action = "leak_cleanup_success",
                                container_id = id,
                                "健康检查: 清理泄漏容器成功"
                            );
                        } else {
                            warn!(
                                task = "health_check",
                                action = "leak_cleanup_retry",
                                container_id = id,
                                "健康检查: 泄漏容器清理失败，加入重试列表"
                            );
                            // 重试失败，加回列表下次再试
                            manager.leaked_containers.lock().await.push(id.clone());
                        }
                    }
                }
            }
        });
    }

    /// 启动后台任务（健康检查 + Supervisor + Scaler + Metrics 服务）。
    #[allow(dead_code)]
    pub async fn start_background_tasks(self: &Arc<Self>) {
        self.start_health_check().await;
        self.start_supervisor();
        self.start_scaler().await;
        self.start_metrics_server().await;
    }

    /// 启动 metrics HTTP 服务。
    #[allow(dead_code)]
    async fn start_metrics_server(self: &Arc<Self>) {
        let pool = self.clone();
        let bind = self.config.metrics_bind.clone();
        let auth_token = self.config.metrics_auth_token.clone();
        tokio::spawn(async move {
            metrics::start_metrics_server(pool, Some(bind), auth_token).await;
        });
    }

    /// 启动 Scaler 扩缩容循环。
    #[allow(dead_code)]
    async fn start_scaler(self: &Arc<Self>) {
        let pools = self.all_pools().await;
        if pools.is_empty() {
            return;
        }
        let config = Arc::new(self.config.clone());

        // 创建事件通道
        let (tx, rx) = mpsc::unbounded_channel();
        {
            let mut scaler_tx = self.scaler_tx.lock().await;
            *scaler_tx = Some(tx);
        }

        let scaler = scaler::Scaler::new(pools, config);
        tokio::spawn(async move {
            scaler.start(Some(rx)).await;
        });
    }

    /// 输出池状态快照日志（指标替代 Prometheus）。
    #[allow(dead_code)]
    async fn log_pool_metrics(self: &Arc<Self>) {
        let pools = self.pools.lock().await;
        for pool in pools.values() {
            let (idle, in_flight, total) = pool.snapshot().await;
            let target = pool.target_depth();
            info!(
                metrics = true,
                image = pool.image(),
                target = target,
                idle = idle,
                in_flight = in_flight,
                total = total,
                "pool_status"
            );
        }
    }

    /// Supervisor 后台任务：每 30s 检查状态 + 输出指标。
    #[allow(dead_code)]
    fn start_supervisor(self: &Arc<Self>) {
        let manager = self.clone();
        tokio::spawn(async move {
            loop {
                if manager.is_shutting_down() {
                    break;
                }
                tokio::time::sleep(std::time::Duration::from_secs(SUPERVISOR_INTERVAL_SECS)).await;

                // 输出池指标
                manager.log_pool_metrics().await;

                // 检查池状态一致性
                let pools = manager.pools.lock().await;
                for pool in pools.values() {
                    let (idle, in_flight, _) = pool.snapshot().await;
                    let target = pool.target_depth();

                    if idle + in_flight > target * 2 {
                        warn!(
                            task = "supervisor",
                            action = "pool_anomaly",
                            image = pool.image(),
                            idle = idle,
                            in_flight = in_flight,
                            target = target,
                            "Supervisor: 池容器数异常"
                        );
                    }
                }
                drop(pools);
            }
        });
    }
}

// ── 辅助函数 ──────────────────────────────────────────

impl PoolManager {
    /// 执行带超时的 bollard API 调用。
    async fn timed_bollard<F, T>(&self, timeout_secs: u64, op_name: &str, future: F) -> Result<T>
    where
        F: std::future::Future<Output = Result<T>>,
    {
        with_timeout(timeout_secs, op_name, future).await
    }

    /// 向 Scaler 发送事件（忽略失败，Scaler 未启动时静默丢弃）。
    async fn send_scaler_event(&self, event: ScalerEvent) {
        let guard = self.scaler_tx.lock().await;
        if let Some(ref tx) = *guard {
            let _ = tx.send(event);
        }
    }
}

/// 对 bollard API 调用添加超时。
///
/// - 轻量操作（update, inspect）→ 5s
/// - exec 操作 → 沿用例行超时
/// - rm -f 操作 → 10s
pub async fn with_timeout<F, T>(duration_secs: u64, op: &str, future: F) -> Result<T>
where
    F: std::future::Future<Output = Result<T>>,
{
    match tokio::time::timeout(std::time::Duration::from_secs(duration_secs), future).await {
        Ok(result) => result,
        Err(_elapsed) => {
            let err_msg = format!("bollard API 超时 ({} > {}s)", op, duration_secs);
            error!("{}", err_msg);
            Err(anyhow::anyhow!(err_msg))
        }
    }
}
