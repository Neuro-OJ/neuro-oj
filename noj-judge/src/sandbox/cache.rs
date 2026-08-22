//! 支持包磁盘缓存模块。
//!
//! 内容寻址缓存：以 SHA-256 校验和为文件名，LRU 淘汰策略。
//!
//! 缓存文件路径：`{SUPPORT_CACHE_DIR}/{checksum_sha256}.zip`
//!
//! 超出 `max_items` 或 `max_mb` 时按 atime 淘汰最旧文件。

use anyhow::{Context, Result};
use filetime::FileTime;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::SystemTime;
use tokio::fs;
use tracing::{info, warn};

/// 同一进程内共享缓存目录锁。
///
/// SupportPackageCache 按任务创建，实例级 Mutex 无法覆盖并发评测；按目录
/// 复用锁可以把读、写、扫描和淘汰串行化，避免不同任务同时根据过期快照删除文件。
static CACHE_LOCKS: OnceLock<Mutex<HashMap<PathBuf, Arc<tokio::sync::Mutex<()>>>>> =
    OnceLock::new();

fn cache_lock_for(dir: &Path) -> Arc<tokio::sync::Mutex<()>> {
    let locks = CACHE_LOCKS.get_or_init(|| Mutex::new(HashMap::new()));
    // 锁表只保存目录对应的异步锁；即使某个调用方 panic 导致 std Mutex
    // poisoning，也应继续复用已有锁，而不是让后续评测全部崩溃。
    let mut locks = locks.lock().unwrap_or_else(|poisoned| {
        warn!("缓存锁表发生 poisoning，继续使用已有锁状态");
        poisoned.into_inner()
    });
    locks
        .entry(dir.to_path_buf())
        .or_insert_with(|| Arc::new(tokio::sync::Mutex::new(())))
        .clone()
}

/// 支持包磁盘缓存。
pub struct SupportPackageCache {
    /// 缓存目录路径。
    dir: PathBuf,
    /// 最大文件数。
    max_items: usize,
    /// 最大磁盘占用（字节）。
    max_bytes: u64,
    /// 同一缓存目录内所有实例共享的异步锁。
    lock: Arc<tokio::sync::Mutex<()>>,
}

impl SupportPackageCache {
    /// 创建新的缓存实例。
    ///
    /// 自动创建缓存目录（如不存在）。
    pub async fn new(dir: impl Into<PathBuf>, max_items: usize, max_mb: u64) -> Result<Self> {
        let dir = dir.into();
        fs::create_dir_all(&dir).await.context("创建缓存目录失败")?;

        Ok(Self {
            lock: cache_lock_for(&dir),
            dir,
            max_items,
            max_bytes: max_mb.saturating_mul(1024 * 1024),
        })
    }

    /// 尝试从缓存读取支持包。
    ///
    /// 返回 `Some(Vec<u8>)` 表示缓存命中，`None` 表示未命中。
    pub async fn get(&self, checksum: &str) -> Result<Option<Vec<u8>>> {
        if checksum.is_empty() {
            return Ok(None);
        }
        validate_checksum_key(checksum)?;

        let _guard = self.lock.lock().await;

        let path = self.cache_path(checksum);
        if !path.exists() {
            return Ok(None);
        }

        let data = fs::read(&path).await.context("读取缓存文件失败")?;
        self.touch(&path).await?;

        info!("支持包缓存命中: checksum={}, size={}", checksum, data.len());

        Ok(Some(data))
    }

    /// 写入缓存。
    ///
    /// 写入后检查是否超出上限，超出时按 LRU 淘汰。
    pub async fn set(&self, checksum: &str, data: &[u8]) -> Result<()> {
        if checksum.is_empty() {
            return Ok(());
        }
        validate_checksum_key(checksum)?;

        let _guard = self.lock.lock().await;

        let path = self.cache_path(checksum);

        // 原子写入：tmp 文件 + rename
        let tmp_path = self
            .dir
            .join(format!(".{}.tmp.{}", checksum, uuid::Uuid::new_v4()));
        fs::write(&tmp_path, data)
            .await
            .context("写入缓存临时文件失败")?;
        fs::rename(&tmp_path, &path)
            .await
            .context("重命名缓存文件失败")?;
        self.touch(&path).await?;

        info!("支持包缓存写入: checksum={}, size={}", checksum, data.len());

        // 淘汰检查
        self.evict_if_needed().await?;

        Ok(())
    }

    /// 检查是否超出上限，超出时按 atime 淘汰。
    ///
    /// 调用方必须持有 `self.lock`；读写和淘汰需要共享同一临界区。
    async fn evict_if_needed(&self) -> Result<()> {
        let mut entries = self.scan_entries().await?;
        let total_bytes = entries.iter().map(|e| e.size_bytes).sum::<u64>();

        // 检查文件数上限
        if entries.len() <= self.max_items && total_bytes <= self.max_bytes {
            return Ok(());
        }

        // 按 atime 排序（最旧在前）
        entries.sort_by_key(|e| e.last_accessed);

        // 计算需要释放的空间
        let mut to_remove = Vec::new();
        let mut remaining_count = entries.len();
        let mut remaining_bytes = total_bytes;

        for entry in &entries {
            if remaining_count <= self.max_items && remaining_bytes <= self.max_bytes {
                break;
            }
            to_remove.push(entry.path.clone());
            remaining_count -= 1;
            remaining_bytes = remaining_bytes.saturating_sub(entry.size_bytes);
        }

        for path in &to_remove {
            if let Err(e) = fs::remove_file(path).await {
                warn!("淘汰缓存文件失败: {:?}, error: {}", path, e);
            }
        }

        if !to_remove.is_empty() {
            info!("支持包缓存淘汰: 移除 {} 个文件", to_remove.len());
        }

        Ok(())
    }

    /// 扫描缓存目录，返回文件条目。
    async fn scan_entries(&self) -> Result<Vec<CacheEntry>> {
        let mut entries = Vec::new();
        let mut read_dir = fs::read_dir(&self.dir).await?;

        while let Some(entry) = read_dir.next_entry().await? {
            let path = entry.path();
            if path.extension().and_then(|s| s.to_str()) != Some("zip") {
                continue;
            }
            let metadata = entry.metadata().await?;
            if !metadata.is_file() {
                continue;
            }
            entries.push(CacheEntry {
                path,
                size_bytes: metadata.len(),
                last_accessed: metadata
                    .accessed()
                    .or_else(|_| metadata.modified())
                    .unwrap_or(SystemTime::UNIX_EPOCH),
            });
        }

        Ok(entries)
    }

    async fn touch(&self, path: &std::path::Path) -> Result<()> {
        let path = path.to_path_buf();
        tokio::task::spawn_blocking(move || {
            let now = FileTime::now();
            filetime::set_file_atime(&path, now)
        })
        .await
        .context("更新缓存时间戳任务失败")?
        .context("更新缓存时间戳失败")?;
        Ok(())
    }

    /// 获取缓存文件路径。
    fn cache_path(&self, checksum: &str) -> PathBuf {
        self.dir.join(format!("{}.zip", checksum))
    }
}

/// 缓存目录中的文件条目。
struct CacheEntry {
    path: PathBuf,
    /// 文件大小（字节）。
    size_bytes: u64,
    /// 最后访问时间。
    last_accessed: SystemTime,
}

fn validate_checksum_key(checksum: &str) -> Result<()> {
    if checksum.len() != 64 || !checksum.as_bytes().iter().all(|b| b.is_ascii_hexdigit()) {
        anyhow::bail!("非法 checksum_sha256: {}", checksum);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;
    use tempfile::TempDir;

    #[tokio::test]
    async fn test_cache_miss() {
        let tmp = TempDir::new().unwrap();
        let cache = SupportPackageCache::new(tmp.path(), 10, 100).await.unwrap();
        let result = cache
            .get("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa")
            .await
            .unwrap();
        assert!(result.is_none());
    }

    #[tokio::test]
    async fn test_cache_set_and_get() {
        let tmp = TempDir::new().unwrap();
        let cache = SupportPackageCache::new(tmp.path(), 10, 100).await.unwrap();

        let data = b"test zip data";
        cache
            .set(
                "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
                data,
            )
            .await
            .unwrap();

        let result = cache
            .get("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa")
            .await
            .unwrap();
        assert_eq!(result, Some(data.to_vec()));
    }

    #[tokio::test]
    async fn test_cache_empty_checksum_skipped() {
        let tmp = TempDir::new().unwrap();
        let cache = SupportPackageCache::new(tmp.path(), 10, 100).await.unwrap();

        cache.set("", b"data").await.unwrap();
        let result = cache.get("").await.unwrap();
        assert!(result.is_none());
    }

    #[tokio::test]
    async fn test_cache_evict_by_count() {
        let tmp = TempDir::new().unwrap();
        let cache = SupportPackageCache::new(tmp.path(), 2, 100).await.unwrap();

        cache
            .set(
                "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
                b"data1",
            )
            .await
            .unwrap();
        cache
            .set(
                "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
                b"data2",
            )
            .await
            .unwrap();
        cache
            .set(
                "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
                b"data3",
            )
            .await
            .unwrap();

        // 最多保留 2 个文件
        let mut read_dir = fs::read_dir(tmp.path()).await.unwrap();
        let mut _count = 0usize;
        while let Ok(Some(_)) = read_dir.next_entry().await {
            _count += 1;
        }
        // 至少有一个 .zip 文件被淘汰
        let mut read_dir = fs::read_dir(tmp.path()).await.unwrap();
        let mut zip_count = 0usize;
        while let Ok(Some(entry)) = read_dir.next_entry().await {
            if entry.path().extension().and_then(|s| s.to_str()) == Some("zip") {
                zip_count += 1;
            }
        }
        assert!(zip_count <= 2);
    }

    #[tokio::test]
    async fn test_cache_invalid_checksum_rejected() {
        let tmp = TempDir::new().unwrap();
        let cache = SupportPackageCache::new(tmp.path(), 10, 100).await.unwrap();

        let err = cache.set("../bad", b"data").await.unwrap_err();
        assert!(err.to_string().contains("非法 checksum_sha256"));
    }

    #[tokio::test]
    async fn test_cache_evict_by_size_keeps_most_recent() {
        let tmp = TempDir::new().unwrap();
        let cache = SupportPackageCache::new(tmp.path(), 10, 1).await.unwrap();

        let one_mb = vec![1u8; 600 * 1024];
        cache
            .set(
                "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
                &one_mb,
            )
            .await
            .unwrap();
        tokio::time::sleep(std::time::Duration::from_millis(20)).await;
        cache
            .set(
                "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
                &one_mb,
            )
            .await
            .unwrap();

        assert!(cache
            .get("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa")
            .await
            .unwrap()
            .is_none());
        assert!(cache
            .get("bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb")
            .await
            .unwrap()
            .is_some());
    }

    #[tokio::test]
    async fn test_concurrent_cache_instances_share_eviction_lock() {
        let tmp = TempDir::new().unwrap();
        let mut tasks = Vec::new();

        // 每个任务都创建独立的 cache 实例，模拟 runner 的实际调用方式；
        // 只有按目录共享的锁才能覆盖这些实例之间的淘汰竞态。
        for index in 0..8u8 {
            let cache = Arc::new(SupportPackageCache::new(tmp.path(), 2, 1).await.unwrap());
            tasks.push(tokio::spawn(async move {
                let checksum = format!("{:064x}", index as u64 + 1);
                cache.set(&checksum, &[index; 1024]).await
            }));
        }

        for task in tasks {
            task.await.unwrap().unwrap();
        }

        let verifier = SupportPackageCache::new(tmp.path(), 2, 1).await.unwrap();
        let entries = verifier.scan_entries().await.unwrap();
        assert_eq!(entries.len(), 2);
    }
}
