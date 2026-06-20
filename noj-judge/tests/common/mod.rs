//! noj-judge E2E 集成测试辅助模块。
//!
//! 提供 Docker 容器管理、测试门控、镜像管理等通用工具函数。
//! 被各个测试文件通过 `mod common; use common::*;` 导入。

use std::path::PathBuf;
use std::time::Duration;

use anyhow::{Context, Result};
use bollard::container::{
    Config, CreateContainerOptions, KillContainerOptions, LogsOptions, RemoveContainerOptions,
    StartContainerOptions, WaitContainerOptions,
};
use bollard::models::HostConfig;
use bollard::Docker;
use futures_util::StreamExt;

/// 容器执行输出
#[derive(Debug, Clone)]
pub struct ContainerOutput {
    pub stdout: String,
    pub stderr: String,
    pub exit_code: i64,
}

/// 检查 E2E 测试是否启用（环境变量 NOJ_RUN_E2E=1）
pub fn is_e2e_enabled() -> bool {
    std::env::var("NOJ_RUN_E2E").as_deref() == Ok("1")
}

/// 获取 Docker 连接
pub fn get_docker() -> Result<Docker> {
    Docker::connect_with_local_defaults().context("连接 Docker daemon 失败")
}

/// 确保测试用 Docker 镜像存在。
///
/// 先检查本地是否已有 `noj-judge-test-runner` 镜像，
/// 不存在则通过 `docker build` 命令从 Dockerfile 构建。
pub async fn ensure_test_image(docker: &Docker) -> Result<()> {
    let image_name = "noj-judge-test-runner:latest";

    // 检查本地镜像
    let images = docker
        .list_images::<String>(None)
        .await
        .context("列出 Docker 镜像失败")?;

    let exists = images.iter().any(|i| {
        i.repo_tags
            .iter()
            .any(|tag| tag == image_name || tag == "noj-judge-test-runner")
    });

    if exists {
        return Ok(());
    }

    // 通过子进程构建镜像（bollard 的 tar 构建在测试环境中不够可靠）
    println!("测试镜像 {} 不存在，开始构建...", image_name);

    let dockerfile_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/e2e");
    if !dockerfile_dir.join("Dockerfile.test-runner").exists() {
        anyhow::bail!(
            "Dockerfile 不存在: {}",
            dockerfile_dir.join("Dockerfile.test-runner").display()
        );
    }

    let status = std::process::Command::new("docker")
        .args([
            "build",
            "-t",
            image_name,
            "-f",
            "Dockerfile.test-runner",
            ".",
        ])
        .current_dir(&dockerfile_dir)
        .status()
        .context("执行 docker build 失败")?;

    if !status.success() {
        anyhow::bail!("docker build 失败 (exit: {:?})", status.code());
    }

    println!("测试镜像构建完成: {}", image_name);
    Ok(())
}

/// 创建测试用容器。
///
/// 返回 (container_id, work_dir_path)。
pub async fn create_test_container(
    docker: &Docker,
    image: &str,
    cmd: &[&str],
    memory_limit_mb: u64,
    _timeout_ms: u64,
) -> Result<(String, PathBuf)> {
    // 创建临时工作目录
    let work_dir = std::env::temp_dir().join(format!("noj-judge-test-{}", uuid::Uuid::new_v4()));
    tokio::fs::create_dir_all(&work_dir)
        .await
        .with_context(|| format!("创建临时目录失败: {}", work_dir.display()))?;

    let container_name = format!("noj-test-{}", uuid::Uuid::new_v4());

    let cmd_parts: Vec<String> = cmd.iter().map(|s| s.to_string()).collect();

    let host_config = HostConfig {
        binds: Some(vec![format!("{}:/tmp", work_dir.to_string_lossy())]),
        memory: Some(memory_limit_mb as i64 * 1024 * 1024),
        memory_swap: Some(memory_limit_mb as i64 * 1024 * 1024),
        nano_cpus: Some(1_000_000_000),
        network_mode: Some("none".to_string()),
        auto_remove: Some(false),
        ..Default::default()
    };

    let config = Config {
        image: Some(image.to_string()),
        cmd: Some(cmd_parts),
        host_config: Some(host_config),
        ..Default::default()
    };

    let container = docker
        .create_container(
            Some(CreateContainerOptions {
                name: &container_name,
                platform: None,
            }),
            config,
        )
        .await
        .with_context(|| format!("创建容器失败: {}", container_name))?;

    docker
        .start_container(&container.id, None::<StartContainerOptions<String>>)
        .await
        .with_context(|| format!("启动容器失败: {}", container_name))?;

    Ok((container.id, work_dir))
}

/// 等待容器退出并捕获输出。
///
/// `timeout_ms` 为超时阈值，超时返回 exit_code=-1。
pub async fn wait_container(
    docker: &Docker,
    container_id: &str,
    timeout_ms: u64,
) -> Result<ContainerOutput> {
    let timeout = Duration::from_millis(timeout_ms + 5000);

    let wait_result = tokio::time::timeout(timeout, async {
        let mut stream = docker.wait_container(
            container_id,
            Some(WaitContainerOptions {
                condition: "not-running",
            }),
        );
        match stream.next().await {
            Some(Ok(output)) => Ok(output.status_code),
            Some(Err(e)) => Err(anyhow::anyhow!("等待容器失败: {}", e)),
            None => Err(anyhow::anyhow!("容器退出流提前结束")),
        }
    })
    .await;

    let exit_code = match wait_result {
        Ok(Ok(code)) => code,
        Ok(Err(e)) => {
            let _ = docker
                .remove_container(
                    container_id,
                    Some(RemoveContainerOptions {
                        force: true,
                        ..Default::default()
                    }),
                )
                .await;
            return Err(e);
        }
        Err(_elapsed) => {
            let _ = docker
                .kill_container(container_id, None::<KillContainerOptions<String>>)
                .await;
            let output = capture_logs(docker, container_id).await;
            return Ok(ContainerOutput {
                stdout: output.stdout,
                stderr: output.stderr,
                exit_code: -1,
            });
        }
    };

    let output = capture_logs(docker, container_id).await;

    let _ = docker
        .remove_container(
            container_id,
            Some(RemoveContainerOptions {
                force: true,
                ..Default::default()
            }),
        )
        .await;

    Ok(ContainerOutput {
        stdout: output.stdout,
        stderr: output.stderr,
        exit_code,
    })
}

/// 捕获容器日志。
async fn capture_logs(docker: &Docker, container_id: &str) -> ContainerOutput {
    let options = LogsOptions::<String> {
        stdout: true,
        stderr: true,
        ..Default::default()
    };

    let mut stdout = String::new();
    let mut stderr = String::new();

    let mut stream = docker.logs(container_id, Some(options));
    while let Some(item) = stream.next().await {
        match item {
            Ok(output) => match output {
                bollard::container::LogOutput::StdOut { message } => {
                    stdout.push_str(&String::from_utf8_lossy(&message));
                }
                bollard::container::LogOutput::StdErr { message } => {
                    stderr.push_str(&String::from_utf8_lossy(&message));
                }
                _ => {}
            },
            Err(e) => {
                eprintln!("读取容器日志失败: {}", e);
                break;
            }
        }
    }

    ContainerOutput {
        stdout,
        stderr,
        exit_code: 0,
    }
}
