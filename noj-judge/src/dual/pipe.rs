/**
 * 双容器编排的**管道写入**原语（VULN-16）。
 *
 * ## 为什么单独成模块
 *
 * 帧转发（写对端 stdin）此前直接内联在编排主循环里，`write_all().await` 一旦因
 * 管道缓冲写满而挂起，外层 `select!` 就再也无法轮询，**题目级总超时同时失效**——
 * 单次恶意提交即可永久占死一个评测槽位。修复引入超时与「对端已死」判定后，这部分
 * 逻辑自成一个关注点（写入语义 + 死流识别），故从 `dual/mod.rs` 拆出：
 * 主循环只关心「这一帧有没有送出去、对端还活着吗」。
 *
 * ## 语义
 *
 * - [`PipeWriteOutcome::Written`]：帧已完整写入并 flush；
 * - [`PipeWriteOutcome::PeerGone`]：写入超时，或对端 stdin 已关闭（EPIPE 等）——
 *   调用方必须立即把该方向标记为结束并按协议转入异常收尾；
 * - 序列化失败等真实错误仍以 `Err` 返回（**不吞错**）。
 */
use std::time::Duration;

use anyhow::{Context, Result};
use serde_json::Value;
use tracing::warn;

/// VULN-16：管道写入（转发帧到对端 stdin）的短超时。
///
/// 对端 stdin 已死（EPIPE）或长时间不可写（管道缓冲满、对端不再读取）时，
/// 必须在 3s 内放弃并把该方向判定为「对端已死」，否则外层 `select!` 会整体
/// 阻塞，题目级总超时随之失效。
pub(super) const PIPE_WRITE_TIMEOUT: Duration = Duration::from_secs(3);

/// 帧写入结果：显式区分「写入成功」与「对端 stdin 已死」（VULN-16）。
///
/// 不吞错误：真实写入失败（非 EPIPE 类）仍以 `Err` 返回；只有明确的
/// 对端关闭/写入超时归为 [`PipeWriteOutcome::PeerGone`]，由调用方按协议收尾。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum PipeWriteOutcome {
    /// 帧已完整写入并 flush。
    Written,
    /// 对端 stdin 已死（EPIPE/连接重置）或写入超时；该方向不得再写。
    PeerGone,
}

/// 判断写入错误是否表示「对端 stdin 已死」（EPIPE/连接重置）。
pub(super) fn is_peer_closed_error(e: &std::io::Error) -> bool {
    matches!(
        e.kind(),
        std::io::ErrorKind::BrokenPipe
            | std::io::ErrorKind::ConnectionReset
            | std::io::ErrorKind::ConnectionAborted
            | std::io::ErrorKind::UnexpectedEof
            | std::io::ErrorKind::NotConnected
    )
}

/// 向等待方写调用级超时错误帧。
///
/// 返回 [`PipeWriteOutcome`]：对端 stdin 已死时不视为致命错误，由调用方按协议收尾。
pub(super) async fn write_timeout_frame(
    writer: &mut std::pin::Pin<Box<dyn tokio::io::AsyncWrite + Send + Unpin>>,
    id: &str,
) -> Result<PipeWriteOutcome> {
    let frame = serde_json::json!({
        "type": "error",
        "id": id,
        "code": "CallTimeout",
        "message": "call timeout",
    });
    forward_frame(writer, &frame).await
}

/// 转发一个 NDJSON 帧到对端 stdin（默认 3s 短超时）。
pub(super) async fn forward_frame(
    writer: &mut std::pin::Pin<Box<dyn tokio::io::AsyncWrite + Send + Unpin>>,
    frame: &Value,
) -> Result<PipeWriteOutcome> {
    forward_frame_with_timeout(writer, frame, PIPE_WRITE_TIMEOUT).await
}

/// 转发一个 NDJSON 帧到对端 stdin，写入受 `timeout` 约束（VULN-16）。
///
/// 返回 [`PipeWriteOutcome`]：
/// - [`PipeWriteOutcome::Written`]：写入成功（含 flush）；
/// - [`PipeWriteOutcome::PeerGone`]：写入超时，或对端 stdin 已关闭（EPIPE 等）——
///   调用方必须立即把该方向标记为结束并按协议转入异常收尾。
///
/// 序列化失败等真实错误仍以 `Err` 返回（不吞错）。
pub(super) async fn forward_frame_with_timeout(
    writer: &mut std::pin::Pin<Box<dyn tokio::io::AsyncWrite + Send + Unpin>>,
    frame: &Value,
    timeout: Duration,
) -> Result<PipeWriteOutcome> {
    use tokio::io::AsyncWriteExt;
    let line = serde_json::to_string(frame)?;
    let mut payload = line.into_bytes();
    payload.push(b'\n');

    let write = async {
        writer.write_all(&payload).await?;
        writer.flush().await?;
        std::io::Result::Ok(())
    };

    match tokio::time::timeout(timeout, write).await {
        Ok(Ok(())) => Ok(PipeWriteOutcome::Written),
        Ok(Err(e)) if is_peer_closed_error(&e) => {
            warn!("协议帧写入失败，判定对端 stdin 已关闭: {}", e);
            Ok(PipeWriteOutcome::PeerGone)
        }
        Ok(Err(e)) => Err(e).context("写入协议帧失败"),
        Err(_elapsed) => {
            warn!(
                "协议帧写入超时（{:?}），判定对端 stdin 已死（管道不再被读取）",
                timeout
            );
            Ok(PipeWriteOutcome::PeerGone)
        }
    }
}
