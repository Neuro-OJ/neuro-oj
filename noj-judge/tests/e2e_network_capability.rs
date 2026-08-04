//! 评测网络能力（capability）E2E 集成测试。
//!
//! 覆盖（issue #197 / openspec capability-network）：
//! - network_mode: evaluator bridge 联网 ↔ solution none 无网（UDP probe 对比，无需外网）
//! - capability 协议闭环：solution → judge 转发 → evaluator（register_capability 语义）
//!   → result 帧 → judge 转发（handle_eval_chunk 新分支）→ solution
//!
//! 注：使用现有 `noj-judge-test-runner` 镜像 + 容器内内联脚本，不依赖 SDK 镜像。

mod common;

use std::io::{Cursor, Write};
use std::path::PathBuf;
use std::time::Duration;

use anyhow::{Context, Result};
use bollard::container::LogOutput;
use bollard::exec::StartExecResults;
use bollard::models::ExecConfig;
use common::{get_docker, is_e2e_enabled};
use futures_util::StreamExt;
use noj_judge::dual::protocol::LineParser;
use noj_judge::dual::tracker::InFlightTracker;
use noj_judge::types::{EvaluatorNetwork, EvaluatorRuntime, RuntimeConfig, SolutionRuntime};

/// 创建带 sleep infinity 的测试容器。
///
/// `network_enabled`：true → bridge（联网），false → none（无网，默认）。
async fn create_sleep_container(
    docker: &bollard::Docker,
    image: &str,
    memory_mb: u64,
    network_enabled: bool,
) -> Result<String> {
    let network_mode = if network_enabled { "bridge" } else { "none" };
    let body = bollard::models::ContainerCreateBody {
        image: Some(image.to_string()),
        cmd: Some(vec!["sleep".to_string(), "infinity".to_string()]),
        host_config: Some(bollard::models::HostConfig {
            memory: Some(memory_mb as i64 * 1024 * 1024),
            memory_swap: Some(memory_mb as i64 * 1024 * 1024),
            network_mode: Some(network_mode.to_string()),
            cap_drop: Some(vec!["ALL".to_string()]),
            security_opt: Some(vec!["no-new-privileges:true".to_string()]),
            ..Default::default()
        }),
        ..Default::default()
    };
    let res = docker.create_container(None, body).await?;
    docker.start_container(&res.id, None).await?;
    Ok(res.id)
}

/// 在容器内跑一段 Python 脚本，返回 stdout。
async fn run_python_in_container(
    docker: &bollard::Docker,
    container_id: &str,
    script: &str,
) -> Result<String> {
    let cmd = vec!["python3".to_string(), "-c".to_string(), script.to_string()];

    let exec = docker
        .create_exec(
            container_id,
            ExecConfig {
                cmd: Some(cmd),
                attach_stdout: Some(true),
                attach_stderr: Some(true),
                ..Default::default()
            },
        )
        .await?;

    let started = docker.start_exec(&exec.id, None).await?;
    let mut stdout = String::new();
    if let StartExecResults::Attached { mut output, .. } = started {
        while let Some(chunk) = output.next().await {
            if let Ok(LogOutput::StdOut { message }) = chunk {
                stdout.push_str(&String::from_utf8_lossy(&message));
            }
        }
    }
    Ok(stdout)
}

async fn cleanup_container(docker: &bollard::Docker, container_id: &str) {
    let _ = docker
        .remove_container(
            container_id,
            Some(bollard::query_parameters::RemoveContainerOptions {
                force: true,
                ..Default::default()
            }),
        )
        .await;
}

/// 网络探测脚本：UDP connect 拿本地地址。
///
/// - bridge 网络：成功返回 172.x/10.x 地址（无需真实外网，connect 不发包）
/// - none 网络：抛 OSError（无路由）
const NET_PROBE_SCRIPT: &str = r#"
import socket, sys
try:
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    s.connect(("8.8.8.8", 80))
    sys.stdout.write(f"NETWORKED:{s.getsockname()[0]}\n")
except OSError as e:
    sys.stdout.write(f"BLOCKED:{type(e).__name__}\n")
sys.stdout.flush()
"#;

/// Evaluator bridge 联网 + Solution none 无网（对比断言，无需外网）。
#[ignore]
#[serial_test::serial]
#[tokio::test]
async fn network_mode_evaluator_bridge_solution_none() {
    if !is_e2e_enabled() {
        return;
    }
    let docker = get_docker().expect("docker");
    common::ensure_test_image(&docker).await.unwrap();

    let eval_id = create_sleep_container(&docker, "noj-judge-test-runner:latest", 256, true)
        .await
        .unwrap();
    let sol_id = create_sleep_container(&docker, "noj-judge-test-runner:latest", 256, false)
        .await
        .unwrap();

    let eval_out = run_python_in_container(&docker, &eval_id, NET_PROBE_SCRIPT)
        .await
        .unwrap();
    let sol_out = run_python_in_container(&docker, &sol_id, NET_PROBE_SCRIPT)
        .await
        .unwrap();

    assert!(
        eval_out.contains("NETWORKED:"),
        "evaluator（bridge）应有网络接口: {}",
        eval_out
    );
    assert!(
        sol_out.contains("BLOCKED:"),
        "solution（none）不应有网络接口: {}",
        sol_out
    );

    cleanup_container(&docker, &eval_id).await;
    cleanup_container(&docker, &sol_id).await;
}

/// capability 协议闭环（协议级，模拟 judge 双向转发）。
///
/// - solution 容器写 `capability` 帧 → Rust 端 `handle_sol_chunk` 转发 → evaluator stdin
/// - evaluator 容器（模拟 register_capability 的 handler）写 `result` 帧
///   + `---RESULT---` → Rust 端 `handle_eval_chunk`（真实转发分支）→ solution stdin
/// - solution 收到 result 帧后输出到 stderr（可观测），否则 raise
#[ignore]
#[serial_test::serial]
#[tokio::test]
async fn capability_round_trip_via_judge_forwarding() {
    if !is_e2e_enabled() {
        return;
    }
    let docker = get_docker().expect("docker");
    common::ensure_test_image(&docker).await.unwrap();

    let eval_id = create_sleep_container(&docker, "noj-judge-test-runner:latest", 256, false)
        .await
        .unwrap();
    let sol_id = create_sleep_container(&docker, "noj-judge-test-runner:latest", 256, false)
        .await
        .unwrap();

    // evaluator 侧脚本：模拟 register_capability("ping", handler) ——
    // 从 stdin 读 capability 帧，回 result 帧，然后输出 RESULT 标记结束评测。
    let eval_script = r#"
import sys, json
line = sys.stdin.readline().strip()
frame = json.loads(line)
assert frame["type"] == "capability", frame
name = frame["name"]
value = f"pong:{name}"
sys.stdout.write(json.dumps({"type":"result","id":frame["id"],"value":value}) + "\n")
sys.stdout.write("---RESULT---\n")
sys.stdout.write('{"status":"Accepted","score":10000,"details":{}}\n')
sys.stdout.flush()
"#;

    // solution 侧脚本：模拟用户代码调用 call_capability("ping") ——
    // 先发 ready 帧（judge 的 handle_sol_chunk 在 ready 前丢弃所有帧），
    // 再写 capability 帧，阻塞读响应，校验 result 帧；失败则抛异常（exec 非零退出）。
    let sol_script = r#"
import sys, json
sys.stdout.write(json.dumps({"type":"ready"}) + "\n")
sys.stdout.write(json.dumps({"type":"capability","id":"cap-1","name":"ping","args":[]}) + "\n")
sys.stdout.flush()
line = sys.stdin.readline().strip()
resp = json.loads(line)
assert resp["type"] == "result", resp
assert resp["id"] == "cap-1", resp
assert resp["value"] == "pong:ping", resp
sys.stderr.write("SOLUTION_GOT_RESULT\n")
sys.stderr.flush()
"#;

    let eval_exec = docker
        .create_exec(
            &eval_id,
            ExecConfig {
                cmd: Some(vec![
                    "python3".to_string(),
                    "-c".to_string(),
                    eval_script.to_string(),
                ]),
                attach_stdout: Some(true),
                attach_stderr: Some(true),
                attach_stdin: Some(true),
                ..Default::default()
            },
        )
        .await
        .unwrap();
    let sol_exec = docker
        .create_exec(
            &sol_id,
            ExecConfig {
                cmd: Some(vec![
                    "python3".to_string(),
                    "-c".to_string(),
                    sol_script.to_string(),
                ]),
                attach_stdout: Some(true),
                attach_stderr: Some(true),
                attach_stdin: Some(true),
                ..Default::default()
            },
        )
        .await
        .unwrap();

    let eval_started = docker.start_exec(&eval_exec.id, None).await.unwrap();
    let sol_started = docker.start_exec(&sol_exec.id, None).await.unwrap();

    let (mut eval_output, eval_input_raw) = match eval_started {
        StartExecResults::Attached { output, input } => (output, input),
        _ => panic!("evaluator exec 应 Attached"),
    };
    // bollard 的 input 是 Box<dyn AsyncWrite + Send>（无 Unpin），包装为 trait object
    let mut eval_input: std::pin::Pin<Box<dyn tokio::io::AsyncWrite + Send + Unpin>> =
        Box::pin(eval_input_raw);
    let (mut sol_output, sol_input_raw) = match sol_started {
        StartExecResults::Attached { output, input } => (output, input),
        _ => panic!("solution exec 应 Attached"),
    };
    let mut sol_input: std::pin::Pin<Box<dyn tokio::io::AsyncWrite + Send + Unpin>> =
        Box::pin(sol_input_raw);

    // ── 模拟 judge 编排循环（等价 run_dual_loop 的转发逻辑）──
    let mut eval_parser = LineParser::new();
    let mut sol_parser = LineParser::new();
    let mut solution_ready = false;
    let mut result_payload: Option<String> = None;
    let mut tracker = InFlightTracker::new(2000);

    let deadline = tokio::time::sleep(Duration::from_secs(30));
    tokio::pin!(deadline);

    let mut sol_stderr = String::new();
    let mut eval_stderr = String::new();

    'outer: loop {
        tokio::select! {
            _ = &mut deadline => {
                panic!("capability 闭环超时; sol_stderr={} eval_stderr={}", sol_stderr, eval_stderr);
            }
            chunk = eval_output.next() => {
                let chunk = match chunk {
                    Some(Ok(c)) => c,
                    other => panic!("evaluator 流结束: {:?}", other),
                };
                if let LogOutput::StdErr { message } = &chunk {
                    eval_stderr.push_str(&String::from_utf8_lossy(message));
                }
                // 真实 judge 转发逻辑：result/error 帧转发到 solution stdin
                noj_judge::dual::mod_test_helpers::handle_eval_chunk_probe(
                    &mut eval_parser,
                    &mut sol_input,
                    &mut result_payload,
                    &mut tracker,
                    chunk,
                )
                .await;
                if result_payload.is_some() {
                    break 'outer;
                }
            }
            chunk = sol_output.next() => {
                let chunk = match chunk {
                    Some(Ok(c)) => c,
                    other => panic!("solution 流结束: {:?}", other),
                };
                if let LogOutput::StdErr { message } = &chunk {
                    sol_stderr.push_str(&String::from_utf8_lossy(message));
                }
                // 真实 judge 转发逻辑：solution 帧转发到 evaluator stdin
                noj_judge::dual::mod_test_helpers::handle_sol_chunk_probe(
                    &mut sol_parser,
                    &mut eval_input,
                    chunk,
                    &mut solution_ready,
                    &mut tracker,
                )
                .await;
            }
        }
    }

    // 等待 solution 侧 exec 结束，确认其校验通过（非零退出表示失败）。
    // 注意：result_payload 就绪即 break 主循环，solution 的 stderr 可能尚未到达，
    // 这里继续消费 sol_output 直到 exec 完成。
    let mut sol_done = false;
    for _ in 0..50 {
        tokio::select! {
            chunk = sol_output.next() => {
                if let Some(Ok(LogOutput::StdErr { message })) = chunk {
                    sol_stderr.push_str(&String::from_utf8_lossy(&message));
                }
            }
            _ = tokio::time::sleep(Duration::from_millis(100)) => {}
        }
        let inspect = docker.inspect_exec(&sol_exec.id).await.unwrap();
        if inspect.exit_code.is_some() {
            sol_done = true;
            assert_eq!(
                inspect.exit_code,
                Some(0),
                "solution 侧 capability 校验失败; stderr={}",
                sol_stderr
            );
            break;
        }
    }
    assert!(
        sol_done,
        "solution exec 未在超时内结束; eval_stderr={} sol_stderr={}",
        eval_stderr, sol_stderr
    );

    // evaluator 的 RESULT payload
    assert_eq!(
        result_payload.as_deref(),
        Some("{\"status\":\"Accepted\",\"score\":10000,\"details\":{}}")
    );
    assert!(
        sol_stderr.contains("SOLUTION_GOT_RESULT"),
        "solution 应收到 result 帧: {}",
        sol_stderr
    );

    cleanup_container(&docker, &eval_id).await;
    cleanup_container(&docker, &sol_id).await;
}

/// capability 未注册 → NotFound 错误帧闭环（协议级）。
#[ignore]
#[serial_test::serial]
#[tokio::test]
async fn capability_not_found_error_round_trip() {
    if !is_e2e_enabled() {
        return;
    }
    let docker = get_docker().expect("docker");
    common::ensure_test_image(&docker).await.unwrap();

    let eval_id = create_sleep_container(&docker, "noj-judge-test-runner:latest", 256, false)
        .await
        .unwrap();
    let sol_id = create_sleep_container(&docker, "noj-judge-test-runner:latest", 256, false)
        .await
        .unwrap();

    // evaluator：未注册任何 capability → 对 capability 帧回 NotFound
    let eval_script = r#"
import sys, json
line = sys.stdin.readline().strip()
frame = json.loads(line)
assert frame["type"] == "capability", frame
sys.stdout.write(json.dumps({"type":"error","id":frame["id"],"code":"NotFound","message":"capability 'nope' not registered"}) + "\n")
sys.stdout.write("---RESULT---\n")
sys.stdout.write('{"status":"WrongAnswer","score":0,"details":{}}\n')
sys.stdout.flush()
"#;

    // solution：先发 ready，再调用未注册 capability，expect error 帧 code=NotFound
    let sol_script = r#"
import sys, json
sys.stdout.write(json.dumps({"type":"ready"}) + "\n")
sys.stdout.write(json.dumps({"type":"capability","id":"cap-2","name":"nope","args":[]}) + "\n")
sys.stdout.flush()
line = sys.stdin.readline().strip()
resp = json.loads(line)
assert resp["type"] == "error", resp
assert resp["code"] == "NotFound", resp
sys.stderr.write("SOLUTION_GOT_NOT_FOUND\n")
sys.stderr.flush()
"#;

    let eval_exec = docker
        .create_exec(
            &eval_id,
            ExecConfig {
                cmd: Some(vec![
                    "python3".to_string(),
                    "-c".to_string(),
                    eval_script.to_string(),
                ]),
                attach_stdout: Some(true),
                attach_stderr: Some(true),
                attach_stdin: Some(true),
                ..Default::default()
            },
        )
        .await
        .unwrap();
    let sol_exec = docker
        .create_exec(
            &sol_id,
            ExecConfig {
                cmd: Some(vec![
                    "python3".to_string(),
                    "-c".to_string(),
                    sol_script.to_string(),
                ]),
                attach_stdout: Some(true),
                attach_stderr: Some(true),
                attach_stdin: Some(true),
                ..Default::default()
            },
        )
        .await
        .unwrap();

    let eval_started = docker.start_exec(&eval_exec.id, None).await.unwrap();
    let sol_started = docker.start_exec(&sol_exec.id, None).await.unwrap();

    let (mut eval_output, eval_input_raw) = match eval_started {
        StartExecResults::Attached { output, input } => (output, input),
        _ => panic!("evaluator exec 应 Attached"),
    };
    let mut eval_input: std::pin::Pin<Box<dyn tokio::io::AsyncWrite + Send + Unpin>> =
        Box::pin(eval_input_raw);
    let (mut sol_output, sol_input_raw) = match sol_started {
        StartExecResults::Attached { output, input } => (output, input),
        _ => panic!("solution exec 应 Attached"),
    };
    let mut sol_input: std::pin::Pin<Box<dyn tokio::io::AsyncWrite + Send + Unpin>> =
        Box::pin(sol_input_raw);

    let mut eval_parser = LineParser::new();
    let mut sol_parser = LineParser::new();
    let mut solution_ready = false;
    let mut result_payload: Option<String> = None;
    let mut tracker = InFlightTracker::new(2000);

    let deadline = tokio::time::sleep(Duration::from_secs(30));
    tokio::pin!(deadline);

    let mut sol_stderr = String::new();

    'outer: loop {
        tokio::select! {
            _ = &mut deadline => {
                panic!("NotFound 闭环超时; sol_stderr={}", sol_stderr);
            }
            chunk = eval_output.next() => {
                let chunk = match chunk {
                    Some(Ok(c)) => c,
                    other => panic!("evaluator 流结束: {:?}", other),
                };
                noj_judge::dual::mod_test_helpers::handle_eval_chunk_probe(
                    &mut eval_parser,
                    &mut sol_input,
                    &mut result_payload,
                    &mut tracker,
                    chunk,
                )
                .await;
                if result_payload.is_some() {
                    break 'outer;
                }
            }
            chunk = sol_output.next() => {
                let chunk = match chunk {
                    Some(Ok(c)) => c,
                    other => panic!("solution 流结束: {:?}", other),
                };
                if let LogOutput::StdErr { message } = &chunk {
                    sol_stderr.push_str(&String::from_utf8_lossy(message));
                }
                noj_judge::dual::mod_test_helpers::handle_sol_chunk_probe(
                    &mut sol_parser,
                    &mut eval_input,
                    chunk,
                    &mut solution_ready,
                    &mut tracker,
                )
                .await;
            }
        }
    }

    // 等待 solution exec 结束（同时继续消费其 stderr）
    let mut sol_done = false;
    for _ in 0..50 {
        tokio::select! {
            chunk = sol_output.next() => {
                if let Some(Ok(LogOutput::StdErr { message })) = chunk {
                    sol_stderr.push_str(&String::from_utf8_lossy(&message));
                }
            }
            _ = tokio::time::sleep(Duration::from_millis(100)) => {}
        }
        let inspect = docker.inspect_exec(&sol_exec.id).await.unwrap();
        if inspect.exit_code.is_some() {
            sol_done = true;
            assert_eq!(
                inspect.exit_code,
                Some(0),
                "solution 侧 NotFound 校验失败; stderr={}",
                sol_stderr
            );
            break;
        }
    }
    assert!(
        sol_done,
        "solution exec 未在超时内结束; sol_stderr={}",
        sol_stderr
    );
    assert!(sol_stderr.contains("SOLUTION_GOT_NOT_FOUND"));

    cleanup_container(&docker, &eval_id).await;
    cleanup_container(&docker, &sol_id).await;
}

/// capability handler 异常 → error 帧（code=Exception，trace 已清洗）闭环。
#[ignore]
#[serial_test::serial]
#[tokio::test]
async fn capability_handler_exception_error_round_trip() {
    if !is_e2e_enabled() {
        return;
    }
    let docker = get_docker().expect("docker");
    common::ensure_test_image(&docker).await.unwrap();

    let eval_id = create_sleep_container(&docker, "noj-judge-test-runner:latest", 256, false)
        .await
        .unwrap();
    let sol_id = create_sleep_container(&docker, "noj-judge-test-runner:latest", 256, false)
        .await
        .unwrap();

    // evaluator：模拟注册的 handler 抛异常 → 回 Exception 错误帧（含清洗后 trace）
    let eval_script = r#"
import sys, json
line = sys.stdin.readline().strip()
frame = json.loads(line)
assert frame["type"] == "capability", frame
sys.stdout.write(json.dumps({
    "type": "error",
    "id": frame["id"],
    "code": "Exception",
    "message": "cap boom",
    "trace": 'Traceback (most recent call last):\n  File "evaluate.py", line 10, in handler\nValueError: cap boom',
}) + "\n")
sys.stdout.write("---RESULT---\n")
sys.stdout.write('{"status":"WrongAnswer","score":0,"details":{}}\n')
sys.stdout.flush()
"#;

    // solution：expect error 帧 code=Exception，message 含 "cap boom"
    let sol_script = r#"
import sys, json
sys.stdout.write(json.dumps({"type":"ready"}) + "\n")
sys.stdout.write(json.dumps({"type":"capability","id":"cap-3","name":"boom","args":[]}) + "\n")
sys.stdout.flush()
line = sys.stdin.readline().strip()
resp = json.loads(line)
assert resp["type"] == "error", resp
assert resp["code"] == "Exception", resp
assert resp["message"] == "cap boom", resp
sys.stderr.write("SOLUTION_GOT_HANDLER_ERROR\n")
sys.stderr.flush()
"#;

    let eval_exec = docker
        .create_exec(
            &eval_id,
            ExecConfig {
                cmd: Some(vec![
                    "python3".to_string(),
                    "-c".to_string(),
                    eval_script.to_string(),
                ]),
                attach_stdout: Some(true),
                attach_stderr: Some(true),
                attach_stdin: Some(true),
                ..Default::default()
            },
        )
        .await
        .unwrap();
    let sol_exec = docker
        .create_exec(
            &sol_id,
            ExecConfig {
                cmd: Some(vec![
                    "python3".to_string(),
                    "-c".to_string(),
                    sol_script.to_string(),
                ]),
                attach_stdout: Some(true),
                attach_stderr: Some(true),
                attach_stdin: Some(true),
                ..Default::default()
            },
        )
        .await
        .unwrap();

    let eval_started = docker.start_exec(&eval_exec.id, None).await.unwrap();
    let sol_started = docker.start_exec(&sol_exec.id, None).await.unwrap();

    let (mut eval_output, eval_input_raw) = match eval_started {
        StartExecResults::Attached { output, input } => (output, input),
        _ => panic!("evaluator exec 应 Attached"),
    };
    let mut eval_input: std::pin::Pin<Box<dyn tokio::io::AsyncWrite + Send + Unpin>> =
        Box::pin(eval_input_raw);
    let (mut sol_output, sol_input_raw) = match sol_started {
        StartExecResults::Attached { output, input } => (output, input),
        _ => panic!("solution exec 应 Attached"),
    };
    let mut sol_input: std::pin::Pin<Box<dyn tokio::io::AsyncWrite + Send + Unpin>> =
        Box::pin(sol_input_raw);

    let mut eval_parser = LineParser::new();
    let mut sol_parser = LineParser::new();
    let mut solution_ready = false;
    let mut result_payload: Option<String> = None;
    let mut tracker = InFlightTracker::new(2000);

    let deadline = tokio::time::sleep(Duration::from_secs(30));
    tokio::pin!(deadline);

    let mut sol_stderr = String::new();
    let mut eval_stderr = String::new();

    'outer: loop {
        tokio::select! {
            _ = &mut deadline => {
                panic!("handler 异常闭环超时; sol_stderr={}", sol_stderr);
            }
            chunk = eval_output.next() => {
                let chunk = match chunk {
                    Some(Ok(c)) => c,
                    other => panic!("evaluator 流结束: {:?}", other),
                };
                if let LogOutput::StdErr { message } = &chunk {
                    eval_stderr.push_str(&String::from_utf8_lossy(message));
                }
                noj_judge::dual::mod_test_helpers::handle_eval_chunk_probe(
                    &mut eval_parser,
                    &mut sol_input,
                    &mut result_payload,
                    &mut tracker,
                    chunk,
                )
                .await;
                if result_payload.is_some() {
                    break 'outer;
                }
            }
            chunk = sol_output.next() => {
                let chunk = match chunk {
                    Some(Ok(c)) => c,
                    other => panic!("solution 流结束: {:?}", other),
                };
                if let LogOutput::StdErr { message } = &chunk {
                    sol_stderr.push_str(&String::from_utf8_lossy(message));
                }
                noj_judge::dual::mod_test_helpers::handle_sol_chunk_probe(
                    &mut sol_parser,
                    &mut eval_input,
                    chunk,
                    &mut solution_ready,
                    &mut tracker,
                )
                .await;
            }
        }
    }

    // 等待 solution exec 结束（同时继续消费其 stderr）
    let mut sol_done = false;
    for _ in 0..50 {
        tokio::select! {
            chunk = sol_output.next() => {
                if let Some(Ok(LogOutput::StdErr { message })) = chunk {
                    sol_stderr.push_str(&String::from_utf8_lossy(&message));
                }
            }
            _ = tokio::time::sleep(Duration::from_millis(100)) => {}
        }
        let inspect = docker.inspect_exec(&sol_exec.id).await.unwrap();
        if inspect.exit_code.is_some() {
            sol_done = true;
            assert_eq!(
                inspect.exit_code,
                Some(0),
                "solution 侧 handler 异常校验失败; stderr={}",
                sol_stderr
            );
            break;
        }
    }
    assert!(
        sol_done,
        "solution exec 未在超时内结束; eval_stderr={} sol_stderr={}",
        eval_stderr, sol_stderr
    );
    assert!(sol_stderr.contains("SOLUTION_GOT_HANDLER_ERROR"));

    cleanup_container(&docker, &eval_id).await;
    cleanup_container(&docker, &sol_id).await;
}

// ─────────────────────────────────────────────────────────────────────────────
// SDK 全链路 + 真实网络连通性（增强，issue #197）
// ─────────────────────────────────────────────────────────────────────────────

/// 内存打包支持包 zip（evaluate.py 位于 zip 根，解压后挂载到 /workspace）。
fn build_support_zip(evaluate_py: &str) -> Vec<u8> {
    let mut buf = Cursor::new(Vec::new());
    {
        let mut zw = zip::ZipWriter::new(&mut buf);
        let opts = zip::write::SimpleFileOptions::default()
            .compression_method(zip::CompressionMethod::Deflated);
        zw.start_file("evaluate.py", opts).unwrap();
        zw.write_all(evaluate_py.as_bytes()).unwrap();
        zw.finish().unwrap();
    }
    buf.into_inner()
}

/// 确保带 SDK 的评测镜像存在（不存在则用仓库 Dockerfile 构建）。
///
/// 镜像内置 noj_evaluator_sdk / noj_solution_sdk 到 site-packages，
/// 供真实 SDK 全链路测试使用（evaluate_dual 的 solution 启动命令
/// 硬编码 `python3 -m noj_solution_sdk.host`，镜像必须含 SDK）。
async fn ensure_sdk_images(docker: &bollard::Docker) -> Result<()> {
    for (tag, dockerfile) in [
        (
            "noj-e2e-sdk-evaluator:latest",
            "docker/evaluator-python/Dockerfile",
        ),
        (
            "noj-e2e-sdk-solution:latest",
            "docker/solution-python/Dockerfile",
        ),
    ] {
        let images = docker
            .list_images(None::<bollard::query_parameters::ListImagesOptions>)
            .await?;
        if images.iter().any(|i| i.repo_tags.iter().any(|t| t == tag)) {
            continue;
        }
        println!("构建 SDK 测试镜像 {} ...", tag);
        let status = std::process::Command::new("docker")
            .args(["build", "-t", tag, "-f", dockerfile, "."])
            // buildx 在部分环境写 activity 文件失败（只读 HOME），退回 legacy builder
            .env("DOCKER_BUILDKIT", "0")
            .current_dir(PathBuf::from(env!("CARGO_MANIFEST_DIR")))
            .status()
            .context("执行 docker build 失败")?;
        if !status.success() {
            anyhow::bail!("docker build 失败: {}", tag);
        }
    }
    Ok(())
}

/// bridge 容器真实网络探测：真实 TCP 出网（example.com:443）+ 真实 DNS 解析
/// （getaddrinfo，线程 + 超时避免 resolver 长时间挂起）。需要宿主外网。
///
/// 注：不探测 docker embedded DNS 的 TCP 53——Docker 的 127.0.0.11
/// 只监听 UDP 53，TCP 查询必然失败（已知限制），不能作为连通性探针。
const REAL_NET_SCRIPT: &str = r#"
import socket, threading
try:
    socket.create_connection(("example.com", 443), timeout=8).close()
    print("TCP-OK")
except OSError as e:
    print("TCP-FAIL:" + repr(e))
res = []
def probe():
    try:
        socket.getaddrinfo("example.com", 443, type=socket.SOCK_STREAM)
        res.append(True)
    except OSError:
        res.append(False)
t = threading.Thread(target=probe, daemon=True)
t.start()
t.join(timeout=10)
print("DNS-OK" if res and res[0] else "DNS-FAIL")
"#;

/// none 容器网络探测：TCP 与 DNS 均应被阻断（solution 无网安全边界）。
const NONE_NET_SCRIPT: &str = r#"
import socket, threading
try:
    socket.create_connection(("example.com", 443), timeout=4).close()
    print("TCP-UNEXPECTED-OK")
except OSError:
    print("TCP-BLOCKED")
res = []
def probe():
    try:
        socket.getaddrinfo("example.com", 443, type=socket.SOCK_STREAM)
        res.append(True)
    except OSError:
        res.append(False)
t = threading.Thread(target=probe, daemon=True)
t.start()
t.join(timeout=8)
print("DNS-OK" if res and res[0] else "DNS-BLOCKED")
"#;

/// 真实网络连通性（bridge）：TCP 到 docker DNS + 真实 DNS 解析必须成功；
/// solution（none）对照：TCP/DNS 均不可达。DNS 解析需要宿主外网。
#[ignore]
#[serial_test::serial]
#[tokio::test]
async fn bridge_dns_tcp_real_connectivity() {
    if !is_e2e_enabled() {
        return;
    }
    let docker = get_docker().expect("docker");
    common::ensure_test_image(&docker).await.unwrap();

    // evaluator：bridge 联网 → TCP + DNS 真实可用
    let eval_id = create_sleep_container(&docker, "noj-judge-test-runner:latest", 256, true)
        .await
        .unwrap();
    let eval_out = run_python_in_container(&docker, &eval_id, REAL_NET_SCRIPT)
        .await
        .unwrap();
    assert!(
        eval_out.contains("TCP-OK"),
        "bridge 容器 TCP 到 docker DNS 应成功: {}",
        eval_out
    );
    assert!(
        eval_out.contains("DNS-OK"),
        "bridge 容器真实 DNS 解析应成功（需宿主外网）: {}",
        eval_out
    );
    cleanup_container(&docker, &eval_id).await;

    // solution：none 无网 → TCP/DNS 均被阻断
    let sol_id = create_sleep_container(&docker, "noj-judge-test-runner:latest", 256, false)
        .await
        .unwrap();
    let sol_out = run_python_in_container(&docker, &sol_id, NONE_NET_SCRIPT)
        .await
        .unwrap();
    assert!(
        sol_out.contains("TCP-BLOCKED"),
        "none 容器 TCP 应被阻断: {}",
        sol_out
    );
    assert!(
        sol_out.contains("DNS-BLOCKED"),
        "none 容器 DNS 应失败: {}",
        sol_out
    );
    cleanup_container(&docker, &sol_id).await;
}

/// SDK 全链路（真实 SDK，非协议模拟）：evaluate.py `register_capability` →
/// solution `call_capability` → judge 双向转发 → 评测 Accepted。
///
/// evaluator 以 bridge 联网（network.enabled=true）：capability handler 内
/// TCP 探测 docker DNS（127.0.0.11:53），成功才返回 pong → Accepted；
/// 若 evaluator 无网则返回 no-net → WrongAnswer（测试失败即暴露网络回归）。
#[ignore]
#[serial_test::serial]
#[tokio::test]
async fn capability_sdk_full_chain_with_network() {
    if !is_e2e_enabled() {
        return;
    }
    let docker = get_docker().expect("docker");
    common::ensure_test_image(&docker).await.unwrap();
    ensure_sdk_images(&docker).await.unwrap();

    let evaluate_py = r#"
import socket
from noj_evaluator_sdk import SolutionRunner, register_capability, result

def ping(msg: str) -> str:
    # handler 在 evaluator（bridge 联网）内执行：真实 TCP 出网探测（需外网）。
    # evaluator 无网时返回 no-net → WrongAnswer，暴露网络回归。
    try:
        socket.create_connection(("example.com", 443), timeout=5).close()
        return "pong:" + msg
    except OSError as e:
        return "no-net:" + str(e)

register_capability("ping", ping)

runner = SolutionRunner()
try:
    answer = runner.call("solve", "hello")
except Exception as e:
    result.runtime_error("call failed: " + repr(e))
else:
    if answer == "pong:hello":
        result.accept(score=100)
    else:
        result.wrong_answer(score=0, message="unexpected: " + repr(answer))
"#;
    let support_zip = build_support_zip(evaluate_py);

    let submission_id = format!("e2e-net-sdk-{}", uuid::Uuid::new_v4());
    let runtime_config = RuntimeConfig {
        evaluator: EvaluatorRuntime {
            image: "noj-e2e-sdk-evaluator:latest".to_string(),
            command: "python3 /workspace/evaluate.py".to_string(),
            time_limit_ms: 20000,
            memory_limit_mb: 256,
            network: Some(EvaluatorNetwork { enabled: true }),
        },
        solution: SolutionRuntime {
            image: "noj-e2e-sdk-solution:latest".to_string(),
            entry: "solution.py".to_string(),
            call_timeout_ms: 8000,
            memory_limit_mb: 128,
        },
    };
    let user_code = r#"
from noj_solution_sdk import register, call_capability

@register
def solve(msg: str) -> str:
    return call_capability("ping", msg)
"#;

    let result = noj_judge::dual::evaluate_dual(
        docker,
        &submission_id,
        &runtime_config,
        user_code,
        "solution.py",
        Some(&support_zip),
        "/tmp/e2e-cache",
        100,
        64,
        None,
    )
    .await
    .expect("evaluate_dual 返回 Err");

    assert_eq!(
        result.status, "Accepted",
        "SDK 全链路应 Accepted（evaluator 联网 + capability 转发），实际 {:?} score={}",
        result.status, result.score
    );
}
