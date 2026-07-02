//! 简化容器池模块。
//!
//! PoolManager 统一管理所有评测容器的生命周期。
//! 采用固定池大小 + 懒回补模式，无自动扩缩容。

pub mod copy;
pub mod exec;

use std::collections::VecDeque;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use anyhow::Result;
use bollard::Docker;
use futures_util::FutureExt;
use futures_util::StreamExt;
use tokio::sync::RwLock;
use tokio_util::sync::CancellationToken;
use tracing::{error, info, warn};

use crate::config::PoolConfig;

// ── 常量 ───────────────────────────────────────────────

/// 健康检查间隔（秒）。
const HEALTH_CHECK_INTERVAL_SECS: u64 = 5;
/// docker rm -f 重试延迟序列（毫秒）。
const RM_F_RETRY_DELAYS: &[u64] = &[100, 500, 2000];

// ── 空闲容器条目 ────────────────────────────────────────

/// 空闲队列中的容器条目。
#[derive(Debug, Clone)]
struct IdleEntry {
    container_id: String,
    idle_since: Instant,
}

// ── 每个镜像的独立池 ────────────────────────────────────

/// 单个镜像的固定池。
pub struct Pool {
    /// 空闲容器队列（FIFO）
    idle: RwLock<VecDeque<IdleEntry>>,
    /// 当前最小容器数
    min_size: usize,
    /// 当前最大容器数
    max_size: usize,
    /// 当前忙碌（已分配）容器数
    in_flight: AtomicUsize,
    /// 该池的镜像名
    image: String,
}

impl Pool {
    /// 创建一个新的池。
    fn new(image: String, min_size: usize, max_size: usize) -> Self {
        Self {
            idle: RwLock::new(VecDeque::new()),
            min_size,
            max_size,
            in_flight: AtomicUsize::new(0),
            image,
        }
    }

    /// 获取一个空闲容器（快速路径）。
    pub async fn acquire(&self) -> Option<String> {
        let mut guard = self.idle.write().await;
        if let Some(entry) = guard.pop_front() {
            self.in_flight.fetch_add(1, Ordering::SeqCst);
            Some(entry.container_id)
        } else {
            None
        }
    }

    /// 将新建容器推入空闲队列。
    pub async fn push_idle(&self, container_id: String) {
        let mut guard = self.idle.write().await;
        guard.push_back(IdleEntry {
            container_id,
            idle_since: Instant::now(),
        });
    }

    /// in_flight 计数器 -1。
    pub fn dec_in_flight(&self) {
        self.in_flight.fetch_sub(1, Ordering::SeqCst);
    }

    /// 获取空闲容器数。
    pub async fn idle_count(&self) -> usize {
        self.idle.read().await.len()
    }

    /// 获取 in_flight。
    pub fn in_flight(&self) -> usize {
        self.in_flight.load(Ordering::SeqCst)
    }

    /// 获取池对应的镜像名。
    pub fn image(&self) -> &str {
        &self.image
    }

    /// 获取最小池大小。
    pub fn min_size(&self) -> usize {
        self.min_size
    }

    /// 获取最大池大小。
    pub fn max_size(&self) -> usize {
        self.max_size
    }

    /// 移除并返回最旧的空闲容器 ID（超出 max_size 时收缩使用）。
    async fn pop_oldest_idle(&self) -> Option<String> {
        let mut guard = self.idle.write().await;
        guard.pop_front().map(|e| e.container_id)
    }

    /// 收集空闲超时的容器 ID（仅当超过 min_size 时）。
    async fn collect_expired(&self, idle_timeout: Duration) -> Vec<String> {
        let mut guard = self.idle.write().await;
        let now = Instant::now();
        let keep_extra = self.min_size;
        let mut expired = Vec::new();

        while guard.len() > keep_extra {
            if let Some(front) = guard.front() {
                if now.duration_since(front.idle_since) > idle_timeout {
                    if let Some(entry) = guard.pop_front() {
                        expired.push(entry.container_id);
                    }
                } else {
                    break;
                }
            } else {
                break;
            }
        }
        expired
    }

    /// 收集所有空闲容器 ID。
    async fn collect_all_idle(&self) -> Vec<String> {
        self.idle
            .read()
            .await
            .iter()
            .map(|e| e.container_id.clone())
            .collect()
    }

    /// 从空闲队列中移除指定容器。
    async fn remove_idle(&self, container_id: &str) {
        let mut guard = self.idle.write().await;
        guard.retain(|e| e.container_id != container_id);
    }
}

// ── PoolManager ──────────────────────────────────────────

/// 统一容器池管理器。
pub struct PoolManager {
    /// 每个镜像的独立池
    pools: RwLock<Vec<(String, Arc<Pool>)>>,
    /// Docker 客户端
    docker: Docker,
    /// 配置
    config: PoolConfig,
    /// 是否正在关闭
    shutting_down: AtomicBool,
    /// 关闭通知
    shutdown_token: CancellationToken,
    /// 累积任务数（counter 指标）
    tasks_total: AtomicUsize,
    /// 累积错误数（counter 指标）
    errors_total: AtomicUsize,
    /// 累积超时数（counter 指标）
    timeouts_total: AtomicUsize,
}

// ── PoolManager 实现 ────────────────────────────────────

impl PoolManager {
    /// 创建并初始化池管理器。
    pub async fn init(docker: Docker, config: PoolConfig, images: &[String]) -> Result<Arc<Self>> {
        Self::cleanup_orphans(&docker, &config.label_prefix).await;

        let manager = Arc::new(Self {
            pools: RwLock::new(Vec::new()),
            docker,
            config,
            shutting_down: AtomicBool::new(false),
            shutdown_token: CancellationToken::new(),
            tasks_total: AtomicUsize::new(0),
            errors_total: AtomicUsize::new(0),
            timeouts_total: AtomicUsize::new(0),
        });

        for image in images {
            info!("预热镜像: {}", image);

            if let Err(e) = manager.ensure_image_local(image).await {
                warn!("跳过镜像 {}: 拉取失败: {}", image, e);
                continue;
            }

            let normalized = Self::normalize_image(image);
            let pool = Arc::new(Pool::new(
                normalized.clone(),
                manager.config.min_size,
                manager.config.max_size,
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

            manager.pools.write().await.push((normalized, pool));
        }

        info!("容器池初始化完成 (镜像数={})", images.len());
        Ok(manager)
    }

    /// 使用容器执行闭包，闭包返回后自动释放容器。
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
        let id_for_release = id.clone();
        let result = {
            let wrapped = std::panic::AssertUnwindSafe(f(id));
            match wrapped.catch_unwind().await {
                Ok(Ok(val)) => Ok(val),
                Ok(Err(e)) => Err(e),
                Err(panic) => {
                    let msg = panic
                        .downcast_ref::<&str>()
                        .map(|s| s.to_string())
                        .or_else(|| panic.downcast_ref::<String>().cloned())
                        .unwrap_or_else(|| "unknown panic".to_string());
                    Err(anyhow::anyhow!("with_container 闭包 panic: {}", msg))
                }
            }
        };
        self.release(&pool, &id_for_release).await;
        result
    }

    /// 内部 acquire 实现（两路路径）。
    async fn acquire_with_pool(&self, image: &str, memory_mb: u64) -> Result<(String, Arc<Pool>)> {
        let pool = self.get_or_create_pool(image).await?;

        // 快速路径：尝试获取空闲容器
        if let Some(id) = pool.acquire().await {
            if let Err(e) = self.update_container_memory(&id, memory_mb).await {
                pool.dec_in_flight();
                return Err(e);
            }
            return Ok((id, pool.clone()));
        }

        // 慢路径：即时创建新容器
        let id = self.create_container(image).await?;
        if let Err(e) = self.update_container_memory(&id, memory_mb).await {
            self.remove_container_force(&id).await;
            return Err(e);
        }
        Ok((id, pool.clone()))
    }

    /// 释放容器并在空闲队列中回补一个新的。
    pub async fn release(&self, pool: &Arc<Pool>, container_id: &str) {
        self.remove_container_force(container_id).await;

        pool.dec_in_flight();

        // 检查是否需要回补（避免超过 max_size 时还创建新容器）
        let total = pool.idle_count().await + pool.in_flight();
        if total >= pool.max_size() {
            if let Some(oldest) = pool.pop_oldest_idle().await {
                self.remove_container_force(&oldest).await;
            }
            return;
        }

        // 创建新容器回补到空闲队列
        match self.create_container(pool.image()).await {
            Ok(new_id) => {
                pool.push_idle(new_id).await;
            }
            Err(e) => {
                warn!("回补容器失败: image={}, error={}", pool.image(), e);
            }
        }
    }

    /// docker rm -f（带重试）。
    async fn remove_container_force(&self, container_id: &str) {
        for (i, delay_ms) in RM_F_RETRY_DELAYS.iter().enumerate() {
            match self
                .timed_bollard(10, "remove_container", async {
                    self.docker
                        .remove_container(
                            container_id,
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
                Ok(_) => return,
                Err(e) => {
                    if i < RM_F_RETRY_DELAYS.len() - 1 {
                        warn!(
                            "rm -f 失败 (attempt {}/{}): container={}, error={}",
                            i + 1,
                            RM_F_RETRY_DELAYS.len(),
                            container_id,
                            e
                        );
                        tokio::time::sleep(Duration::from_millis(*delay_ms)).await;
                    } else {
                        error!("rm -f 最终失败: container={}, error={}", container_id, e);
                    }
                }
            }
        }
    }

    /// 确保镜像在本地存在。
    async fn ensure_image_local(&self, image: &str) -> Result<()> {
        if self.image_exists_locally(image).await.unwrap_or(false) {
            info!("镜像已存在本地: {}", image);
            return Ok(());
        }
        for attempt in 1..=3 {
            let options = bollard::query_parameters::CreateImageOptions {
                from_image: Some(image.to_string()),
                ..Default::default()
            };
            let mut stream = self.docker.create_image(
                Some(options),
                None,
                None::<bollard::auth::DockerCredentials>,
            );
            let mut ok = false;
            while let Some(result) = stream.next().await {
                if result.is_ok() {
                    ok = true;
                }
            }
            if ok {
                return Ok(());
            }
            warn!("拉取镜像失败 (attempt {}/3): {}", attempt, image);
            tokio::time::sleep(Duration::from_secs(5)).await;
        }
        anyhow::bail!("拉取镜像失败 (已重试 3 次): {}", image);
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

    /// 获取或创建镜像的池。
    async fn get_or_create_pool(&self, image: &str) -> Result<Arc<Pool>> {
        let normalized = Self::normalize_image(image);
        let pools = self.pools.read().await;
        for (name, pool) in pools.iter() {
            if name == &normalized {
                return Ok(pool.clone());
            }
        }
        drop(pools);

        let mut pools = self.pools.write().await;
        for (name, pool) in pools.iter() {
            if name == &normalized {
                return Ok(pool.clone());
            }
        }
        let pool = Arc::new(Pool::new(
            normalized.clone(),
            self.config.min_size,
            self.config.max_size,
        ));
        pools.push((normalized, pool.clone()));
        Ok(pool)
    }

    /// 创建并启动一个评测容器。
    async fn create_container(&self, image: &str) -> Result<String> {
        let options = bollard::query_parameters::CreateContainerOptions {
            ..Default::default()
        };

        let mut labels = std::collections::HashMap::new();
        labels.insert(
            format!("{}.pool", self.config.label_prefix),
            "true".to_string(),
        );

        let nano_cpus = if self.config.cpu > 0.0 {
            Some((self.config.cpu * 1_000_000_000.0) as i64)
        } else {
            None
        };

        let mut tmpfs = std::collections::HashMap::new();
        tmpfs.insert("/tmp".to_string(), "size=256M".to_string());

        let memory_bytes = (self.config.memory_mb as i64) * 1024 * 1024;

        let config = bollard::models::ContainerCreateBody {
            image: Some(image.to_string()),
            cmd: Some(vec!["sleep".to_string(), "infinity".to_string()]),
            labels: Some(labels),
            host_config: Some(bollard::models::HostConfig {
                cap_drop: Some(vec!["ALL".to_string()]),
                security_opt: Some(vec!["no-new-privileges:true".to_string()]),
                privileged: Some(false),
                readonly_rootfs: Some(false),
                network_mode: Some("none".to_string()),
                ipc_mode: Some("none".to_string()),
                pids_limit: Some(256),
                tmpfs: Some(tmpfs),
                nano_cpus,
                memory: Some(memory_bytes),
                memory_swap: Some(memory_bytes),
                memory_swappiness: Some(0),
                ..Default::default()
            }),
            ..Default::default()
        };

        let result = with_timeout(30, "create_container", async {
            self.docker
                .create_container(Some(options), config)
                .await
                .map_err(anyhow::Error::from)
        })
        .await?;

        with_timeout(5, "start_container", async {
            self.docker
                .start_container(&result.id, None)
                .await
                .map_err(anyhow::Error::from)
        })
        .await
        .inspect_err(|_e| {
            // 启动失败时清理已创建但未启动的容器
            let _handle = self.remove_container_force_async(&result.id);
        })?;

        Ok(result.id)
    }

    /// 同步版的 remove_container_force（用于创建失败时的清理）。
    fn remove_container_force_async(&self, container_id: &str) -> tokio::task::JoinHandle<()> {
        let docker = self.docker.clone();
        let cid = container_id.to_string();
        tokio::spawn(async move {
            let _ = docker
                .remove_container(
                    &cid,
                    Some(bollard::query_parameters::RemoveContainerOptions {
                        force: true,
                        ..Default::default()
                    }),
                )
                .await;
        })
    }

    /// docker update 调整内存限制。
    async fn update_container_memory(&self, container_id: &str, memory_mb: u64) -> Result<()> {
        let bytes = (memory_mb as i64) * 1024 * 1024;
        let opts = bollard::models::ContainerUpdateBody {
            memory: Some(bytes),
            memory_swap: Some(bytes),
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

    /// 归一化镜像名：剥离 :latest 后缀。
    fn normalize_image(image: &str) -> String {
        if let Some(stripped) = image.strip_suffix(":latest") {
            stripped.to_string()
        } else {
            image.to_string()
        }
    }

    /// 启动后台任务（健康检查 + 指标日志）。
    pub async fn start_background_tasks(self: &Arc<Self>) {
        self.start_health_check().await;
    }

    /// 启动健康检查循环。
    pub async fn start_health_check(self: &Arc<Self>) {
        let manager = self.clone();
        tokio::spawn(async move {
            let idle_timeout = Duration::from_secs(manager.config.idle_timeout_secs);
            let mut loop_count = 0u64;

            loop {
                if manager.shutting_down.load(Ordering::SeqCst) {
                    break;
                }

                tokio::time::sleep(Duration::from_secs(HEALTH_CHECK_INTERVAL_SECS)).await;
                loop_count += 1;

                let pool_refs: Vec<Arc<Pool>> = {
                    let pools = manager.pools.read().await;
                    pools.iter().map(|(_, p)| p.clone()).collect()
                };

                for pool in &pool_refs {
                    // 空闲超时清理
                    let expired = pool.collect_expired(idle_timeout).await;
                    for id in &expired {
                        manager.remove_container_force(id).await;
                        info!("健康检查: 移除空闲超时容器: {}", id);
                    }

                    // Inspect 所有空闲容器
                    let idle_ids = pool.collect_all_idle().await;
                    for id in &idle_ids {
                        let running = manager
                            .timed_bollard(5, "inspect_container", async {
                                let cid = id.clone();
                                let info = manager
                                    .docker
                                    .inspect_container(
                                        &cid,
                                        None::<bollard::query_parameters::InspectContainerOptions>,
                                    )
                                    .await
                                    .map_err(anyhow::Error::from)?;
                                Ok(info.state.and_then(|s| s.running).unwrap_or(false))
                            })
                            .await
                            .unwrap_or(false);

                        if !running {
                            warn!("健康检查: 容器异常, 移除: {}", id);
                            pool.remove_idle(id).await;
                            manager.remove_container_force(id).await;
                        }
                    }
                }

                // 每 6 次循环（~30s）输出一次池状态日志
                if loop_count.is_multiple_of(6) {
                    let pools = manager.pools.read().await;
                    for (image, pool) in pools.iter() {
                        let idle = pool.idle_count().await;
                        let in_flight = pool.in_flight();
                        info!(
                            pool_status = true,
                            image = image,
                            idle = idle,
                            in_flight = in_flight,
                            total = idle + in_flight,
                            min = pool.min_size(),
                            max = pool.max_size(),
                            "pool_status"
                        );
                    }
                }
            }
        });
    }

    /// 触发优雅关闭。
    pub async fn shutdown(&self) {
        self.shutting_down.store(true, Ordering::SeqCst);
        self.shutdown_token.cancel();
    }

    /// 获取内部 Docker 客户端引用。
    pub fn docker(&self) -> &Docker {
        &self.docker
    }

    /// 获取池配置引用。
    pub fn config(&self) -> &PoolConfig {
        &self.config
    }

    /// 检查池管理器是否正在关闭。
    #[allow(dead_code)]
    pub fn is_shutting_down(&self) -> bool {
        self.shutting_down.load(Ordering::SeqCst)
    }

    // ── 计数器（外部 API） ──────────────────────

    #[allow(dead_code)]
    pub fn inc_tasks_total(&self) {
        self.tasks_total.fetch_add(1, Ordering::Relaxed);
    }

    pub fn inc_errors_total(&self) {
        self.errors_total.fetch_add(1, Ordering::Relaxed);
    }

    pub fn inc_timeouts_total(&self) {
        self.timeouts_total.fetch_add(1, Ordering::Relaxed);
    }

    #[allow(dead_code)]
    pub fn tasks_total(&self) -> usize {
        self.tasks_total.load(Ordering::Relaxed)
    }

    #[allow(dead_code)]
    pub fn errors_total(&self) -> usize {
        self.errors_total.load(Ordering::Relaxed)
    }

    #[allow(dead_code)]
    pub fn timeouts_total(&self) -> usize {
        self.timeouts_total.load(Ordering::Relaxed)
    }

    /// 获取所有池（用于 metrics 或外部访问）。
    #[allow(dead_code)]
    pub async fn all_pools(&self) -> Vec<Arc<Pool>> {
        self.pools
            .read()
            .await
            .iter()
            .map(|(_, p)| p.clone())
            .collect()
    }

    /// 获取指定镜像的池引用。
    #[allow(dead_code)]
    pub async fn get_pool(&self, image: &str) -> Option<Arc<Pool>> {
        let normalized = Self::normalize_image(image);
        self.pools
            .read()
            .await
            .iter()
            .find(|(name, _)| name == &normalized)
            .map(|(_, p)| p.clone())
    }

    /// 清理孤儿容器。
    async fn cleanup_orphans(docker: &Docker, label_prefix: &str) {
        let filter_label = format!("{}.pool=true", label_prefix);
        let options = bollard::query_parameters::ListContainersOptions {
            all: true,
            filters: Some(std::collections::HashMap::from([(
                "label".to_string(),
                vec![filter_label],
            )])),
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

    /// 带超时的 bollard API 调用。
    async fn timed_bollard<F, T>(&self, timeout_secs: u64, op_name: &str, future: F) -> Result<T>
    where
        F: std::future::Future<Output = Result<T>>,
    {
        with_timeout(timeout_secs, op_name, future).await
    }
}

// ── 辅助函数 ──────────────────────────────────────────

/// 对 bollard API 调用添加超时。
pub async fn with_timeout<F, T>(duration_secs: u64, op: &str, future: F) -> Result<T>
where
    F: std::future::Future<Output = Result<T>>,
{
    match tokio::time::timeout(Duration::from_secs(duration_secs), future).await {
        Ok(result) => result,
        Err(_elapsed) => {
            let err_msg = format!("bollard API 超时 ({} > {}s)", op, duration_secs);
            error!("{}", err_msg);
            Err(anyhow::anyhow!(err_msg))
        }
    }
}
