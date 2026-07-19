//! 在池容器中通过 docker exec 执行评测命令。

use std::time::Duration;

use anyhow::{Context, Result};
use bollard::container::LogOutput;
use bollard::exec::StartExecResults;
use bollard::models::ExecConfig;
use bollard::Docker;
use futures_util::StreamExt;
use tokio::time::timeout;
use tracing::warn;

const MAX_EXEC_OUTPUT_BYTES: usize = 4 * 1024 * 1024;

/// 在已存在的容器中通过 exec 执行命令。
///
/// 返回 (stdout, stderr, exit_code, time_ms)。
#[allow(dead_code)]
pub async fn execute_in_container(
    docker: &Docker,
    container_id: &str,
    command: &[String],
    timeout_ms: u64,
    kill_grace_secs: u64,
) -> Result<(String, String, i64, u64)> {
    let exec_start = std::time::Instant::now();

    // 创建 exec（带 10s 超时）
    let exec = timeout(
        Duration::from_secs(10),
        docker.create_exec(
            container_id,
            ExecConfig {
                cmd: Some(command.to_vec()),
                attach_stdout: Some(true),
                attach_stderr: Some(true),
                ..Default::default()
            },
        ),
    )
    .await
    .context("创建 exec 超时 (>10s)")?
    .context("创建 exec 失败")?;

    // 启动 exec 并捕获输出
    let output_future = async {
        let result = docker
            .start_exec(&exec.id, None)
            .await
            .context("启动 exec 失败")?;

        let mut stdout = String::new();
        let mut stderr = String::new();
        let mut stdout_truncated = false;
        let mut stderr_truncated = false;

        if let StartExecResults::Attached { mut output, .. } = result {
            while let Some(chunk) = output.next().await {
                match chunk {
                    Ok(LogOutput::StdOut { message }) => {
                        append_limited(&mut stdout, &message, &mut stdout_truncated);
                    }
                    Ok(LogOutput::StdErr { message }) => {
                        append_limited(&mut stderr, &message, &mut stderr_truncated);
                    }
                    _ => {}
                }
            }
        }

        // 获取退出码
        let inspect = docker.inspect_exec(&exec.id).await?;
        let exit_code = inspect.exit_code.unwrap_or(-1);

        Ok::<_, anyhow::Error>((
            stdout,
            stderr,
            exit_code,
            exec_start.elapsed().as_millis() as u64,
        ))
    };

    // 竞速：exec 执行 vs 超时
    match timeout(Duration::from_millis(timeout_ms), output_future).await {
        Ok(result) => result,
        Err(_elapsed) => {
            // 超时：先 stop 再 kill
            if let Err(e) = docker
                .stop_container(
                    container_id,
                    Some(bollard::query_parameters::StopContainerOptions {
                        t: Some(kill_grace_secs as i32),
                        signal: None,
                    }),
                )
                .await
            {
                warn!("超时后 stop_container 失败: {}: {}", container_id, e);
            }
            if let Err(e) = docker
                .kill_container(
                    container_id,
                    None::<bollard::query_parameters::KillContainerOptions>,
                )
                .await
            {
                warn!("超时后 kill_container 失败: {}: {}", container_id, e);
            }

            // 超时后从日志捕获剩余输出
            let mut logs = docker.logs(
                container_id,
                Some(bollard::query_parameters::LogsOptions {
                    stdout: true,
                    stderr: true,
                    follow: false,
                    since: 0,
                    until: 0,
                    timestamps: false,
                    tail: "all".to_string(),
                }),
            );

            let mut output = String::new();
            let mut truncated = false;
            while let Some(chunk) = logs.next().await {
                match chunk {
                    Ok(LogOutput::StdOut { message }) => {
                        append_limited(&mut output, &message, &mut truncated);
                    }
                    Ok(LogOutput::StdErr { message }) => {
                        append_limited(&mut output, &message, &mut truncated);
                    }
                    _ => {}
                }
            }

            Ok((
                output,
                String::new(),
                -1,
                exec_start.elapsed().as_millis() as u64,
            ))
        }
    }
}

#[allow(dead_code)]
fn append_limited(output: &mut String, message: &[u8], truncated: &mut bool) {
    if *truncated {
        return;
    }

    let remaining = MAX_EXEC_OUTPUT_BYTES.saturating_sub(output.len());
    if remaining == 0 {
        output.push_str("\n...[output truncated by noj-judge]\n");
        *truncated = true;
        return;
    }

    if message.len() <= remaining {
        output.push_str(&String::from_utf8_lossy(message));
        return;
    }

    output.push_str(&String::from_utf8_lossy(&message[..remaining]));
    output.push_str("\n...[output truncated by noj-judge]\n");
    *truncated = true;
}

/// 读取容器的 cgroup 内存峰值（KB）。
///
/// 优先 cgroup v2 (`memory.peak`)，回退 v1 (`memory.max_usage_in_bytes`)。
/// 读取失败时返回 Ok(0) 不阻塞评测流程。
#[allow(dead_code)]
pub async fn read_memory_peak_kb(docker: &Docker, container_id: &str) -> Result<u64> {
    // cgroup v2: memory.peak (Linux 6.1+)
    let cmd = vec![
        "sh".to_string(),
        "-c".to_string(),
        "cat /sys/fs/cgroup/memory.peak 2>/dev/null || cat /sys/fs/cgroup/memory/memory.max_usage_in_bytes 2>/dev/null || echo 0".to_string(),
    ];
    let (out, _, exit_code, _) = execute_in_container(docker, container_id, &cmd, 5000, 2).await?;
    if exit_code == 0 {
        if let Ok(bytes) = out.trim().parse::<u64>() {
            return Ok(bytes / 1024);
        }
    }
    Ok(0)
}

// parse_command 请使用 crate::sandbox::container::parse_command

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_append_limited_truncates_large_output() {
        let mut output = String::new();
        let mut truncated = false;
        append_limited(
            &mut output,
            &vec![b'a'; MAX_EXEC_OUTPUT_BYTES + 128],
            &mut truncated,
        );
        assert!(truncated);
        assert!(output.contains("truncated by noj-judge"));
        assert!(output.len() > MAX_EXEC_OUTPUT_BYTES);
    }
}
