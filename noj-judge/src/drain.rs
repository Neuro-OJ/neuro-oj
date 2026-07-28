//! 评测任务编排 — 优雅关闭时排空 (drain) 正在执行的评测任务。
//!
//! 当 noj-judge 收到 SIGTERM/SIGINT 时，主循环停止拉取新任务，
//! 调用本模块的 `drain_tasks` 等待所有 in-flight 任务完成，
//! 超时后 abort 剩余任务。
//!
//! 本模块从 `main.rs` 提取，使 drain 逻辑可被单元测试覆盖。

use futures_util::StreamExt;
use std::time::Duration;
use tracing::{info, warn};

const DRAIN_TIMEOUT_SECS: u64 = 30;
const ABORT_JOIN_TIMEOUT_SECS: u64 = 5;

/// 排空正在执行的任务列表。
///
/// 行为：
/// - 等待所有任务完成，最多等 `DRAIN_TIMEOUT_SECS` 秒
/// - 超时后主动 abort 剩余任务，再等待 `ABORT_JOIN_TIMEOUT_SECS` 秒收集结果
/// - 调用后调用方应直接退出进程（本函数不保证所有 task 已完全停止）
pub async fn drain_tasks(
    tasks: &mut futures_util::stream::FuturesUnordered<tokio::task::JoinHandle<()>>,
) {
    info!(
        "关闭信号已接收，等待 {} 个正在执行的任务完成...",
        tasks.len()
    );

    // 使用 tokio::select! 自带的 pinning 等待所有任务完成
    let deadline = tokio::time::sleep(Duration::from_secs(DRAIN_TIMEOUT_SECS));
    tokio::pin!(deadline);
    loop {
        tokio::select! {
            _ = &mut deadline => {
                warn!("等待超时，{} 个任务未完成，强制退出", tasks.len());
                break;
            }
            _ = tasks.next() => {
                if tasks.is_empty() {
                    info!("所有 in-flight 任务已完成");
                    return;
                }
            }
        }
    }

    // 超时：abort 所有剩余任务
    let remaining = tasks.len();
    warn!("drain 超时，强制 abort {} 个剩余 task", remaining);
    for handle in tasks.iter_mut() {
        handle.abort();
    }

    let join_all = futures_util::future::join_all(tasks);
    let abort_deadline = tokio::time::sleep(Duration::from_secs(ABORT_JOIN_TIMEOUT_SECS));
    tokio::pin!(abort_deadline);
    tokio::pin!(join_all);
    tokio::select! {
        results = &mut join_all => {
            let aborted = results
                .iter()
                .filter(|r| r.as_ref().err().is_some_and(|e| e.is_cancelled()))
                .count();
            let finished = results.len() - aborted;
            info!("剩余任务 abort 完成: finished={}, aborted={}", finished, aborted);
        }
        _ = &mut abort_deadline => {
            warn!("abort 后 join_all 仍超时，进程将直接退出");
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use futures_util::stream::FuturesUnordered;

    #[tokio::test]
    async fn test_drain_empty() {
        let mut tasks: FuturesUnordered<tokio::task::JoinHandle<()>> = FuturesUnordered::new();
        drain_tasks(&mut tasks).await;
        // 空列表应立即返回
    }

    #[tokio::test]
    async fn test_drain_completes_immediately() {
        let mut tasks: FuturesUnordered<tokio::task::JoinHandle<()>> = FuturesUnordered::new();
        tasks.push(tokio::spawn(async {}));
        tasks.push(tokio::spawn(async {}));
        drain_tasks(&mut tasks).await;
    }

    #[tokio::test]
    async fn test_drain_completes_after_delay() {
        let mut tasks: FuturesUnordered<tokio::task::JoinHandle<()>> = FuturesUnordered::new();
        tasks.push(tokio::spawn(async {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }));
        drain_tasks(&mut tasks).await;
    }
}
