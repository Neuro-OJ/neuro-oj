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
use tokio::sync::{Notify, RwLock};
use tokio_util::sync::CancellationToken;
use tracing::{error, info, warn};

use crate::config::PoolConfig;
use crate::sandbox::host_config::build_host_config;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AllowedImageMode {
    Exact,
    #[allow(dead_code)]
    AllVersions,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AllowedImage {
    pub image: String,
    pub mode: AllowedImageMode,
}

// ── 常量 ───────────────────────────────────────────────

/// 健康检查间隔（秒）。
const HEALTH_CHECK_INTERVAL_SECS: u64 = 5;

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
    /// 当前总容器数（idle + in_flight）
    total: AtomicUsize,
    /// 该池的镜像名
    image: String,
    /// 容器可用性通知
    notify: Notify,
}

/// 已分配给任务的容器租约。
///
/// 显式调用 `release()` 时同步归还容器；若任务被取消导致租约直接 drop，
/// Drop 会在后台补做 release，避免 shutdown abort 后泄漏 in-use 容器。
pub struct ContainerLease {
    manager: Arc<PoolManager>,
    pool: Arc<Pool>,
    container_id: Option<String>,
}

impl ContainerLease {
    fn new(manager: Arc<PoolManager>, pool: Arc<Pool>, container_id: String) -> Self {
        Self {
            manager,
            pool,
            container_id: Some(container_id),
        }
    }

    pub fn id(&self) -> &str {
        self.container_id.as_deref().unwrap_or("")
    }

    pub async fn release(mut self) {
        if let Some(container_id) = self.container_id.take() {
            self.manager.release(&self.pool, &container_id).await;
        }
    }
}

impl Drop for ContainerLease {
    fn drop(&mut self) {
        let Some(container_id) = self.container_id.take() else {
            return;
        };

        let manager = self.manager.clone();
        let pool = self.pool.clone();
        match tokio::runtime::Handle::try_current() {
            Ok(handle) => {
                handle.spawn(async move {
                    warn!(
                        container_id = %container_id,
                        "容器租约在未显式 release 的情况下被 drop，后台补做清理"
                    );
                    manager.release(&pool, &container_id).await;
                });
            }
            Err(_) => {
                error!(
                    container_id = %container_id,
                    "ContainerLease drop 时无可用 Tokio runtime，容器可能等待下次孤儿清理"
                );
            }
        }
    }
}

impl Pool {
    /// 创建一个新的池。
    fn new(image: String, min_size: usize, max_size: usize) -> Self {
        Self {
            idle: RwLock::new(VecDeque::new()),
            min_size,
            max_size,
            in_flight: AtomicUsize::new(0),
            total: AtomicUsize::new(0),
            image,
            notify: Notify::new(),
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

    /// in_flight 计数器 +1。
    pub fn inc_in_flight(&self) {
        self.in_flight.fetch_add(1, Ordering::SeqCst);
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

    fn try_reserve_slot(&self) -> bool {
        let mut current = self.total.load(Ordering::SeqCst);
        loop {
            if current >= self.max_size {
                return false;
            }
            match self.total.compare_exchange(
                current,
                current + 1,
                Ordering::SeqCst,
                Ordering::SeqCst,
            ) {
                Ok(_) => return true,
                Err(actual) => current = actual,
            }
        }
    }

    fn add_prewarmed_slot(&self) {
        self.total.fetch_add(1, Ordering::SeqCst);
    }

    fn release_slot(&self) {
        self.total.fetch_sub(1, Ordering::SeqCst);
    }

    fn notify_available(&self) {
        self.notify.notify_waiters();
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
    async fn remove_idle(&self, container_id: &str) -> bool {
        let mut guard = self.idle.write().await;
        let before = guard.len();
        guard.retain(|e| e.container_id != container_id);
        before != guard.len()
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
    /// 允许使用的镜像白名单规则。
    allowed_images: Vec<AllowedImage>,
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
    pub async fn init(
        docker: Docker,
        config: PoolConfig,
        images: &[AllowedImage],
    ) -> Result<Arc<Self>> {
        Self::cleanup_orphans(&docker, &config.label_prefix).await;

        let manager = Arc::new(Self {
            pools: RwLock::new(Vec::new()),
            docker,
            config,
            allowed_images: images.to_vec(),
            shutting_down: AtomicBool::new(false),
            shutdown_token: CancellationToken::new(),
            tasks_total: AtomicUsize::new(0),
            errors_total: AtomicUsize::new(0),
            timeouts_total: AtomicUsize::new(0),
        });

        for allowed in images {
            let image = &allowed.image;
            info!("预热镜像: {}", image);

            if let Err(e) = manager.ensure_image_local(image).await {
                warn!("跳过镜像 {}: 拉取失败: {}", image, e);
                continue;
            }

            let normalized = Self::pool_key(image);
            let pool = Arc::new(Pool::new(
                normalized.clone(),
                manager.config.min_size,
                manager.config.max_size,
            ));

            for i in 0..manager.config.initial_size.min(manager.config.max_size) {
                match manager.create_container(image).await {
                    Ok(container_id) => {
                        pool.add_prewarmed_slot();
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

        info!("容器池初始化完成 (镜像规则数={})", images.len());
        Ok(manager)
    }

    /// 使用容器执行闭包，闭包返回后自动释放容器。
    #[allow(dead_code)]
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
        let lease = self.acquire_container(image, memory_mb).await?;
        let id = lease.id().to_string();
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
        lease.release().await;
        result
    }

    /// 获取一个已准备好的容器租约。
    pub async fn acquire_container(
        self: &Arc<Self>,
        image: &str,
        memory_mb: u64,
    ) -> Result<ContainerLease> {
        let (container_id, pool) = self.acquire_with_pool(image, memory_mb).await?;
        Ok(ContainerLease::new(self.clone(), pool, container_id))
    }

    /// 内部 acquire 实现（两路路径）。
    async fn acquire_with_pool(&self, image: &str, memory_mb: u64) -> Result<(String, Arc<Pool>)> {
        let pool = self.get_or_create_pool(image).await?;

        loop {
            let notified = pool.notify.notified();

            // 快速路径：尝试获取空闲容器
            if let Some(id) = pool.acquire().await {
                if let Err(e) = self.update_container_memory(&id, memory_mb).await {
                    // 容器已从 idle 弹出，需清理避免泄漏
                    self.remove_container_force(&id).await;
                    pool.dec_in_flight();
                    pool.release_slot();
                    pool.notify_available();
                    return Err(e);
                }
                return Ok((id, pool.clone()));
            }

            // 慢路径：仅在总容器数未到上限时即时创建
            if pool.try_reserve_slot() {
                let id = match self.create_container(image).await {
                    Ok(id) => id,
                    Err(e) => {
                        pool.release_slot();
                        pool.notify_available();
                        return Err(e);
                    }
                };
                pool.inc_in_flight();
                if let Err(e) = self.update_container_memory(&id, memory_mb).await {
                    self.remove_container_force(&id).await;
                    pool.dec_in_flight();
                    pool.release_slot();
                    pool.notify_available();
                    return Err(e);
                }
                return Ok((id, pool.clone()));
            }

            if self.shutting_down.load(Ordering::SeqCst) {
                anyhow::bail!("judge 正在关闭，拒绝分配新容器");
            }

            tokio::select! {
                _ = notified => {}
                _ = self.shutdown_token.cancelled() => {
                    anyhow::bail!("judge 正在关闭，拒绝分配新容器");
                }
            }
        }
    }

    /// 释放容器并在空闲队列中回补一个新的。
    pub async fn release(&self, pool: &Arc<Pool>, container_id: &str) {
        self.remove_container_force(container_id).await;

        pool.dec_in_flight();

        if self.shutting_down.load(Ordering::SeqCst) {
            pool.release_slot();
            pool.notify_available();
            return;
        }

        // 替换已消费的容器，保持总量稳定。
        match self.create_container(pool.image()).await {
            Ok(new_id) => {
                pool.push_idle(new_id).await;
                pool.notify_available();
            }
            Err(e) => {
                warn!("回补容器失败: image={}, error={}", pool.image(), e);
                pool.release_slot();
                pool.notify_available();
            }
        }
    }

    /// docker rm -f（带重试）。
    async fn remove_container_force(&self, container_id: &str) {
        crate::sandbox::cleanup::remove_container_force(&self.docker, container_id).await;
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
                match result {
                    Ok(_) => {
                        ok = true;
                    }
                    Err(e) => {
                        warn!("拉取镜像流错误 (attempt {}/3): {}", attempt, e);
                        ok = false;
                        break;
                    }
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
                    .any(|tag| Self::matches_local_image_reference(tag, image))
            })),
            Err(e) => {
                warn!("检查本地镜像失败: {}: {}", image, e);
                Err(e)
            }
        }
    }

    /// 获取或创建镜像的池。
    async fn get_or_create_pool(&self, image: &str) -> Result<Arc<Pool>> {
        let normalized = Self::pool_key(image);
        if !self.is_image_allowed(image) {
            anyhow::bail!("镜像不在白名单中: {}", image);
        }
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

        let memory_bytes = (self.config.memory_mb as i64) * 1024 * 1024;

        let mut tmpfs = std::collections::HashMap::new();
        tmpfs.insert("/tmp", "size=256M");

        let mut host_config = build_host_config(memory_bytes, tmpfs, true);
        host_config.nano_cpus = nano_cpus;

        let config = bollard::models::ContainerCreateBody {
            image: Some(image.to_string()),
            cmd: Some(vec!["sleep".to_string(), "infinity".to_string()]),
            labels: Some(labels),
            host_config: Some(host_config),
            ..Default::default()
        };

        let result = match with_timeout(30, "create_container", async {
            self.docker
                .create_container(Some(options.clone()), config.clone())
                .await
                .map_err(anyhow::Error::from)
        })
        .await
        {
            Ok(result) => result,
            Err(e) if Self::is_missing_image_error(&e) => {
                warn!("创建容器时镜像未就绪，尝试即时拉取: {}: {}", image, e);
                self.ensure_image_local(image).await?;
                with_timeout(30, "create_container_retry", async {
                    self.docker
                        .create_container(Some(options), config)
                        .await
                        .map_err(anyhow::Error::from)
                })
                .await?
            }
            Err(e) => return Err(e),
        };

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
            crate::sandbox::cleanup::remove_container_force(&docker, &cid).await;
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

    /// 池 key：仅将 `:latest` 与无 tag 视为等价。
    fn pool_key(image: &str) -> String {
        if let Some(stripped) = image.strip_suffix(":latest") {
            stripped.to_string()
        } else {
            image.to_string()
        }
    }

    fn strip_image_tag(name: &str) -> &str {
        let last_slash = name.rfind('/').unwrap_or(0);
        let last_colon = name.rfind(':');
        match last_colon {
            Some(idx) if idx > last_slash => &name[..idx],
            _ => name,
        }
    }

    fn has_explicit_tag(image: &str) -> bool {
        let last_segment = image.rsplit('/').next().unwrap_or(image);
        last_segment.contains(':')
    }

    fn matches_local_image_reference(local_tag: &str, requested: &str) -> bool {
        if Self::has_explicit_tag(requested) {
            local_tag == requested
        } else {
            local_tag == requested || local_tag == format!("{}:latest", requested)
        }
    }

    fn is_missing_image_error(error: &anyhow::Error) -> bool {
        let msg = error.to_string().to_ascii_lowercase();
        msg.contains("no such image")
            || msg.contains("not found")
            || msg.contains("pull access denied")
    }

    fn is_image_allowed(&self, image: &str) -> bool {
        self.allowed_images
            .iter()
            .any(|allowed| Self::allowed_image_matches(image, allowed))
    }

    fn allowed_image_matches(image: &str, allowed: &AllowedImage) -> bool {
        match allowed.mode {
            AllowedImageMode::Exact => image == allowed.image,
            AllowedImageMode::AllVersions => {
                Self::strip_image_tag(image) == Self::strip_image_tag(&allowed.image)
            }
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
                        pool.release_slot();
                        pool.notify_available();
                        info!("健康检查: 移除空闲超时容器: {}", id);
                    }

                    // Inspect 所有空闲容器
                    let idle_ids = pool.collect_all_idle().await;
                    for id in &idle_ids {
                        let inspect_result = manager
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
                            .await;

                        match inspect_result {
                            Ok(true) => { /* 容器正常 */ }
                            Ok(false) => {
                                warn!("健康检查: 容器异常, 移除: {}", id);
                                if pool.remove_idle(id).await {
                                    manager.remove_container_force(id).await;
                                    pool.release_slot();
                                    pool.notify_available();
                                }
                            }
                            Err(e) => {
                                warn!("健康检查: inspect 失败, 跳过: {}: {}", id, e);
                            }
                        }
                    }
                }

                // 每 6 次循环（~30s）输出一次池状态日志
                #[allow(clippy::manual_is_multiple_of)]
                if loop_count % 6 == 0 {
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

    #[allow(dead_code)]
    pub async fn cleanup_idle_containers(&self) {
        let pools = self.all_pools().await;
        for pool in &pools {
            let idle_ids = pool.collect_all_idle().await;
            for id in &idle_ids {
                if pool.remove_idle(id).await {
                    self.remove_container_force(id).await;
                    pool.release_slot();
                }
            }
            pool.notify_available();
        }
    }

    #[allow(dead_code)]
    /// 强制清理所有带 pool 标签的容器（含 idle / in-use 残留）。
    pub async fn cleanup_all_containers(&self) {
        self.cleanup_idle_containers().await;
        Self::cleanup_orphans(&self.docker, &self.config.label_prefix).await;
    }

    /// 获取内部 Docker 客户端引用。
    #[allow(dead_code)]
    pub fn docker(&self) -> &Docker {
        &self.docker
    }

    /// 获取池配置引用。
    #[allow(dead_code)]
    pub fn config(&self) -> &PoolConfig {
        &self.config
    }

    /// 检查池管理器是否正在关闭。
    #[allow(dead_code)]
    pub fn is_shutting_down(&self) -> bool {
        self.shutting_down.load(Ordering::SeqCst)
    }
    #[allow(dead_code)]
    /// 返回关闭令牌副本，供外部后台任务监听优雅关闭。
    pub fn shutdown_token(&self) -> CancellationToken {
        self.shutdown_token.clone()
    }

    // ── 计数器（外部 API） ──────────────────────

    #[allow(dead_code)]
    pub fn inc_tasks_total(&self) {
        self.tasks_total.fetch_add(1, Ordering::Relaxed);
    }

    #[allow(dead_code)]
    pub fn inc_errors_total(&self) {
        self.errors_total.fetch_add(1, Ordering::Relaxed);
    }

    #[allow(dead_code)]
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
        let normalized = Self::pool_key(image);
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

#[cfg(test)]
mod tests {
    use super::{AllowedImage, AllowedImageMode, PoolManager};

    #[test]
    fn test_allowed_image_exact_requires_full_match() {
        let allowed = AllowedImage {
            image: "noj-judge-python:3.12".to_string(),
            mode: AllowedImageMode::Exact,
        };
        assert!(PoolManager::allowed_image_matches(
            "noj-judge-python:3.12",
            &allowed
        ));
        assert!(!PoolManager::allowed_image_matches(
            "noj-judge-python:latest",
            &allowed
        ));
    }

    #[test]
    fn test_allowed_image_all_versions_matches_tag_variants() {
        let allowed = AllowedImage {
            image: "registry.local/oj/noj-judge-python:3.12".to_string(),
            mode: AllowedImageMode::AllVersions,
        };
        assert!(PoolManager::allowed_image_matches(
            "registry.local/oj/noj-judge-python:latest",
            &allowed
        ));
        assert!(PoolManager::allowed_image_matches(
            "registry.local/oj/noj-judge-python:v1.0",
            &allowed
        ));
        assert!(!PoolManager::allowed_image_matches(
            "ubuntu:latest",
            &allowed
        ));
        assert!(!PoolManager::allowed_image_matches(
            "evil.local/other/noj-judge-python:latest",
            &allowed
        ));
    }

    #[test]
    fn test_matches_local_image_reference_respects_explicit_tags() {
        assert!(PoolManager::matches_local_image_reference(
            "noj-judge-python:latest",
            "noj-judge-python"
        ));
        assert!(!PoolManager::matches_local_image_reference(
            "noj-judge-python:v1.0",
            "noj-judge-python"
        ));
        assert!(PoolManager::matches_local_image_reference(
            "noj-judge-python:v1.0",
            "noj-judge-python:v1.0"
        ));
    }
}
