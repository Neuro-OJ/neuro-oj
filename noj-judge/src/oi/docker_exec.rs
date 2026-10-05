//! 本地 Docker OI 执行原语：一次性容器、有限 I/O 与进程退出检查。

use crate::dual::container::{container_labels, SANDBOX_USER};
use crate::sandbox::cleanup::remove_container_force;
use crate::sandbox::host_config::build_host_config_with_cpu;
use anyhow::{bail, Context, Result};
use bollard::container::LogOutput;
use bollard::exec::StartExecResults;
use bollard::models::{ContainerCreateBody, ExecConfig};
use bollard::Docker;
use futures_util::{Stream, StreamExt};
use std::pin::Pin;
use std::time::Duration;
use tokio::io::AsyncWriteExt;
use tokio::time::timeout;
use tracing::info;
const MAX_OUTPUT_BYTES: usize = 32 * 1024 * 1024;
const EXEC_CREATE_TIMEOUT: Duration = Duration::from_secs(10);
const EXEC_START_TIMEOUT: Duration = Duration::from_secs(10);
const EXEC_INSPECT_TIMEOUT: Duration = Duration::from_secs(5);
const EXEC_INSPECT_ATTEMPTS: usize = 50;
const INPUT_WRITE_TIMEOUT: Duration = Duration::from_secs(10);

type OutputStream = Pin<Box<dyn Stream<Item = Result<LogOutput, bollard::errors::Error>> + Send>>;

#[derive(Debug)]
pub(super) struct CapturedOutput {
    pub(super) stdout: Vec<u8>,
    pub(super) stderr: Vec<u8>,
    pub(super) output_limited: bool,
}

#[derive(Debug)]
pub(super) struct ExecOutcome {
    pub(super) output: CapturedOutput,
    pub(super) exit_code: i64,
}

pub(super) async fn create_container(
    docker: &Docker,
    image: &str,
    memory_limit_mb: u64,
    cpu_limit_millicores: u64,
    instance_id: &str,
) -> Result<String> {
    let mut tmpfs = std::collections::HashMap::new();
    // Docker 默认给 tmpfs 加 noexec，必须显式 exec 才能运行 gcc 产物；
    // rootfs 仍为只读，/tmp 继续 noexec/nosuid/nodev。
    tmpfs.insert("/workspace", "size=512M,mode=1777,exec,nosuid,nodev");
    tmpfs.insert("/tmp", "size=256M,mode=1777,noexec,nosuid,nodev");
    let memory_bytes = (memory_limit_mb.clamp(1, 512) * 1024 * 1024) as i64;
    let host_config =
        build_host_config_with_cpu(memory_bytes, tmpfs, true, "none", cpu_limit_millicores);
    let body = ContainerCreateBody {
        image: Some(image.to_string()),
        cmd: Some(vec!["sleep".to_string(), "infinity".to_string()]),
        labels: Some(container_labels("oi", instance_id)),
        host_config: Some(host_config),
        working_dir: Some("/workspace".to_string()),
        user: Some(SANDBOX_USER.to_string()),
        ..Default::default()
    };
    let created = timeout(Duration::from_secs(30), docker.create_container(None, body))
        .await
        .context("创建 OI 容器超时")?
        .context("创建 OI 容器失败")?;
    if let Err(error) = timeout(
        Duration::from_secs(5),
        docker.start_container(&created.id, None),
    )
    .await
    .context("启动 OI 容器超时")
    .and_then(|result| result.context("启动 OI 容器失败"))
    {
        let _ = remove_container_force(docker, &created.id).await;
        return Err(error);
    }
    info!(container_id = %created.id, "OI 测试点容器已启动");
    Ok(created.id)
}

pub(super) async fn exec_without_stdin(
    docker: &Docker,
    container_id: &str,
    cmd: Vec<String>,
    limit: Duration,
) -> Result<ExecOutcome> {
    let exec = timeout(
        EXEC_CREATE_TIMEOUT,
        docker.create_exec(
            container_id,
            ExecConfig {
                cmd: Some(cmd),
                attach_stdout: Some(true),
                attach_stderr: Some(true),
                user: Some(SANDBOX_USER.to_string()),
                working_dir: Some("/workspace".to_string()),
                ..Default::default()
            },
        ),
    )
    .await
    .context("创建 OI exec 超时")?
    .context("创建 OI exec 失败")?;
    let started = timeout(EXEC_START_TIMEOUT, docker.start_exec(&exec.id, None))
        .await
        .context("启动 OI exec 超时")?
        .context("启动 OI exec 失败")?;
    let output = match started {
        StartExecResults::Attached { output, .. } => output,
        StartExecResults::Detached => bail!("OI exec 意外进入 detached 模式"),
    };
    let captured = timeout(limit, collect_output(output))
        .await
        .map_err(|_| anyhow::anyhow!("OI exec 超时"))??;
    let exit_code = inspect_exec_exit(docker, &exec.id).await?;
    Ok(ExecOutcome {
        output: captured,
        exit_code,
    })
}

pub(super) struct RunOutcome {
    pub(super) output: CapturedOutput,
    pub(super) exit_code: i64,
    pub(super) oom_killed: bool,
    pub(super) timed_out: bool,
}

pub(super) async fn exec_with_stdin(
    docker: &Docker,
    container_id: &str,
    cmd: Vec<String>,
    input: &[u8],
    limit: Duration,
) -> Result<RunOutcome> {
    let exec = timeout(
        EXEC_CREATE_TIMEOUT,
        docker.create_exec(
            container_id,
            ExecConfig {
                cmd: Some(cmd),
                attach_stdin: Some(true),
                attach_stdout: Some(true),
                attach_stderr: Some(true),
                user: Some(SANDBOX_USER.to_string()),
                working_dir: Some("/workspace".to_string()),
                ..Default::default()
            },
        ),
    )
    .await
    .context("创建 OI 运行 exec 超时")?
    .context("创建 OI 运行 exec 失败")?;
    let started = timeout(EXEC_START_TIMEOUT, docker.start_exec(&exec.id, None))
        .await
        .context("启动 OI 运行 exec 超时")?
        .context("启动 OI 运行 exec 失败")?;
    let (output, mut input_writer) = match started {
        StartExecResults::Attached { output, input } => (output, input),
        StartExecResults::Detached => bail!("OI 运行 exec 意外进入 detached 模式"),
    };
    let output_task = tokio::spawn(collect_output(output));
    let write_result = timeout(INPUT_WRITE_TIMEOUT, async {
        input_writer
            .write_all(input)
            .await
            .context("写入 OI 测试输入失败")?;
        input_writer
            .shutdown()
            .await
            .context("关闭 OI 测试输入失败")?;
        Ok::<(), anyhow::Error>(())
    })
    .await;
    if let Ok(Err(error)) = write_result {
        let _ = docker.kill_container(container_id, None).await;
        output_task.abort();
        return Err(error);
    }
    if write_result.is_err() {
        let _ = docker.kill_container(container_id, None).await;
        output_task.abort();
        return Ok(RunOutcome {
            output: CapturedOutput {
                stdout: Vec::new(),
                stderr: Vec::new(),
                output_limited: false,
            },
            exit_code: -1,
            oom_killed: false,
            timed_out: true,
        });
    }

    let mut output_task = output_task;
    let captured = match timeout(limit, &mut output_task).await {
        Ok(joined) => joined.context("读取 OI 程序输出任务失败")??,
        Err(_) => {
            let _ = docker.kill_container(container_id, None).await;
            output_task.abort();
            return Ok(RunOutcome {
                output: CapturedOutput {
                    stdout: Vec::new(),
                    stderr: Vec::new(),
                    output_limited: false,
                },
                exit_code: -1,
                oom_killed: inspect_oom(docker, container_id).await,
                timed_out: true,
            });
        }
    };
    if captured.output_limited {
        let _ = docker.kill_container(container_id, None).await;
        return Ok(RunOutcome {
            output: captured,
            exit_code: -1,
            oom_killed: inspect_oom(docker, container_id).await,
            timed_out: false,
        });
    }
    let exit_code = inspect_exec_exit(docker, &exec.id).await?;
    let oom_killed = inspect_oom(docker, container_id).await;
    Ok(RunOutcome {
        output: captured,
        exit_code,
        oom_killed,
        timed_out: false,
    })
}

async fn collect_output(mut output: OutputStream) -> Result<CapturedOutput> {
    let mut captured = CapturedOutput {
        stdout: Vec::new(),
        stderr: Vec::new(),
        output_limited: false,
    };
    let mut total_output = 0usize;
    while let Some(chunk) = output.next().await {
        let chunk = chunk.context("读取 OI exec 输出失败")?;
        let (target, message) = match chunk {
            LogOutput::StdOut { message } | LogOutput::Console { message } => {
                (&mut captured.stdout, message)
            }
            LogOutput::StdErr { message } => (&mut captured.stderr, message),
            LogOutput::StdIn { message } => (&mut captured.stderr, message),
        };
        if total_output.saturating_add(message.len()) > MAX_OUTPUT_BYTES {
            captured.output_limited = true;
            return Ok(captured);
        }
        total_output += message.len();
        target.extend_from_slice(&message);
    }
    Ok(captured)
}

async fn inspect_exec_exit(docker: &Docker, exec_id: &str) -> Result<i64> {
    for _ in 0..EXEC_INSPECT_ATTEMPTS {
        let inspection = timeout(EXEC_INSPECT_TIMEOUT, docker.inspect_exec(exec_id))
            .await
            .context("查询 OI exec 状态超时")?
            .context("查询 OI exec 状态失败")?;
        if inspection.running == Some(false) {
            return Ok(inspection.exit_code.unwrap_or(-1));
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    bail!("OI exec 未在状态查询窗口内退出")
}

pub(super) async fn inspect_oom(docker: &Docker, container_id: &str) -> bool {
    docker
        .inspect_container(container_id, None)
        .await
        .ok()
        .and_then(|info| info.state)
        .and_then(|state| state.oom_killed)
        .unwrap_or(false)
}
