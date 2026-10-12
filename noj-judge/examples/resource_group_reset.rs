//! 排空后解除资源组配置锁；不会停止 Worker 或修改评测队列。
use anyhow::{Context, Result};

#[tokio::main]
async fn main() -> Result<()> {
    let args = std::env::args().skip(1).collect::<Vec<_>>();
    anyhow::ensure!(
        args.len() == 2,
        "用法: resource_group_reset <claim-prefix> <resource-group>"
    );
    let client =
        redis::Client::open(std::env::var("REDIS_URL").context("必须显式设置 REDIS_URL")?)?;
    anyhow::ensure!(
        noj_judge::scheduling::Scheduler::reset_group_config(&client, &args[0], &args[1]).await?,
        "资源组仍有有效 Worker 心跳或执行租约；请先停止所有组内 Worker 并等待排空"
    );
    println!("资源组配置锁已解除；按一致的新配置启动全部 Worker");
    Ok(())
}
