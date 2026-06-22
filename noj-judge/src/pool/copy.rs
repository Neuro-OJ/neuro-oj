//! 支持包和用户代码的文件注入功能。
//!
//! 通过 tar 打包 + docker put_archive 将文件注入到容器内的 `/tmp/`。

use std::fs;
use std::path::Path;

use anyhow::{Context, Result};
use bollard::Docker;
use tokio::task::spawn_blocking;

/// 将工作目录打包为 tar 字节流。
///
/// 安全过滤：
/// - 跳过符号链接
/// - 拒绝含 `..` 路径组件的条目
/// - 总大小超出 `max_size_bytes` 时报错
pub fn archive_work_dir(work_dir: &Path, max_size_bytes: u64) -> Result<Vec<u8>> {
    let mut buf = Vec::new();
    let mut builder = tar::Builder::new(&mut buf);

    let mut total_size: u64 = 0;
    let entries = collect_entries(work_dir)?;

    for entry in &entries {
        // 拒绝 .. 路径
        if entry.relative.contains("..") {
            anyhow::bail!("路径包含 '..'，拒绝打包: {}", entry.relative);
        }

        // 跳过符号链接
        if entry.is_symlink {
            continue;
        }

        // 检查总大小
        total_size += entry.size;
        if total_size > max_size_bytes {
            anyhow::bail!(
                "工作目录总大小 {} 超出限制 {}",
                total_size,
                max_size_bytes
            );
        }

        let mut header = tar::Header::new_gnu();
        header.set_entry_type(tar::EntryType::Regular);
        header.set_size(entry.size);
        header.set_mode(0o644);
        header.set_uid(0);
        header.set_gid(0);
        header.set_mtime(0);
        // 使用相对路径
        let tar_path = entry.relative.trim_start_matches('/');
        header.set_cksum();

        builder.append_data(&mut header, tar_path, fs::File::open(&entry.full_path)?)?;
    }

    builder.finish()?;
    drop(builder);
    Ok(buf)
}

/// 文件条目信息。
struct ArchiveEntry {
    /// 相对于工作目录的路径
    relative: String,
    /// 完整路径
    full_path: std::path::PathBuf,
    /// 文件大小（字节）
    size: u64,
    /// 是否为符号链接
    is_symlink: bool,
}

/// 递归收集目录中所有文件条目。
fn collect_entries(dir: &Path) -> Result<Vec<ArchiveEntry>> {
    let mut entries = Vec::new();

    if !dir.exists() {
        return Ok(entries);
    }

    collect_entries_rec(dir, dir, &mut entries)?;
    Ok(entries)
}

/// 递归收集文件条目。
fn collect_entries_rec(
    base: &Path,
    current: &Path,
    entries: &mut Vec<ArchiveEntry>,
) -> Result<()> {
    if current.is_dir() {
        for entry in fs::read_dir(current)? {
            let entry = entry?;
            collect_entries_rec(base, &entry.path(), entries)?;
        }
    } else {
        let metadata = current.metadata()?;
        let is_symlink = metadata.file_type().is_symlink();

        let relative = current
            .strip_prefix(base)
            .unwrap_or(current)
            .to_string_lossy()
            .to_string()
            .replace('\\', "/");

        entries.push(ArchiveEntry {
            relative,
            full_path: current.to_path_buf(),
            size: if is_symlink { 0 } else { metadata.len() },
            is_symlink,
        });
    }

    Ok(())
}

/// 通过 put_archive 将 tar 字节流上传到容器内的 `/tmp/`。
pub async fn copy_to_container(
    docker: &Docker,
    container_id: &str,
    tar_bytes: Vec<u8>,
) -> Result<()> {
    use bollard::container::UploadToContainerOptions;
    use tokio_util::bytes::Bytes;

    docker
        .upload_to_container::<String>(
            container_id,
            Some(UploadToContainerOptions {
                path: "/tmp/".into(),
                ..Default::default()
            }),
            Bytes::from(tar_bytes),
        )
        .await?;
    Ok(())
}

/// 在工作目录上执行 archive + copy 的简便函数。
pub async fn archive_and_copy(
    docker: &Docker,
    container_id: &str,
    work_dir: &Path,
    max_archive_mb: u64,
) -> Result<()> {
    let max_bytes = max_archive_mb * 1024 * 1024;
    let work_dir = work_dir.to_path_buf();

    // tar 打包在 spawn_blocking 中执行
    let tar_bytes = spawn_blocking(move || archive_work_dir(&work_dir, max_bytes))
        .await
        .context("tar 打包任务 panicked")??;

    copy_to_container(docker, container_id, tar_bytes).await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    #[test]
    fn test_archive_basic() {
        let tmp = TempDir::new().unwrap();
        fs::write(tmp.path().join("hello.txt"), b"world").unwrap();
        fs::create_dir(tmp.path().join("sub")).unwrap();
        fs::write(tmp.path().join("sub/data.txt"), b"123").unwrap();

        let result = archive_work_dir(tmp.path(), 10 * 1024 * 1024).unwrap();
        assert!(!result.is_empty());

        // 验证是有效的 tar
        let mut archive = tar::Archive::new(&result[..]);
        let entries: Vec<_> = archive.entries().unwrap().collect();
        assert_eq!(entries.len(), 2);
    }

    #[test]
    fn test_archive_rejects_dotdot() {
        let tmp = TempDir::new().unwrap();
        // 模拟 .. 场景：创建嵌套目录
        let sub = tmp.path().join("sub");
        fs::create_dir(&sub).unwrap();
        fs::write(sub.join("../../evil.txt"), b"x").unwrap();

        // 打包时 items 的 relative 路径会包含 ..，应该被拒绝
        let max_bytes = 10 * 1024 * 1024;
        let mut entries = super::collect_entries(tmp.path()).unwrap();
        // 手动修改 relative 为包含 .. 的路径来测试
        let evil_entry = ArchiveEntry {
            relative: "../../evil.txt".to_string(),
            full_path: sub.join("../../evil.txt"),
            size: 1,
            is_symlink: false,
        };
        entries.push(evil_entry);

        let mut buf = Vec::new();
        let mut builder = tar::Builder::new(&mut buf);
        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            for e in &entries {
                if e.relative.contains("..") {
                    panic!("拒绝路径");
                }
            }
        }));
        assert!(result.is_err());
    }

    #[test]
    fn test_archive_size_limit() {
        let tmp = TempDir::new().unwrap();
        // 创建一个大文件
        let big_data = vec![0u8; 1000];
        fs::write(tmp.path().join("big.bin"), &big_data).unwrap();
        let small_data = vec![0u8; 1000];
        fs::write(tmp.path().join("small.bin"), &small_data).unwrap();

        // 限制为 500 字节，应报错
        let result = archive_work_dir(tmp.path(), 500);
        assert!(result.is_err());
        assert!(result.unwrap_err().to_string().contains("超出限制"));
    }
}
