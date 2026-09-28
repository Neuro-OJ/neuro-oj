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

use crate::sandbox::cleanup::{
    remove_container_force, INSTANCE_LABEL, MANAGED_BY_LABEL, MANAGED_BY_VALUE,
};
use crate::sandbox::host_config::build_host_config_with_cpu;

/// 容器模式标签前缀（`com.noj.judge.dual.{kind}`）。
const DUAL_KIND_LABEL_PREFIX: &str = "com.noj.judge.dual.";

/// 评测容器 tmpfs 选项：在原有 size/mode 语义上追加 `noexec,nosuid,nodev`（VULN-21）。
///
/// - `/tmp`：`size=256M,mode=1777`；
/// - `/workspace`：`size=512M,mode=1777`（NOJ-187：rootfs 只读，注入文件落这里）。
pub fn evaluation_tmpfs() -> std::collections::HashMap<&'static str, &'static str> {
    let mut tmpfs = std::collections::HashMap::new();
    tmpfs.insert("/tmp", "size=256M,mode=1777,noexec,nosuid,nodev");
    tmpfs.insert("/workspace", "size=512M,mode=1777,noexec,nosuid,nodev");
    tmpfs
}

/// 构造容器标签（VULN-15 双标签解耦）。
///
/// - `com.noj.judge.instance = noj-{hash12}`：本实例精准清扫；
/// - `com.noj.managed-by = noj-judge`：平台级兜底清扫（不误杀业务容器）。
pub fn container_labels(
    kind: &str,
    instance_id: &str,
) -> std::collections::HashMap<String, String> {
    let mut labels = std::collections::HashMap::new();
    labels.insert(
        format!("{}{}", DUAL_KIND_LABEL_PREFIX, kind),
        "true".to_string(),
    );
    labels.insert(INSTANCE_LABEL.to_string(), instance_id.to_string());
    labels.insert(MANAGED_BY_LABEL.to_string(), MANAGED_BY_VALUE.to_string());
    labels
}

/// `DualContainer` 持有 Evaluator + Solution 两个容器 ID。
///
/// Drop 时按 Solution → Evaluator 顺序清理；任何清理步骤抛错都被记录但不传播
/// （Drop 不能 panic）。
///
/// **注意**：Drop 中的清理通过 `tokio::spawn` 甩手执行，drain 阶段运行时就绪销毁
/// 会把它强杀，因此正常路径必须显式 `await dual.destroy()`
/// （见 `dual::evaluate_dual_with_cpu_limit`）。Drop 仅作为 panic 等异常路径的兜底。
pub struct DualContainer {
    pub docker: Docker,
    pub evaluator_id: Option<String>,
    pub solution_id: Option<String>,
    /// 本实例 ID（`noj-{hash12}`），由 config 显式注入，用于实例标签。
    pub instance_id: String,
}

impl DualContainer {
    /// 创建并启动 Evaluator 容器。
    ///
    /// `network_mode`：开启联网时传专用评测网络名（默认 `noj-eval-net`）；
    /// 关闭联网时传 "none"。
    /// `instance_id`：由 `Config::instance_id` 显式传入（不再读取全局易变值）。
    pub async fn create_evaluator(
        docker: &Docker,
        image: &str,
        memory_mb: u64,
        network_mode: &str,
        cpu_limit_millicores: u64,
        instance_id: &str,
    ) -> Result<Self> {
        let id = create_container_with_security(
            docker,
            image,
            memory_mb,
            "evaluator",
            network_mode,
            cpu_limit_millicores,
            instance_id,
        )
        .await?;
        info!("Evaluator 容器创建: {}", id);
        Ok(Self {
            docker: docker.clone(),
            evaluator_id: Some(id),
            solution_id: None,
            instance_id: instance_id.to_string(),
        })
    }

    /// 在现有 DualContainer 上追加 Solution 容器（复用本实例 ID）。
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
            "none",
            cpu_limit_millicores,
            &self.instance_id,
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
        // 这是**兜底**路径（panic / 未走到显式 destroy）：正常路径必须先
        // `await destroy()`，否则 drain 阶段运行时销毁会强杀这些任务。
        let handle = match tokio::runtime::Handle::try_current() {
            Ok(handle) => handle,
            Err(_) => {
                warn!("DualContainer 在无 Tokio 运行时的上下文中析构，容器需由启动清扫回收");
                return;
            }
        };
        if let Some(id) = self.solution_id.take() {
            let docker = self.docker.clone();
            handle.spawn(async move {
                if !remove_container_force(&docker, &id).await {
                    warn!("Drop 时清理 Solution 容器失败: {}", id);
                }
            });
        }
        if let Some(id) = self.evaluator_id.take() {
            let docker = self.docker.clone();
            handle.spawn(async move {
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
    network_mode: &str,
    cpu_limit_millicores: u64,
    instance_id: &str,
) -> Result<String> {
    // NOJ-154 / VULN-15：实例标签（精准清扫）+ 平台级归属标签（兜底清扫）双标签解耦。
    let labels = container_labels(kind, instance_id);

    // NOJ-189：judge 侧封顶；0 值在 Docker 中表示不限制，因此规范化为安全默认 512MB。
    let normalized_memory_mb = if memory_mb == 0 {
        512
    } else {
        memory_mb.min(4096)
    };
    let memory_bytes = (normalized_memory_mb as i64) * 1024 * 1024;

    // NOJ-187 / VULN-21：rootfs 只读，/tmp 与 /workspace 用 tmpfs 承载运行时文件，
    // 且挂载选项收紧为 noexec,nosuid,nodev。
    let tmpfs = evaluation_tmpfs();

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

#[cfg(test)]
mod tests {
    use super::*;

    /// VULN-15：双标签解耦——实例标签（精准清扫）+ managed-by（平台兜底）。
    #[test]
    fn container_labels_bind_instance_and_managed_by() {
        let labels = container_labels("evaluator", "noj-a4f78e2b109c");
        assert_eq!(
            labels
                .get("com.noj.judge.dual.evaluator")
                .map(String::as_str),
            Some("true")
        );
        assert_eq!(
            labels.get("com.noj.judge.instance").map(String::as_str),
            Some("noj-a4f78e2b109c")
        );
        assert_eq!(
            labels.get("com.noj.managed-by").map(String::as_str),
            Some("noj-judge")
        );
        assert_eq!(labels.len(), 3, "不应引入额外标签");

        let solution = container_labels("solution", "noj-a4f78e2b109c");
        assert_eq!(
            solution
                .get("com.noj.judge.dual.solution")
                .map(String::as_str),
            Some("true")
        );
        assert!(!solution.contains_key("com.noj.judge.dual.evaluator"));
    }

    /// 实例标签值不得含 `:`、`=`、空格（否则 docker filter 切割歧义）。
    #[test]
    fn container_labels_instance_value_has_no_separators() {
        let labels = container_labels("evaluator", "noj-a4f78e2b109c");
        let value = labels.get("com.noj.judge.instance").unwrap();
        assert!(value
            .chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-'));
    }

    /// VULN-21：/tmp 与 /workspace 的 tmpfs 选项必须包含 noexec,nosuid,nodev，
    /// 且保留原有 size/mode 语义。
    #[test]
    fn evaluation_tmpfs_hardens_mount_options() {
        let tmpfs = evaluation_tmpfs();
        for (mount, expected_prefix) in [
            ("/tmp", "size=256M,mode=1777"),
            ("/workspace", "size=512M,mode=1777"),
        ] {
            let options = tmpfs
                .get(mount)
                .unwrap_or_else(|| panic!("缺少 tmpfs 挂载点 {}", mount));
            assert!(
                options.starts_with(expected_prefix),
                "{} 的 size/mode 语义应保留: {}",
                mount,
                options
            );
            for flag in ["noexec", "nosuid", "nodev"] {
                assert!(
                    options.split(',').any(|opt| opt == flag),
                    "{} 的 tmpfs 选项缺少 {}: {}",
                    mount,
                    flag,
                    options
                );
            }
        }
    }
}
