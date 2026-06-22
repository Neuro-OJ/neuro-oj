//! 统一容器池模块。
//!
//! PoolManager 替代原有的 Semaphore 并发控制模型。
//! 所有容器（预创建和即时创建）都通过池统一管理。

pub mod copy;
pub mod exec;
mod scaler;

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::Instant;

use anyhow::Result;
use bollard::image::CreateImageOptions;
use bollard::Docker;
use futures_util::StreamExt;
use tokio::sync::{Mutex, Notify, RwLock};
use tokio_util::sync::CancellationToken;
use tracing::{error, info, warn};

use crate::config::PoolConfig;

// ── 容器状态机 ──────────────────────────────────────────

/// 容器生命周期状态。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ContainerStatus {
    /// 就绪，在空闲队列中等待分配
    Idle,
    /// 已分配给某个任务，正在使用
    InUse,
    /// 正在被删除
    Removing,
    /// 健康检查发现异常，等待摘除
    Dead,
}

/// 池中容器的完整状态。
#[derive(Debug, Clone)]
pub struct ContainerState {
    /// Docker 容器 ID
    pub container_id: String,
    /// 当前生命周期状态
    pub status: ContainerStatus,
    /// 进入 Idle 状态的时间戳（用于空闲超时检测）
    pub idle_since: Option<Instant>,
    /// 容器所属镜像名
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
}

impl Pool {
    fn new(image: String, memory_mb: u64, initial_target: usize) -> Self {
        Self {
            containers: RwLock::new(HashMap::new()),
            notify: Notify::new(),
            target_depth: AtomicUsize::new(initial_target),
            in_flight: AtomicUsize::new(0),
            image,
            memory_mb,
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

    /// 触发空闲超时清理和健康检查。
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
    pub async fn len(&self) -> usize {
        self.containers.read().await.len()
    }

    /// 获取 idle 容器数。
    pub async fn idle_count(&self) -> usize {
        let guard = self.containers.read().await;
        guard.values().filter(|s| s.status == ContainerStatus::Idle).count()
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

    pub fn image(&self) -> &str {
        &self.image
    }

    pub fn memory_mb(&self) -> u64 {
        self.memory_mb
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
        });

        // 按镜像初始化池
        for image in &manager.config.images {
            info!("预热镜像: {}", image);

            // docker pull（重试 3 次）
            let mut pulled = false;
            for attempt in 1..=3 {
                let options = CreateImageOptions {
                    from_image: image.clone(),
                    from_src: image.clone(),
                    repo: image.clone(),
                    tag: "latest".to_string(),
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
                warn!("跳过镜像 {}: 拉取失败，任务将使用即时创建路径", image);
                continue;
            }

            let pool = Arc::new(Pool::new(
                image.clone(),
                manager.config.memory_mb,
                manager.config.initial_size,
            ));

            // 创建初始容器
            for i in 0..manager.config.initial_size {
                match manager.create_container(image).await {
                    Ok(container_id) => {
                        pool.push_idle(container_id).await;
                        info!("创建预热容器 [{}/{}] 镜像={}", i + 1, manager.config.initial_size, image);
                    }
                    Err(e) => {
                        warn!("创建预热容器失败: {}: {}", image, e);
                    }
                }
            }

            manager.pools.lock().await.insert(image.clone(), pool);
        }

        info!("容器池初始化完成 (镜像数={})", manager.config.images.len());
        Ok(manager)
    }

    /// 获取或即时创建容器。
    ///
    /// 优先从池中获取空闲容器。
    /// 若无空闲且未达上限，即时创建新容器。
    /// 若已达上限，阻塞等待。
    pub async fn acquire(&self, image: &str, memory_mb: u64) -> Result<String> {
        let pool = self.get_or_create_pool(image).await?;

        // 快速路径：尝试获取空闲容器
        if let Some(id) = pool.acquire().await {
            self.update_container_memory(&id, memory_mb).await?;
            return Ok(id);
        }

        // 池空：检查是否可即时创建
        if pool.in_flight() < pool.target_depth() {
            let id = self.create_container(image).await?;
            pool.mark_in_use(&id).await;
            // 快速扩容触发器：排队时立即扩容
            if pool.target_depth() < self.config.max_size {
                pool.set_target_depth(
                    pool.target_depth() + 1,
                    self.config.min_size,
                    self.config.max_size,
                );
                info!("快速扩容: {} -> {}", image, pool.target_depth());
            }
            self.update_container_memory(&id, memory_mb).await?;
            return Ok(id);
        }

        // 已达上限：阻塞等待
        loop {
            if self.shutting_down.load(Ordering::SeqCst) {
                anyhow::bail!("池管理器正在关闭");
            }
            pool.wait_for_slot().await;
            if let Some(id) = pool.acquire().await {
                self.update_container_memory(&id, memory_mb).await?;
                return Ok(id);
            }
        }
    }

    /// 释放容器。
    ///
    /// 被 ContainerGuard 析构时自动调用。
    pub async fn release(&self, pool: &Arc<Pool>, container_id: &str) {
        // docker rm -f 带退避重试
        let mut success = false;
        let delays = [100, 500, 2000];
        for (i, delay_ms) in delays.iter().enumerate() {
            match self.docker.remove_container(container_id, None::<bollard::container::RemoveContainerOptions>).await {
                Ok(_) => {
                    success = true;
                    break;
                }
                Err(e) => {
                    if i < delays.len() - 1 {
                        warn!("rm -f 失败 (重试 {}/{}): {}: {}", i + 1, delays.len(), container_id, e);
                        tokio::time::sleep(std::time::Duration::from_millis(*delay_ms)).await;
                    } else {
                        error!("rm -f 最终失败: {}: {}", container_id, e);
                        // 加入泄漏追踪（由健康检查定期处理）
                    }
                }
            }
        }

        pool.release(container_id).await;

        // 检查是否需回补
        if success {
            let idle = pool.idle_count().await;
            let target = pool.target_depth();
            if (idle as f64) < (target as f64) * 0.5 {
                let pool = pool.clone();
                let docker = self.docker.clone();
                let image = pool.image().to_string();
                tokio::spawn(async move {
                    match Self::replenish_one(&docker, &image, &pool).await {
                        Ok(id) => info!("回补容器完成: {}", id),
                        Err(e) => warn!("回补容器失败: {}", e),
                    }
                });
            }
        }
    }

    /// 回补一个容器。
    async fn replenish_one(_docker: &Docker, image: &str, pool: &Arc<Pool>) -> Result<String> {
        let client = Docker::connect_with_local_defaults()?;
        let id = Self::create_container_inner(&client, image).await?;
        pool.push_idle(id.clone()).await;
        Ok(id)
    }

    /// 获取或创建镜像的池。
    async fn get_or_create_pool(&self, image: &str) -> Result<Arc<Pool>> {
        let pools = self.pools.lock().await;
        if let Some(pool) = pools.get(image) {
            return Ok(pool.clone());
        }
        // 没有对应池，创建一个新的
        drop(pools); // 释放锁，后面需要重新获取可变锁
        let mut pools = self.pools.lock().await;
        // 检查是否被其他线程创建了
        if let Some(pool) = pools.get(image) {
            return Ok(pool.clone());
        }
        // 没有对应池，创建一个新的
        let pool = Arc::new(Pool::new(
            image.to_string(),
            self.config.memory_mb,
            self.config.initial_size,
        ));
        // 这里简化处理：即时池不预创建容器
        pools.insert(image.to_string(), pool.clone());
        Ok(pool)
    }

    /// 创建容器。
    async fn create_container(&self, image: &str) -> Result<String> {
        Self::create_container_inner(&self.docker, image).await
    }

    async fn create_container_inner(docker: &Docker, image: &str) -> Result<String> {
        use bollard::container::Config;
        use bollard::container::CreateContainerOptions;

        let options = CreateContainerOptions::<String> {
            ..Default::default()
        };

        let mut labels = HashMap::new();
        labels.insert("com.noj.judge.pool".to_string(), "true".to_string());

        let config = Config {
            image: Some(image.to_string()),
            cmd: Some(vec!["sleep".to_string(), "infinity".to_string()]),
            labels: Some(labels),
            host_config: Some(bollard::models::HostConfig {
                cap_drop: Some(vec!["ALL".to_string()]),
                security_opt: Some(vec!["no-new-privileges:true".to_string()]),
                privileged: Some(false),
                readonly_rootfs: Some(true),
                network_mode: Some("none".to_string()),
                ..Default::default()
            }),
            ..Default::default()
        };

        let result = docker.create_container::<String, String>(Some(options), config).await?;
        docker.start_container::<String>(&result.id, None).await?;
        Ok(result.id)
    }

    /// docker update 下调内存限制。
    async fn update_container_memory(&self, container_id: &str, memory_mb: u64) -> Result<()> {
        use bollard::container::UpdateContainerOptions;
        let bytes = (memory_mb as i64) * 1024 * 1024;
        let opts = UpdateContainerOptions::<String> {
            memory: Some(bytes),
            memory_swap: Some(bytes), // 禁用 swap
            memory_swappiness: Some(0),
            ..Default::default()
        };
        self.docker.update_container(container_id, opts).await?;
        Ok(())
    }

    /// 清理孤儿容器。
    async fn cleanup_orphans(docker: &Docker, label_prefix: &str) {
        use bollard::container::ListContainersOptions;
        let filter_label = format!("{}={}", label_prefix, "true");
        let options = ListContainersOptions {
            all: true,
            filters: HashMap::from([(
                "label".to_string(),
                vec![filter_label],
            )]),
            ..Default::default()
        };

        match docker.list_containers(Some(options)).await {
            Ok(containers) => {
                for c in &containers {
                    if let Some(ref id) = c.id {
                        warn!("清理孤儿容器: {}", id);
                        let _ = docker.remove_container(id.as_str(), None::<bollard::container::RemoveContainerOptions>).await;
                    }
                }
            }
            Err(e) => {
                warn!("孤儿容器清理失败: {}", e);
            }
        }
    }

    /// 获取镜像的池引用。
    pub async fn get_pool(&self, image: &str) -> Option<Arc<Pool>> {
        self.pools.lock().await.get(image).cloned()
    }

    /// 获取所有池（用于健康检查等）。
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

    pub fn docker(&self) -> &Docker {
        &self.docker
    }

    pub fn config(&self) -> &PoolConfig {
        &self.config
    }

    pub fn is_shutting_down(&self) -> bool {
        self.shutting_down.load(Ordering::SeqCst)
    }
}
