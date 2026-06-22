//! 在池容器中通过 docker exec 执行评测命令。

use std::time::Duration;

use anyhow::{Context, Result};
use bollard::container::{
    KillContainerOptions, LogOutput, LogsOptions, StopContainerOptions,
};
use bollard::exec::{CreateExecOptions, StartExecResults};
use bollard::Docker;
use futures_util::StreamExt;
use tokio::time::timeout;

/// 在已存在的容器中通过 exec 执行命令。
///
/// 返回 (stdout, stderr, exit_code)。
pub async fn execute_in_container(
    docker: &Docker,
    container_id: &str,
    command: &[String],
    timeout_ms: u64,
    kill_grace_secs: u64,
) -> Result<(String, String, i64)> {
    // 创建 exec
    let exec = docker
        .create_exec(
            container_id,
            CreateExecOptions {
                cmd: Some(command.to_vec()),
                attach_stdout: Some(true),
                attach_stderr: Some(true),
                ..Default::default()
            },
        )
        .await
        .context("创建 exec 失败")?;

    // 启动 exec 并捕获输出
    let output_future = async {
        let result = docker.start_exec(&exec.id, None).await.context("启动 exec 失败")?;

        let mut stdout = String::new();
        let mut stderr = String::new();

        if let StartExecResults::Attached { mut output, .. } = result {
            while let Some(chunk) = output.next().await {
                match chunk {
                    Ok(LogOutput::StdOut { message }) => {
                        stdout.push_str(&String::from_utf8_lossy(&message));
                    }
                    Ok(LogOutput::StdErr { message }) => {
                        stderr.push_str(&String::from_utf8_lossy(&message));
                    }
                    _ => {}
                }
            }
        }

        // 获取退出码
        let inspect = docker.inspect_exec(&exec.id).await?;
        let exit_code = inspect.exit_code.unwrap_or(-1);

        Ok::<_, anyhow::Error>((stdout, stderr, exit_code))
    };

    // 竞速：exec 执行 vs 超时
    let total_timeout_ms = timeout_ms + kill_grace_secs * 1000;
    match timeout(Duration::from_millis(total_timeout_ms), output_future).await {
        Ok(result) => result,
        Err(_elapsed) => {
            // 超时：先 stop 再 kill
            let _ = docker
                .stop_container(container_id, Some(StopContainerOptions { t: kill_grace_secs as i64 }))
                .await;
            let _ = docker
                .kill_container(container_id, None::<KillContainerOptions<String>>)
                .await;

            // 超时后从日志捕获剩余输出
            let mut logs = docker.logs(
                container_id,
                Some(LogsOptions::<String> {
                    stdout: true,
                    stderr: true,
                    ..Default::default()
                }),
            );

            let mut output = String::new();
            while let Some(chunk) = logs.next().await {
                match chunk {
                    Ok(LogOutput::StdOut { message }) => {
                        output.push_str(&String::from_utf8_lossy(&message));
                    }
                    Ok(LogOutput::StdErr { message }) => {
                        output.push_str(&String::from_utf8_lossy(&message));
                    }
                    _ => {}
                }
            }

            Ok((output, String::new(), -1))
        }
    }
}

// parse_command 请使用 crate::sandbox::container::parse_command
