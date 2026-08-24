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

use crate::sandbox::cleanup::{instance_label_value, remove_container_force, INSTANCE_LABEL};
use crate::sandbox::host_config::build_host_config_with_cpu;

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
    /// 创建并启动 Evaluator 容器。
    ///
    /// `network_enabled`：true 时以 bridge 模式联网，false 时保持无网（默认）。
    pub async fn create_evaluator(
        docker: &Docker,
        image: &str,
        memory_mb: u64,
        network_enabled: bool,
        cpu_limit_millicores: u64,
    ) -> Result<Self> {
        let id = create_container_with_security(
            docker,
            image,
            memory_mb,
            "evaluator",
            network_enabled,
            cpu_limit_millicores,
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
    pub async fn create_solution(
        &mut self,
        image: &str,
        memory_mb: u64,
        cpu_limit_millicores: u64,
    ) -> Result<()> {
        let id = create_container_with_security(
            &self.docker,
            image,
            memory_mb,
            "solution",
            false,
            cpu_limit_millicores,
        )
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

/// 一个 exec 会话：`output` 为 combined stdout/stderr 流，`input` 为 stdin writer。
pub struct ExecSession {
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
    env: Vec<String>,
) -> Result<ExecSession> {
    let exec = timeout(
        Duration::from_secs(10),
        docker.create_exec(
            container_id,
            ExecConfig {
                cmd: Some(cmd),
                env: Some(env),
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
            output: Box::pin(output),
            input: Box::pin(input),
        }),
        StartExecResults::Detached => {
            anyhow::bail!("exec 不应进入 Detached 模式（已请求 attach）")
        }
    }
}

async fn create_container_with_security(
    docker: &Docker,
    image: &str,
    memory_mb: u64,
    kind: &str,
    network_enabled: bool,
    cpu_limit_millicores: u64,
) -> Result<String> {
    let mut labels = std::collections::HashMap::new();
    labels.insert(format!("com.noj.judge.dual.{}", kind), "true".to_string());
    // NOJ-154：实例标签，供启动孤儿清扫精确匹配。
    labels.insert(INSTANCE_LABEL.to_string(), instance_label_value());

    // NOJ-189：judge 侧封顶；0 值在 Docker 中表示不限制，因此规范化为安全默认 512MB。
    let normalized_memory_mb = if memory_mb == 0 {
        512
    } else {
        memory_mb.min(4096)
    };
    let memory_bytes = (normalized_memory_mb as i64) * 1024 * 1024;

    let mut tmpfs = std::collections::HashMap::new();
    tmpfs.insert("/tmp", "size=256M,mode=1777");
    // NOJ-187：rootfs 只读，/workspace 用 tmpfs 承载运行时注入文件。
    tmpfs.insert("/workspace", "size=512M,mode=1777");

    // solution 容器恒无网；evaluator 按配置可选 bridge 联网
    let network_mode = if network_enabled { "bridge" } else { "none" };
    let host_config = build_host_config_with_cpu(
        memory_bytes,
        tmpfs,
        true,
        network_mode,
        cpu_limit_millicores,
    );

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

    // NOJ-158：start 失败/超时时容器 ID 已创建，必须立即清理。
    if let Err(e) = timeout(
        Duration::from_secs(5),
        docker.start_container(&result.id, None),
    )
    .await
    .context("启动容器超时")
    .and_then(|r| r.context("启动容器失败"))
    {
        let _ = remove_container_force(docker, &result.id).await;
        return Err(e);
    }

    Ok(result.id)
}
