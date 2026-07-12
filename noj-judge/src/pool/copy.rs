//! 支持包和用户代码的文件注入功能。
//!
//! 通过 tar 打包 + docker exec `tar xf -` 将文件注入到容器内的 `/tmp/`。

use std::fs;
use std::path::Path;

use anyhow::{Context, Result};
use bollard::Docker;
use tokio::task::spawn_blocking;
use tracing::{debug, info, warn};

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
            anyhow::bail!("工作目录总大小 {} 超出限制 {}", total_size, max_size_bytes);
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
fn collect_entries_rec(base: &Path, current: &Path, entries: &mut Vec<ArchiveEntry>) -> Result<()> {
    if current.is_dir() {
        for entry in fs::read_dir(current)? {
            let entry = entry?;
            collect_entries_rec(base, &entry.path(), entries)?;
        }
    } else {
        let metadata = current.symlink_metadata()?;
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

/// 通过 docker exec + tar 将文件注入到容器内的 `/tmp/`。
///
/// 通过 exec `tar xf - -C /tmp/` + 管道 stdin 传输 tar 数据。
/// 这样可以在 `readonly_rootfs=true` 的前提下仍然稳定写入 `/tmp` tmpfs。
pub async fn copy_to_container(
    docker: &Docker,
    container_id: &str,
    tar_bytes: Vec<u8>,
) -> Result<()> {
    use bollard::exec::{CreateExecOptions, StartExecResults};
    use futures_util::StreamExt;
    use tokio::io::AsyncWriteExt;

    // 验证容器正在运行
    docker
        .inspect_container(
            container_id,
            None::<bollard::query_parameters::InspectContainerOptions>,
        )
        .await
        .map_err(|e| anyhow::anyhow!("copy_to_container: 容器 {} 不可用: {}", container_id, e))?
        .state
        .as_ref()
        .and_then(|s| s.running)
        .filter(|&r| r)
        .ok_or_else(|| anyhow::anyhow!("copy_to_container: 容器 {} 未在运行", container_id))?;

    // 创建 exec: tar xf - -C /tmp/（从 stdin 读取 tar）
    let exec = docker
        .create_exec(
            container_id,
            CreateExecOptions {
                cmd: Some(vec![
                    "tar".to_string(),
                    "xf".to_string(),
                    "-".to_string(),
                    "-C".to_string(),
                    "/tmp/".to_string(),
                ]),
                attach_stdin: Some(true),
                attach_stdout: Some(true),
                attach_stderr: Some(true),
                ..Default::default()
            },
        )
        .await
        .context("创建 tar exec 失败")?;

    // 启动 exec
    let result = docker
        .start_exec(&exec.id, None)
        .await
        .context("启动 tar exec 失败")?;

    if let StartExecResults::Attached { mut output, input } = result {
        // 通过 stdin 管道写入 tar 数据
        let mut input_writer = input;
        input_writer.write_all(&tar_bytes).await?;
        let _ = input_writer.shutdown().await;

        // 读取 exec 输出
        let mut stderr = String::new();
        while let Some(chunk) = output.next().await {
            if let Ok(bollard::container::LogOutput::StdErr { message }) = chunk {
                stderr.push_str(&String::from_utf8_lossy(&message));
            }
        }

        if !stderr.is_empty() {
            warn!("文件注入 stderr: {}", stderr);
        }

        let inspect = docker
            .inspect_exec(&exec.id)
            .await
            .context("检查 tar exec 状态失败")?;
        let exit_code = inspect.exit_code.unwrap_or(-1);
        if exit_code != 0 {
            anyhow::bail!("文件注入失败 (exit_code={}): {}", exit_code, stderr.trim());
        }
    }

    // 验证文件
    if let Ok(exec) = docker
        .create_exec(
            container_id,
            CreateExecOptions {
                cmd: Some(vec![
                    "ls".to_string(),
                    "-la".to_string(),
                    "/tmp/".to_string(),
                ]),
                attach_stdout: Some(true),
                attach_stderr: Some(true),
                ..Default::default()
            },
        )
        .await
    {
        if let Ok(StartExecResults::Attached { mut output, .. }) =
            docker.start_exec(&exec.id, None).await
        {
            let mut out = String::new();
            while let Some(chunk) = output.next().await {
                if let Ok(bollard::container::LogOutput::StdOut { message }) = chunk {
                    out.push_str(&String::from_utf8_lossy(&message));
                }
            }
            info!("容器 {} /tmp/ 内容:\n{}", &container_id[..12], out);
        }
    }

    debug!("文件已注入到容器 {} 的 /tmp/", container_id);
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
    let wd_path = work_dir.to_path_buf();
    let wd_str = wd_path.to_string_lossy().to_string();

    // 验证工作目录存在且非空
    if !wd_path.exists() {
        anyhow::bail!("archive_and_copy: 工作目录不存在: {}", wd_str);
    }

    let entries = tokio::task::spawn_blocking({
        let wd = wd_path.clone();
        move || -> Result<Vec<String>> {
            let mut names = Vec::new();
            for entry in std::fs::read_dir(&wd)? {
                let entry = entry?;
                names.push(entry.file_name().to_string_lossy().to_string());
            }
            Ok(names)
        }
    })
    .await
    .context("读取工作目录 panicked")?
    .with_context(|| format!("读取工作目录失败: {}", work_dir.display()))?;

    if entries.is_empty() {
        anyhow::bail!(
            "archive_and_copy: 工作目录为空（没有需要注入的文件）: {}",
            work_dir.display()
        );
    }

    info!(
        "archive_and_copy: 工作目录 {} 包含 {} 个文件: {:?}",
        wd_str,
        entries.len(),
        entries
    );

    // tar 打包在 spawn_blocking 中执行
    let tar_bytes = spawn_blocking(move || archive_work_dir(&wd_path, max_bytes))
        .await
        .context("tar 打包任务 panicked")?
        .with_context(|| format!("打包工作目录失败: {}", wd_str))?;

    copy_to_container(docker, container_id, tar_bytes)
        .await
        .with_context(|| format!("注入文件到容器 {} 失败", container_id))?;

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
    fn test_archive_skips_symlinks() {
        use std::os::unix::fs::symlink;
        let tmp = TempDir::new().unwrap();
        // 创建普通文件
        fs::write(tmp.path().join("real.txt"), b"real content").unwrap();
        // 创建符号链接指向它
        symlink(tmp.path().join("real.txt"), tmp.path().join("link.txt")).unwrap();

        // 打包，符号链接应被排除
        let result = archive_work_dir(tmp.path(), 10 * 1024 * 1024).unwrap();
        let mut archive = tar::Archive::new(&result[..]);
        let entries: Vec<_> = archive.entries().unwrap().collect();
        // 只有一个条目（real.txt），符号链接被跳过
        assert_eq!(entries.len(), 1, "符号链接应被排除在 tar 之外");
        let entry = &entries[0];
        let path = entry.as_ref().unwrap().path().unwrap();
        assert_eq!(path.to_string_lossy(), "real.txt");
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
