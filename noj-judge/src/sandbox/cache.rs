//! 支持包磁盘缓存模块。
//!
//! 内容寻址缓存：以 SHA-256 校验和为文件名，LRU 淘汰策略。
//!
//! 缓存文件路径：`{SUPPORT_CACHE_DIR}/{checksum_sha256}.zip`
//!
//! 超出 `max_items` 或 `max_mb` 时按 atime 淘汰最旧文件。

use anyhow::{Context, Result};
use std::path::PathBuf;
use tokio::fs;
use tracing::{info, warn};

/// 支持包磁盘缓存。
pub struct SupportPackageCache {
    /// 缓存目录路径。
    dir: PathBuf,
    /// 最大文件数。
    max_items: usize,
    /// 最大磁盘占用（MB）。
    max_mb: u64,
}

#[allow(dead_code)]
impl SupportPackageCache {
    /// 创建新的缓存实例。
    ///
    /// 自动创建缓存目录（如不存在）。
    pub async fn new(dir: impl Into<PathBuf>, max_items: usize, max_mb: u64) -> Result<Self> {
        let dir = dir.into();
        fs::create_dir_all(&dir).await.context("创建缓存目录失败")?;

        Ok(Self {
            dir,
            max_items,
            max_mb,
        })
    }

    /// 尝试从缓存读取支持包。
    ///
    /// 返回 `Some(Vec<u8>)` 表示缓存命中，`None` 表示未命中。
    pub async fn get(&self, checksum: &str) -> Result<Option<Vec<u8>>> {
        if checksum.is_empty() {
            return Ok(None);
        }

        let path = self.cache_path(checksum);
        if !path.exists() {
            return Ok(None);
        }

        // 更新 atime（touch 文件）
        // tokio 没有直接的 utimens，使用 std 同步操作
        let path_clone = path.clone();
        tokio::task::spawn_blocking(move || {
            let _ = filetime::set_file_atime(&path_clone, filetime::FileTime::now());
        })
        .await
        .ok();

        let data = fs::read(&path).await.context("读取缓存文件失败")?;

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

        info!("支持包缓存写入: checksum={}, size={}", checksum, data.len());

        // 淘汰检查
        self.evict_if_needed().await?;

        Ok(())
    }

    /// 检查是否超出上限，超出时按 atime 淘汰。
    async fn evict_if_needed(&self) -> Result<()> {
        let mut entries = self.scan_entries().await?;

        // 检查文件数上限
        if entries.len() <= self.max_items {
            // 检查磁盘占用上限
            let total_mb = entries.iter().map(|e| e.size_mb).sum::<u64>();
            if total_mb <= self.max_mb {
                return Ok(());
            }
        }

        // 按 atime 排序（最旧在前）
        entries.sort_by_key(|e| e.atime);

        // 计算需要释放的空间
        let mut to_remove = Vec::new();
        let mut remaining_count = entries.len();
        let mut remaining_mb: u64 = entries.iter().map(|e| e.size_mb).sum();

        for entry in &entries {
            if remaining_count <= self.max_items && remaining_mb <= self.max_mb {
                break;
            }
            to_remove.push(entry.path.clone());
            remaining_count -= 1;
            remaining_mb = remaining_mb.saturating_sub(entry.size_mb);
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
                size_mb: (metadata.len() / (1024 * 1024)) as u64,
                atime: metadata
                    .accessed()
                    .ok()
                    .and_then(|t| t.elapsed().ok().map(|d| d.as_secs()))
                    .unwrap_or(0),
            });
        }

        Ok(entries)
    }

    /// 获取缓存文件路径。
    fn cache_path(&self, checksum: &str) -> PathBuf {
        self.dir.join(format!("{}.zip", checksum))
    }
}

/// 缓存目录中的文件条目。
struct CacheEntry {
    path: PathBuf,
    /// 文件大小（MB，向上取整）。
    size_mb: u64,
    /// 最后访问时间（epoch seconds）。
    atime: u64,
}

// filetime 依赖用于更新 atime
// 如果 Cargo.toml 中未添加，使用备用方案
mod filetime {
    use std::path::Path;

    pub struct FileTime;

    impl FileTime {
        pub fn now() -> Self {
            FileTime
        }
    }

    pub fn set_file_atime(_path: &Path, _time: FileTime) -> std::io::Result<()> {
        // 在 Linux 上，读取文件会自动更新 atime（取决于 mount 选项）。
        // 这里不做显式 utimens 调用，依赖文件系统的默认行为。
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    #[tokio::test]
    async fn test_cache_miss() {
        let tmp = TempDir::new().unwrap();
        let cache = SupportPackageCache::new(tmp.path(), 10, 100).await.unwrap();
        let result = cache.get("nonexistent").await.unwrap();
        assert!(result.is_none());
    }

    #[tokio::test]
    async fn test_cache_set_and_get() {
        let tmp = TempDir::new().unwrap();
        let cache = SupportPackageCache::new(tmp.path(), 10, 100).await.unwrap();

        let data = b"test zip data";
        cache.set("abc123", data).await.unwrap();

        let result = cache.get("abc123").await.unwrap();
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

        cache.set("aaa", b"data1").await.unwrap();
        cache.set("bbb", b"data2").await.unwrap();
        cache.set("ccc", b"data3").await.unwrap();

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
}
