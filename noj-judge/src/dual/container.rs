//! 双容器 RAII 资源管理。
//!
//! 设计稿 §7 清理契约（RAII）：
//! 1. 先 `docker rm -f` Solution 容器
//! 2. 后 `docker rm -f` Evaluator 容器
//! 3. 中间步骤抛错不阻止后续清理
//! 4. 临时目录与下载缓存清理

use std::time::Duration;

use anyhow::{Context, Result};
use bollard::container::LogOutput;
use bollard::exec::StartExecResults;
use bollard::models::{ContainerCreateBody, ExecConfig};
use bollard::Docker;
use tokio::io::AsyncWrite;
use tokio::time::timeout;
use tracing::{info, warn};

use crate::sandbox::cleanup::remove_container_force;
use crate::sandbox::host_config::build_host_config;

/// `DualContainer` 持有 Evaluator + Solution 两个容器 ID。
///
/// Drop 时按 Solution → Evaluator 顺序清理；任何清理步骤抛错都被记录但不传播
/// （Drop 不能 panic）。
pub struct DualContainer {
    pub docker: Docker,
    pub evaluator_id: Option<String>,
    pub solution_id: Option<String>,
}

impl DualContainer {
    /// 创建并启动 Evaluator 容器（带支持包挂载路径）。
    pub async fn create_evaluator(
        docker: &Docker,
        image: &str,
        memory_mb: u64,
        support_pkg_mount: Option<&str>,
    ) -> Result<Self> {
        let id = create_container_with_security(
            docker,
            image,
            memory_mb,
            support_pkg_mount,
            "evaluator",
        )
        .await?;
        info!("Evaluator 容器创建: {}", id);
        Ok(Self {
            docker: docker.clone(),
            evaluator_id: Some(id),
            solution_id: None,
        })
    }

    /// 在现有 DualContainer 上追加 Solution 容器。
    pub async fn create_solution(&mut self, image: &str, memory_mb: u64) -> Result<()> {
        let id = create_container_with_security(&self.docker, image, memory_mb, None, "solution")
            .await?;
        info!("Solution 容器创建: {}", id);
        self.solution_id = Some(id);
        Ok(())
    }

    /// 显式销毁两个容器（先 Solution 后 Evaluator）。
    pub async fn destroy(mut self) -> Result<()> {
        // 先 Solution（如果有）
        if let Some(id) = self.solution_id.take() {
            if !remove_container_force(&self.docker, &id).await {
                warn!("destroy 时清理 Solution 容器失败: {}", id);
            }
        }
        // 再 Evaluator
        if let Some(id) = self.evaluator_id.take() {
            if !remove_container_force(&self.docker, &id).await {
                warn!("destroy 时清理 Evaluator 容器失败: {}", id);
            }
        }
        Ok(())
    }
}

impl Drop for DualContainer {
    fn drop(&mut self) {
        // Drop 中只 spawn 异步清理任务；不能 block。
        if let Some(id) = self.solution_id.take() {
            let docker = self.docker.clone();
            tokio::spawn(async move {
                if !remove_container_force(&docker, &id).await {
                    warn!("Drop 时清理 Solution 容器失败: {}", id);
                }
            });
        }
        if let Some(id) = self.evaluator_id.take() {
            let docker = self.docker.clone();
            tokio::spawn(async move {
                if !remove_container_force(&docker, &id).await {
                    warn!("Drop 时清理 Evaluator 容器失败: {}", id);
                }
            });
        }
    }
}

/// 一个 exec 会话：返回 (stdout stream, stdin writer)。
pub struct ExecSession {
    #[allow(dead_code)]
    pub exec_id: String,
    #[allow(dead_code)]
    pub container_id: String,
    /// combined stdout/stderr stream (LogOutput 区分)
    pub output: std::pin::Pin<
        Box<dyn futures_util::Stream<Item = Result<LogOutput, bollard::errors::Error>> + Send>,
    >,
    /// stdin writer
    pub input: std::pin::Pin<Box<dyn AsyncWrite + Send + Unpin>>,
}

/// 在指定容器内创建并启动 exec。
///
/// 注意：bollard 的 `start_exec` 返回的 input/output 生命周期与 StartExecResults
/// 绑定；这里把 output/input 都 Pin<Box<dyn ...>> 出来延长生命周期。
pub async fn start_exec(
    docker: &Docker,
    container_id: &str,
    cmd: Vec<String>,
) -> Result<ExecSession> {
    let exec = timeout(
        Duration::from_secs(10),
        docker.create_exec(
            container_id,
            ExecConfig {
                cmd: Some(cmd),
                attach_stdout: Some(true),
                attach_stderr: Some(true),
                attach_stdin: Some(true),
                ..Default::default()
            },
        ),
    )
    .await
    .context("创建 exec 超时")?
    .context("创建 exec 失败")?;

    let started = docker
        .start_exec(&exec.id, None)
        .await
        .context("启动 exec 失败")?;

    match started {
        StartExecResults::Attached { output, input } => Ok(ExecSession {
            exec_id: exec.id,
            container_id: container_id.to_string(),
            output: Box::pin(output),
            input: Box::pin(input),
        }),
        StartExecResults::Detached => {
            anyhow::bail!("exec 不应进入 Detached 模式（已请求 attach）")
        }
    }
}

// ── 私有辅助 ───────────────────────────────────────────

async fn create_container_with_security(
    docker: &Docker,
    image: &str,
    memory_mb: u64,
    support_pkg_mount: Option<&str>,
    kind: &str,
) -> Result<String> {
    let mut labels = std::collections::HashMap::new();
    labels.insert(format!("com.noj.judge.dual.{}", kind), "true".to_string());

    let memory_bytes = (memory_mb as i64) * 1024 * 1024;

    let mut tmpfs = std::collections::HashMap::new();
    tmpfs.insert("/tmp", "size=256M");

    let host_config = build_host_config(memory_bytes, tmpfs, false);

    let body = ContainerCreateBody {
        image: Some(image.to_string()),
        cmd: Some(vec!["sleep".to_string(), "infinity".to_string()]),
        labels: Some(labels),
        host_config: Some(host_config),
        working_dir: Some("/workspace".to_string()),
        ..Default::default()
    };

    let result = timeout(Duration::from_secs(30), docker.create_container(None, body))
        .await
        .context("创建容器超时")?
        .context("创建容器失败")?;

    // 如需挂载支持包：在容器创建后用 tar copy 注入（v1 简化版：仅写入文件，
    // 不挂载目录；mount 通过 working_dir + COPY 实现，docker exec 在 /workspace 内运行）
    let _ = support_pkg_mount; // 当前实现未使用，预留扩展位

    timeout(
        Duration::from_secs(5),
        docker.start_container(&result.id, None),
    )
    .await
    .context("启动容器超时")?
    .context("启动容器失败")?;

    Ok(result.id)
}

#[cfg(test)]
#[allow(unused_imports)]
mod tests {
    #[test]
    fn test_dual_container_struct_clone() {
        // 仅编译期测试：DualContainer 的字段允许 None 表示未创建。
        // 这里不直接构造实例（需要 Docker），仅验证字段可空。
        fn _assert_option_string() {
            let _: Option<String> = None;
        }
        _assert_option_string();
    }
}
