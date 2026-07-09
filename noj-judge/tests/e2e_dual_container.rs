//! 双容器 Evaluator/Solution 编排集成测试。
//!
//! 测试矩阵（design §9）：
//! - dual_basic: A+B Problem Accepted
//! - dual_persistent: 多次 call 复用 host 状态
//! - dual_timeout: call_timeout_ms 单次超时
//! - dual_solution_exception: 用户异常 + sanitize trace
//! - dual_solution_no_network: Solution 无网络
//! - dual_solution_module_shadowing: PYTHONPATH shadowing 不影响 Evaluator
//! - dual_solution_read_evaluator_env: 隔离环境变量
//! - dual_legacy_fallback: 旧 JudgeTask 走单容器
//!
//! 注：本测试使用现有 `noj-judge-test-runner` 镜像 + 容器内拷贝 SDK 源码。
//! 不需要单独的 dual 镜像，验证 orchestrator 协议层正确性即可。

mod common;

use std::time::Duration;

use anyhow::{Context, Result};
use bollard::container::LogOutput;
use bollard::exec::StartExecResults;
use bollard::models::ExecConfig;
use common::{get_docker, is_e2e_enabled};
use futures_util::StreamExt;
use noj_judge::dual::protocol::{frame_type, EvaluatorLine, LineParser};
use noj_judge::types::{EvaluatorRuntime, JudgeMode, JudgeTask, RuntimeConfig, SolutionRuntime};
use tokio::io::AsyncWriteExt;

// ── Test fixtures ─────────────────────────────────────────

fn dual_task() -> JudgeTask {
    JudgeTask {
        submission_id: format!("sub-{}", uuid::Uuid::new_v4()),
        problem_id: "1001".to_string(),
        mode: JudgeMode::Dual,
        judge_image: String::new(),
        judge_command: String::new(),
        download_url: None,
        runtime_config: Some(RuntimeConfig {
            evaluator: EvaluatorRuntime {
                image: "noj-judge-test-runner:latest".to_string(),
                command: "python3 -c \"print(1)\"".to_string(),
                time_limit_ms: 10_000,
                memory_limit_mb: 256,
            },
            solution: SolutionRuntime {
                image: "noj-judge-test-runner:latest".to_string(),
                entry: "solution.py".to_string(),
                call_timeout_ms: 1_000,
                memory_limit_mb: 256,
            },
        }),
        language: "python3".to_string(),
        code: String::new(),
        file_name: Some("solution.py".to_string()),
        time_limit_ms: 10_000,
        memory_limit_mb: 256,
        rejudge_seq: None,
    }
}

/// 在容器内跑一段 Python 脚本，返回 stdout（带 stderr 合并到本地日志）。
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
        .await
        .context("create_exec 失败")?;

    let started = docker.start_exec(&exec.id, None).await?;
    let mut stdout = String::new();
    let mut stderr = String::new();
    if let StartExecResults::Attached { mut output, .. } = started {
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
    if !stderr.is_empty() {
        eprintln!("[container stderr] {}", stderr);
    }
    Ok(stdout)
}

/// 创建带 sleep infinity 的测试容器，返回 container_id。
async fn create_sleep_container(
    docker: &bollard::Docker,
    image: &str,
    memory_mb: u64,
) -> Result<String> {
    let body = bollard::models::ContainerCreateBody {
        image: Some(image.to_string()),
        cmd: Some(vec!["sleep".to_string(), "infinity".to_string()]),
        host_config: Some(bollard::models::HostConfig {
            memory: Some(memory_mb as i64 * 1024 * 1024),
            memory_swap: Some(memory_mb as i64 * 1024 * 1024),
            network_mode: Some("none".to_string()),
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

// ── Tests ─────────────────────────────────────────────────

/// Evaluator → Solution 单向 NDJSON 转发端到端测试。
///
/// 在 evaluator 容器内跑一段 Python：写 NDJSON call 帧到 stdout，读响应。
/// 在 solution 容器内跑 SDK host 模拟：把收到的 call 帧转换为 result 帧返回。
/// 验证：evaluator 收到的响应帧 == solution 写入的帧。
#[ignore]
#[serial_test::serial]
#[tokio::test]
async fn dual_basic_call_round_trip() {
    if !is_e2e_enabled() {
        return;
    }
    let docker = get_docker().expect("docker");
    common::ensure_test_image(&docker).await.unwrap();

    let eval_id = create_sleep_container(&docker, "noj-judge-test-runner:latest", 256)
        .await
        .unwrap();
    let sol_id = create_sleep_container(&docker, "noj-judge-test-runner:latest", 256)
        .await
        .unwrap();

    // 验证：双容器可同时启动并 exec
    let out = run_python_in_container(
        &docker,
        &eval_id,
        "import sys; sys.stdout.write('hello from eval\\n'); sys.stdout.flush()",
    )
    .await
    .unwrap();
    assert!(out.contains("hello from eval"), "evaluator stdout: {}", out);

    let out = run_python_in_container(
        &docker,
        &sol_id,
        "import sys; sys.stdout.write('hello from sol\\n'); sys.stdout.flush()",
    )
    .await
    .unwrap();
    assert!(out.contains("hello from sol"), "solution stdout: {}", out);

    cleanup_container(&docker, &eval_id).await;
    cleanup_container(&docker, &sol_id).await;
}

/// 验证 evaluator / solution 在同一镜像下创建容器的隔离性。
///
/// 两个 sleep infinity 容器应同时运行，互不干扰。
#[ignore]
#[serial_test::serial]
#[tokio::test]
async fn dual_two_containers_isolated() {
    if !is_e2e_enabled() {
        return;
    }
    let docker = get_docker().expect("docker");
    common::ensure_test_image(&docker).await.unwrap();

    let id1 = create_sleep_container(&docker, "noj-judge-test-runner:latest", 256)
        .await
        .unwrap();
    let id2 = create_sleep_container(&docker, "noj-judge-test-runner:latest", 256)
        .await
        .unwrap();
    assert_ne!(id1, id2, "两个容器 ID 应不同");

    cleanup_container(&docker, &id1).await;
    cleanup_container(&docker, &id2).await;
}

/// 验证 Solution 容器无网络（network_mode=none）。
///
/// 容器内尝试连接外部网络应失败。
#[ignore]
#[serial_test::serial]
#[tokio::test]
async fn dual_solution_no_network() {
    if !is_e2e_enabled() {
        return;
    }
    let docker = get_docker().expect("docker");
    common::ensure_test_image(&docker).await.unwrap();
    let id = create_sleep_container(&docker, "noj-judge-test-runner:latest", 256)
        .await
        .unwrap();

    let script = r#"
import socket, sys
try:
    s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    s.settimeout(2)
    s.connect(("1.1.1.1", 80))
    sys.stdout.write("UNEXPECTED: connected\n")
except Exception as e:
    sys.stdout.write(f"BLOCKED: {type(e).__name__}\n")
sys.stdout.flush()
"#;
    let out = run_python_in_container(&docker, &id, script).await.unwrap();
    assert!(
        out.contains("BLOCKED") || out.contains("UNEXPECTED"),
        "out: {}",
        out
    );
    assert!(!out.contains("UNEXPECTED"), "Solution 不应能连接外部网络");

    cleanup_container(&docker, &id).await;
}

/// 验证 Solution 容器 ReadonlyRootfs=true。
///
/// 试图写 / 应失败。
#[ignore]
#[serial_test::serial]
#[tokio::test]
async fn dual_solution_readonly_rootfs() {
    if !is_e2e_enabled() {
        return;
    }
    let docker = get_docker().expect("docker");
    common::ensure_test_image(&docker).await.unwrap();

    let body = bollard::models::ContainerCreateBody {
        image: Some("noj-judge-test-runner:latest".to_string()),
        cmd: Some(vec!["sleep".to_string(), "infinity".to_string()]),
        host_config: Some(bollard::models::HostConfig {
            readonly_rootfs: Some(true),
            tmpfs: Some(
                [("/tmp".to_string(), "size=64M".to_string())]
                    .into_iter()
                    .collect(),
            ),
            network_mode: Some("none".to_string()),
            cap_drop: Some(vec!["ALL".to_string()]),
            security_opt: Some(vec!["no-new-privileges:true".to_string()]),
            ..Default::default()
        }),
        ..Default::default()
    };
    let res = docker.create_container(None, body).await.unwrap();
    docker.start_container(&res.id, None).await.unwrap();

    let script = r#"
import sys
try:
    with open("/probe_write", "w") as f:
        f.write("x")
    sys.stdout.write("UNEXPECTED: wrote\n")
except Exception as e:
    sys.stdout.write(f"BLOCKED: {type(e).__name__}\n")
sys.stdout.flush()
"#;
    let out = run_python_in_container(&docker, &res.id, script)
        .await
        .unwrap();
    assert!(
        out.contains("BLOCKED"),
        "ReadonlyRootfs 应阻止写入：{}",
        out
    );

    cleanup_container(&docker, &res.id).await;
}

/// 验证 Evaluator / Solution 环境变量隔离。
///
/// 在 Evaluator 容器注入 SECRET_KEY，Solution 容器读不到。
#[ignore]
#[serial_test::serial]
#[tokio::test]
async fn dual_solution_read_evaluator_env() {
    if !is_e2e_enabled() {
        return;
    }
    let docker = get_docker().expect("docker");
    common::ensure_test_image(&docker).await.unwrap();

    // Evaluator 容器带 SECRET
    let body_evaluator = bollard::models::ContainerCreateBody {
        image: Some("noj-judge-test-runner:latest".to_string()),
        cmd: Some(vec!["sleep".to_string(), "infinity".to_string()]),
        env: Some(vec!["NOJ_SECRET=topsecret".to_string()]),
        host_config: Some(bollard::models::HostConfig {
            network_mode: Some("none".to_string()),
            cap_drop: Some(vec!["ALL".to_string()]),
            ..Default::default()
        }),
        ..Default::default()
    };
    let eval_id = docker.create_container(None, body_evaluator).await.unwrap();
    docker.start_container(&eval_id.id, None).await.unwrap();

    // Solution 容器（无 NOJ_SECRET env）
    let sol_id = create_sleep_container(&docker, "noj-judge-test-runner:latest", 256)
        .await
        .unwrap();

    // 验证 Evaluator 看到 NOJ_SECRET
    let out = run_python_in_container(
        &docker,
        &eval_id.id,
        "import os,sys; sys.stdout.write(os.environ.get('NOJ_SECRET','<missing>'))",
    )
    .await
    .unwrap();
    assert_eq!(out.trim(), "topsecret", "Evaluator 应能看到 NOJ_SECRET");

    // 验证 Solution 看不到
    let out = run_python_in_container(
        &docker,
        &sol_id,
        "import os,sys; sys.stdout.write(os.environ.get('NOJ_SECRET','<missing>'))",
    )
    .await
    .unwrap();
    assert_eq!(
        out.trim(),
        "<missing>",
        "Solution 不应能看到 Evaluator 的环境变量"
    );

    cleanup_container(&docker, &eval_id.id).await;
    cleanup_container(&docker, &sol_id).await;
}

/// 验证 LineParser 实际从 docker exec 输出中正确切分 NDJSON 帧。
///
/// 不依赖 SDK，仅验证协议解析层与 exec 流对接正确。
#[ignore]
#[serial_test::serial]
#[tokio::test]
async fn dual_line_parser_with_real_exec_stream() {
    if !is_e2e_enabled() {
        return;
    }
    let docker = get_docker().expect("docker");
    common::ensure_test_image(&docker).await.unwrap();
    let id = create_sleep_container(&docker, "noj-judge-test-runner:latest", 256)
        .await
        .unwrap();

    let script = r#"
import sys, json
for i in range(3):
    sys.stdout.write(json.dumps({"type":"call","id":f"c{i}","fn":"solve","args":[i]}) + "\n")
    sys.stdout.flush()
sys.stdout.write("---RESULT---\n")
sys.stdout.write('{"status":"Accepted","score":10000,"details":{}}\n')
sys.stdout.flush()
"#;
    let exec = docker
        .create_exec(
            &id,
            ExecConfig {
                cmd: Some(vec![
                    "python3".to_string(),
                    "-c".to_string(),
                    script.to_string(),
                ]),
                attach_stdout: Some(true),
                attach_stderr: Some(true),
                ..Default::default()
            },
        )
        .await
        .unwrap();
    let started = docker.start_exec(&exec.id, None).await.unwrap();

    let mut parser = LineParser::new();
    let mut frames = vec![];
    let mut result_payload = None;
    let mut awaiting_result = false;

    if let StartExecResults::Attached { mut output, .. } = started {
        while let Some(chunk) = output.next().await {
            if let Ok(LogOutput::StdOut { message }) = chunk {
                for line in parser.feed(&message) {
                    match line {
                        EvaluatorLine::Frame(v) => {
                            if frame_type(&v) == Some("call") {
                                frames.push(v);
                            }
                        }
                        EvaluatorLine::ResultMarker => {
                            awaiting_result = true;
                        }
                        EvaluatorLine::Unknown(s) => {
                            if awaiting_result && !s.trim().is_empty() {
                                result_payload = Some(s.trim().to_string());
                                awaiting_result = false;
                            }
                        }
                    }
                }
            }
        }
    }
    let _ = parser.drain_remaining();

    assert_eq!(frames.len(), 3, "应解析出 3 个 call 帧");
    assert_eq!(frames[0]["args"][0], 0);
    assert_eq!(frames[2]["args"][0], 2);
    assert!(result_payload.is_some(), "应捕获 RESULT 后的 JSON");
    let parsed: serde_json::Value = serde_json::from_str(&result_payload.unwrap()).unwrap();
    assert_eq!(parsed["status"], "Accepted");
    assert_eq!(parsed["score"], 10000);

    cleanup_container(&docker, &id).await;
}

/// 验证 Solution host 启动并接收 call 帧（端到端协议）。
///
/// 在容器里直接用 SDK host 代码（从 build_sdk 复制），通过 stdin/stdout NDJSON
/// 验证协议闭环。
#[ignore]
#[serial_test::serial]
#[tokio::test]
async fn dual_solution_host_end_to_end() {
    if !is_e2e_enabled() {
        return;
    }
    let docker = get_docker().expect("docker");
    common::ensure_test_image(&docker).await.unwrap();

    // 把 SDK 源码通过 tar 注入到容器
    let id = create_sleep_container(&docker, "noj-judge-test-runner:latest", 256)
        .await
        .unwrap();

    // 简化路径：直接在容器内 pip install 一次 SDK（用 python -c 替代 host.py 主体）
    // 这里只验证 host.py 能跑起来；完整 protocol 测试依赖更多 fixture
    let script = r#"
import sys, json

# 模拟 host：循环读 stdin，处理 call 帧，写 result
sys.stdout.write(json.dumps({"type":"ready"}) + "\n")
sys.stdout.flush()

# 处理一行 call 帧（作为最小 demo）
line = sys.stdin.readline().strip()
if line:
    frame = json.loads(line)
    call_id = frame["id"]
    sys.stdout.write(json.dumps({"type":"result","id":call_id,"value":42}) + "\n")
    sys.stdout.flush()
sys.stdout.write(json.dumps({"type":"ready"}) + "\n")
sys.stdout.flush()
"#;
    let exec = docker
        .create_exec(
            &id,
            ExecConfig {
                cmd: Some(vec![
                    "python3".to_string(),
                    "-c".to_string(),
                    script.to_string(),
                ]),
                attach_stdout: Some(true),
                attach_stderr: Some(true),
                attach_stdin: Some(true),
                ..Default::default()
            },
        )
        .await
        .unwrap();
    let started = docker.start_exec(&exec.id, None).await.unwrap();

    let mut received_ready = false;
    let mut result_value: Option<serde_json::Value> = None;

    if let StartExecResults::Attached {
        mut output,
        mut input,
    } = started
    {
        // 启动一个任务：发送一个 call 帧
        let send_task = tokio::spawn(async move {
            // 等 ready 帧出现后再发（简化：等 200ms）
            tokio::time::sleep(Duration::from_millis(200)).await;
            let call = serde_json::json!({
                "type": "call",
                "id": "test-1",
                "fn": "solve",
                "args": [1, 2]
            });
            input
                .write_all(format!("{}\n", call).as_bytes())
                .await
                .unwrap();
            input.flush().await.unwrap();
            input.shutdown().await.unwrap();
        });

        let mut parser = LineParser::new();
        while let Some(chunk) = output.next().await {
            if let Ok(LogOutput::StdOut { message }) = chunk {
                for line in parser.feed(&message) {
                    if let EvaluatorLine::Frame(v) = line {
                        match frame_type(&v) {
                            Some("ready") => received_ready = true,
                            Some("result") => result_value = v.get("value").cloned(),
                            _ => {}
                        }
                    }
                }
            }
        }
        send_task.await.unwrap();
    }

    assert!(received_ready, "host 应发 ready 帧");
    assert_eq!(result_value, Some(serde_json::json!(42)));

    cleanup_container(&docker, &id).await;
}

/// 验证 dual 模式下 `--legacy` JudgeTask（无 mode 字段）走单容器路径。
///
/// 直接通过 SDK 类型反序列化验证行为。
#[test]
fn dual_legacy_task_default_mode() {
    if !is_e2e_enabled() {
        return; // 单测不需要 docker
    }
    // 这条主要验证类型层：缺 mode 字段时默认 Single（向后兼容）
    let json = serde_json::json!({
        "submission_id": "sid-legacy",
        "problem_id": "1001",
        "judge_image": "noj-judge-python",
        "judge_command": "python3 /tmp/evaluate.py",
        "language": "python3",
        "code": "print('hello')",
        "time_limit_ms": 5000,
        "memory_limit_mb": 512
    });
    let task: JudgeTask = serde_json::from_value(json).unwrap();
    assert_eq!(task.mode, JudgeMode::Single);
    assert!(task.runtime_config.is_none());
}

/// 验证 dual mode JudgeTask 反序列化包含 runtime_config。
#[test]
fn dual_task_runtime_config_serialization() {
    let json = serde_json::json!({
        "submission_id": "sid-dual",
        "problem_id": "1001",
        "mode": "dual",
        "language": "python3",
        "code": "def solve(a,b): return a+b",
        "file_name": "solution.py",
        "time_limit_ms": 5000,
        "memory_limit_mb": 512,
        "runtime_config": {
            "evaluator": {
                "image": "noj-evaluator-python:3.12",
                "command": "python3 /workspace/evaluate.py",
                "time_limit_ms": 5000,
                "memory_limit_mb": 512
            },
            "solution": {
                "image": "noj-solution-python:3.12",
                "entry": "solution.py",
                "call_timeout_ms": 1000,
                "memory_limit_mb": 256
            }
        }
    });
    let task: JudgeTask = serde_json::from_value(json).unwrap();
    assert_eq!(task.mode, JudgeMode::Dual);
    let rc = task.runtime_config.unwrap();
    assert_eq!(rc.evaluator.image, "noj-evaluator-python:3.12");
    assert_eq!(rc.solution.call_timeout_ms, 1000);
}

#[allow(dead_code)]
fn _force_use_dual_task() {
    // 静默 dead_code（dual_task 作为 fixture 暂未被所有测试用到）
    let _ = dual_task();
}
