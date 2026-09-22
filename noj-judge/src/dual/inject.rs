//! 容器文件注入原语（双容器 / prediction 路径共用）。
//!
//! 两种注入方式：
//! - [`inject_file_to_container`] / [`inject_support_package_to_evaluator`]：内容已在
//!   内存（zip 解压结果 / 用户代码），整块写 tar 到 `docker exec ... tar xf -`；
//! - [`inject_file_stream_to_container`]：宿主文件可达多 GB，用有界 channel 背压，
//!   边读边产出 tar 帧，**整文件绝不一次性读入内存**。
//!
//! 所有路径均经 [`sanitize_rel_path`] 校验，拒绝绝对路径与 `..`，防止 tar 条目
//! 逃出 `/workspace`。

use std::path::Path;
use std::time::Duration;

use anyhow::{Context, Result};
use tokio::io::AsyncWriteExt;
use tracing::info;

use crate::sandbox::container::extract_zip_entries_from_file;

/// 文件注入 exec 完成轮询次数与间隔（50 × 100ms = 5s 上限）。
const INJECT_POLL_ATTEMPTS: u32 = 50;
const INJECT_POLL_INTERVAL_MS: u64 = 100;

/// 校验注入用的容器内相对路径（拒绝绝对路径与 `..` 段）。
///
/// 拒绝：空串、前导 `/`、含 NUL，以及任何空 / `.` / `..` 段，
/// 防止 tar 条目逃出 `/workspace`（路径穿越）。
pub(crate) fn sanitize_rel_path(rel: &str) -> Result<String> {
    if rel.is_empty() || rel.starts_with('/') || rel.contains('\0') {
        anyhow::bail!("非法注入路径: {}", rel);
    }
    for seg in rel.split('/') {
        if seg.is_empty() || seg == "." || seg == ".." {
            anyhow::bail!("非法注入路径: {}", rel);
        }
    }
    Ok(rel.to_string())
}

/// 生成并写出一条 tar 归档数据（同步，供 `spawn_blocking` 中调用）。
///
/// `size` 必须与 `reader` 的字节数一致（调用方已从文件元数据取得）。
/// 使用 [`tar::Builder`] 逐块复制，不把文件整体读入内存；嵌套路径的父目录
/// 由容器侧 `tar xf` 自动创建。
fn write_tar_entry<W: std::io::Write, R: std::io::Read>(
    out: &mut W,
    container_rel_path: &str,
    size: u64,
    reader: R,
) -> std::io::Result<()> {
    let mut header = tar::Header::new_gnu();
    header.set_size(size);
    header.set_mode(0o644);
    header.set_cksum();
    let mut builder = tar::Builder::new(out);
    builder.append_data(&mut header, container_rel_path, reader)?;
    builder.finish()
}

/// 有界 mpsc 的同步写端。
///
/// tar 归档帧由 `spawn_blocking` 中的同步代码产生，但 exec stdin 是异步流；
/// 该适配器把每个块经 `blocking_send` 推入容量为 1 的 channel，channel 满时
/// 阻塞写入线程，形成背压 —— 从而保证**整文件永不被一次性读入内存**。
struct ChannelWriter {
    tx: tokio::sync::mpsc::Sender<Vec<u8>>,
}

impl std::io::Write for ChannelWriter {
    fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
        // `blocking_send` 只能在非 async 上下文调用；本类型仅在 spawn_blocking 中使用。
        self.tx
            .blocking_send(buf.to_vec())
            .map_err(|_| std::io::Error::new(std::io::ErrorKind::BrokenPipe, "注入通道已关闭"))?;
        Ok(buf.len())
    }

    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

/// 流式注入单个宿主文件到容器的 `/workspace/<container_rel_path>`。
///
/// 与 [`inject_file_to_container`] 不同，本函数不把文件内容整体读入内存：
/// 后台 `spawn_blocking` 任务以有界 channel 为背压源，边读宿主文件边产出 tar
/// 帧；异步侧逐块写入 `docker exec ... tar xf -` 的 stdin。适用于多 GB 的预测
/// 结果文件。
///
/// # 超时契约：本函数**不内置任何截止时间（deadline）**
///
/// 复制阶段（`input.write_all` / `rx.recv`）本身没有超时：若容器侧 `tar xf -`
/// 停止读取又不退出（挂起），本 future 会一直等待。因此**调用方必须自行界定
/// 时间上限**（例如用 `tokio::time::timeout` 包裹本 future）。prediction 编排
/// 路径复用启动期的 30s 截止时间；本函数只保证在通道关闭时以 BrokenPipe 结束
/// 后台写入线程，而**不负责**时间上限。
///
/// prediction 编排路径是本函数的唯一调用方；现已由 `runner::evaluate_with_cpu_limit`
/// 分派接入，故不再需要 `#[allow(dead_code)]`。
pub(crate) async fn inject_file_stream_to_container(
    docker: &bollard::Docker,
    container_id: &str,
    host_path: &Path,
    container_rel_path: &str,
) -> Result<()> {
    let rel = sanitize_rel_path(container_rel_path)?;

    // 先取文件与大小（廉价），但**在 exec 就绪前不启动** tar 生产任务：
    // 若 create_exec/start_exec 失败则直接返回，不会残留阻塞在 channel 上的线程。
    let host_file = tokio::fs::File::open(host_path)
        .await
        .with_context(|| format!("打开待注入文件失败: {}", host_path.display()))?
        .into_std()
        .await;
    let size = host_file
        .metadata()
        .with_context(|| format!("读取待注入文件元数据失败: {}", host_path.display()))?
        .len();

    let exec = docker
        .create_exec(
            container_id,
            bollard::models::ExecConfig {
                cmd: Some(vec![
                    "sh".to_string(),
                    "-c".to_string(),
                    "tar xf - -C /workspace".to_string(),
                ]),
                attach_stdin: Some(true),
                attach_stdout: Some(false),
                attach_stderr: Some(false),
                ..Default::default()
            },
        )
        .await
        .context("创建注入 exec 失败")?;

    let started = docker.start_exec(&exec.id, None).await?;
    let mut input = match started {
        bollard::exec::StartExecResults::Attached { input, .. } => input,
        bollard::exec::StartExecResults::Detached => {
            anyhow::bail!("注入 exec 不应进入 Detached 模式（已请求 attach）")
        }
    };

    // 容量 1：writer 每产出一块就必须等待异步侧消费，内存占用与文件大小无关。
    let (tx, mut rx) = tokio::sync::mpsc::channel::<Vec<u8>>(1);
    let rel_for_task = rel.clone();
    let writer_task = tokio::task::spawn_blocking(move || -> Result<()> {
        let mut writer = ChannelWriter { tx };
        write_tar_entry(&mut writer, &rel_for_task, size, host_file)
            .with_context(|| format!("流式生成 tar 归档失败: {}", rel_for_task))
    });

    let mut copy_result: Result<()> = Ok(());
    while let Some(bytes) = rx.recv().await {
        if let Err(e) = input.write_all(&bytes).await.context("写入容器 stdin 失败") {
            copy_result = Err(e);
            break;
        }
    }
    if copy_result.is_ok() {
        copy_result = input.shutdown().await.context("关闭注入 stdin 失败");
    }

    // 显式丢弃接收端：若上面提前出错退出，仍阻塞在 `blocking_send` 的写入线程
    // 会立刻收到 BrokenPipe 而结束，`writer_task.await` 因此不会死锁。
    drop(rx);

    // 无论写入成败都等待后台任务收尾，避免线程泄漏；异步侧错误优先上报
    // （后台任务常因通道关闭而报 BrokenPipe，那只是前者的后果）。
    let writer_result = writer_task.await.context("tar 写入任务 panic")?;
    copy_result?;
    writer_result?;

    for _ in 0..INJECT_POLL_ATTEMPTS {
        let inspect = docker.inspect_exec(&exec.id).await?;
        if let Some(code) = inspect.exit_code {
            if code != 0 {
                anyhow::bail!("注入文件 {} 失败（exit_code={}）", rel, code);
            }
            return Ok(());
        }
        tokio::time::sleep(Duration::from_millis(INJECT_POLL_INTERVAL_MS)).await;
    }
    anyhow::bail!("注入文件超时")
}

/// 注入支持包（zip）到 Evaluator 容器的 /workspace 目录。
///
/// 先同步提取 zip 中所有文件到内存，再逐个异步注入到容器。
pub(crate) async fn inject_support_package_to_evaluator(
    docker: &bollard::Docker,
    container_id: &str,
    zip_path: &Path,
) -> Result<()> {
    // 直接以磁盘文件作为 zip 读取源，避免先把整个 zip 读进内存再 to_vec 拷贝。
    // ZipFile 不是 Send，因此仍在 spawn_blocking 中做同步解压，但输入是文件流。
    let entries = tokio::task::spawn_blocking({
        let path = zip_path.to_path_buf();
        move || extract_zip_entries_from_file(&path)
    })
    .await
    .context("spawn_blocking 提取 zip 失败")??;

    // 异步逐个注入到容器（目录条目由 tar 解压自动创建，无需注入）
    for entry in &entries {
        if entry.is_dir {
            continue;
        }
        // 只传文件名（相对路径），因为 docker exec 的 tar 已 -C /workspace
        inject_file_to_container(docker, container_id, &entry.file_name, &entry.data)
            .await
            .context(format!("注入支持包文件 {} 失败", entry.file_name))?;
        info!("已注入支持包文件: {}", entry.file_name);
    }

    info!("支持包注入完成 (共 {} 个文件)", entries.len());
    Ok(())
}

/// 使用 `tar | docker exec tar xf` 模式，注入文件到容器。
pub(crate) async fn inject_file_to_container(
    docker: &bollard::Docker,
    container_id: &str,
    file_name: &str,
    content: &[u8],
) -> Result<()> {
    // 构造 tar in-memory
    let mut header = tar::Header::new_gnu();
    header.set_size(content.len() as u64);
    header.set_mode(0o644);
    header.set_cksum();

    let mut tar_buf: Vec<u8> = Vec::new();
    {
        let mut builder = tar::Builder::new(&mut tar_buf);
        builder.append_data(&mut header, file_name, content)?;
        builder.finish()?;
    }

    // docker exec tar xf - -C /workspace
    let exec = docker
        .create_exec(
            container_id,
            bollard::models::ExecConfig {
                cmd: Some(vec![
                    "sh".to_string(),
                    "-c".to_string(),
                    "tar xf - -C /workspace".to_string(),
                ]),
                attach_stdin: Some(true),
                attach_stdout: Some(false),
                attach_stderr: Some(false),
                ..Default::default()
            },
        )
        .await
        .context("创建 inject exec 失败")?;

    let started = docker.start_exec(&exec.id, None).await?;
    if let bollard::exec::StartExecResults::Attached { mut input, .. } = started {
        input.write_all(&tar_buf).await?;
        input.shutdown().await?;
    }

    // 等 exec 完成（简化处理：用 inspect_exec 轮询直到退出）
    // 轮询上限 50 次 × 100ms = 5s；退出码非 0 时视为注入失败。
    for _ in 0..INJECT_POLL_ATTEMPTS {
        let inspect = docker.inspect_exec(&exec.id).await?;
        if let Some(code) = inspect.exit_code {
            if code != 0 {
                anyhow::bail!("注入文件 {} 失败（exit_code={}）", file_name, code);
            }
            return Ok(());
        }
        tokio::time::sleep(Duration::from_millis(INJECT_POLL_INTERVAL_MS)).await;
    }
    anyhow::bail!("注入文件超时")
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 注入路径净化：只接受不含绝对路径 / `..` / `.` / 空段的相对路径。
    #[test]
    fn test_sanitize_rel_path_rejects_traversal() {
        assert!(sanitize_rel_path("prediction/pred.csv").is_ok());
        assert_eq!(
            sanitize_rel_path("prediction/pred.csv").unwrap(),
            "prediction/pred.csv"
        );
        assert!(sanitize_rel_path("../etc/passwd").is_err());
        assert!(sanitize_rel_path("pred/../../x").is_err());
        assert!(sanitize_rel_path("/abs").is_err());
        // 边界：空串、NUL、空段 / `.` / `..` 段
        assert!(sanitize_rel_path("").is_err());
        assert!(sanitize_rel_path("a\0b").is_err());
        assert!(sanitize_rel_path("a//b").is_err());
        assert!(sanitize_rel_path("a/./b").is_err());
        assert!(sanitize_rel_path(".").is_err());
        assert!(sanitize_rel_path("..").is_err());
        assert!(sanitize_rel_path("a/").is_err());
    }

    /// 流式 tar 组帧：单个条目、支持嵌套相对路径，输出是合法 tar 归档。
    #[test]
    fn test_write_tar_entry_frames_nested_path() {
        use std::io::Read;

        let mut buf: Vec<u8> = Vec::new();
        write_tar_entry(&mut buf, "prediction/pred.csv", 5, &b"hello"[..]).unwrap();

        let mut archive = tar::Archive::new(&buf[..]);
        let mut entries = archive.entries().unwrap();
        let mut entry = entries.next().expect("应有一个条目").unwrap();
        assert_eq!(
            entry.path().unwrap().to_string_lossy(),
            "prediction/pred.csv"
        );
        let mut content = String::new();
        entry.read_to_string(&mut content).unwrap();
        assert_eq!(content, "hello");
        assert!(entries.next().is_none(), "不应再有其他条目");
    }

    /// 有界背压契约（无 Docker）：直接驱动 [`ChannelWriter`]，证明容量 1 的 channel
    /// 确实把「整文件读入内存」限制为「至多 1 块在途」。
    ///
    /// 若把容量改大（回归），本测试的 `rx.len() == 1` 断言会失败；
    /// 若 channel 关闭后写入线程不结束（挂起），`join` 会失败。
    #[test]
    fn test_channel_writer_applies_bounded_backpressure_and_broken_pipe() {
        use std::io::Write;

        // 容量 1：与 `inject_file_stream_to_container` 内部保持一致。
        let (tx, rx) = tokio::sync::mpsc::channel::<Vec<u8>>(1);
        const CHUNKS: usize = 64;
        const CHUNK: &[u8] = b"12345678";

        std::thread::scope(|scope| {
            let producer = scope.spawn(move || {
                let mut writer = ChannelWriter { tx };
                for i in 0..CHUNKS {
                    match writer.write(CHUNK) {
                        Ok(n) => assert_eq!(n, CHUNK.len()),
                        // 接收端被 drop 后必须立刻以 BrokenPipe 结束，而不是挂起。
                        Err(e) => {
                            assert_eq!(
                                e.kind(),
                                std::io::ErrorKind::BrokenPipe,
                                "第 {} 块写入错误: {:?}",
                                i,
                                e
                            );
                            return i;
                        }
                    }
                }
                // 无消费者时不可能写完全部块：容量 1 只能容纳 1 块，第 2 次
                // blocking_send 必然阻塞。
                unreachable!("无消费者时 ChannelWriter 不应完成全部 {} 块写入", CHUNKS);
            });

            // 等生产者填满容量后阻塞。
            let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
            while rx.is_empty() && std::time::Instant::now() < deadline {
                std::thread::sleep(std::time::Duration::from_millis(1));
            }
            assert_eq!(
                rx.len(),
                1,
                "无消费者时 channel 中最多只能有 1 块（容量 1），实测 {}",
                rx.len()
            );

            // 保持阻塞一小段时间：确认生产者卡住而非继续产出（内存与文件大小无关）。
            std::thread::sleep(std::time::Duration::from_millis(50));
            assert!(
                !producer.is_finished(),
                "channel 满后写入线程应保持阻塞，不得继续产出"
            );
            assert_eq!(rx.len(), 1, "阻塞期间不得再推入数据");

            // 丢弃接收端：阻塞中的写入线程必须立刻收到 BrokenPipe 并结束。
            drop(rx);
            let stalled_at = producer
                .join()
                .expect("写入线程不应 panic，应在 BrokenPipe 后正常返回");
            assert_eq!(stalled_at, 1, "第 1 块入队，第 2 块因通道关闭报错");
        });
    }
}
