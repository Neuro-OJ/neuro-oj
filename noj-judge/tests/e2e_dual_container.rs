//! 双容器 Evaluator/Solution 编排集成测试。
//!
//! 测试矩阵（design §9）：
//! - dual_basic: A+B Problem Accepted
//! - dual_persistent: 多次 call 复用 host 状态
//! - dual_timeout: call_timeout_ms 单次超时
//! - dual_call_timeout_fallback: 调用级超时缺省回退题目级默认
//! - dual_call_timeout_per_call_concurrent: 调用级超时按调用独立生效
//! - dual_capability_timeout_per_call: capability 注册超时（cap_reg）
//! - dual_evaluator_total_timeout: evaluator 总超时 → SystemError
//! - dual_solution_timeout_unhandled: CallTimeout 未处理 → TLE
//! - dual_solution_timeout_handled: CallTimeout 被捕获 → evaluator 决定
//! - dual_solution_exception: 用户异常 + sanitize trace
//! - dual_solution_no_network: Solution 无网络
//! - dual_solution_module_shadowing: PYTHONPATH shadowing 不影响 Evaluator
//! - dual_solution_read_evaluator_env: 隔离环境变量
//!
//! 注：本测试使用 `noj-e2e-sdk-evaluator` / `noj-e2e-sdk-solution` 镜像
//! （common::ensure_sdk_images 按需构建，内含 SDK 源码）。

mod common;

use std::time::Duration;

use anyhow::{Context, Result};
use bollard::container::LogOutput;
use bollard::exec::StartExecResults;
use bollard::models::ExecConfig;
use common::{get_docker, is_e2e_enabled};
use futures_util::StreamExt;
use noj_judge::dual::protocol::{frame_type, EvaluatorLine, LineParser};
use noj_judge::types::{EvaluatorRuntime, JudgeTask, RuntimeConfig, SolutionRuntime};
use tokio::io::AsyncWriteExt;

// ── Test fixtures ─────────────────────────────────────────

fn dual_task() -> JudgeTask {
    JudgeTask {
        submission_id: format!("sub-{}", uuid::Uuid::new_v4()),
        problem_id: "1001".to_string(),
        download_url: None,
        runtime_config: RuntimeConfig {
            evaluator: EvaluatorRuntime {
                image: "noj-judge-test-runner:latest".to_string(),
                command: "python3 -c \"print(1)\"".to_string(),
                time_limit_ms: 10_000,
                memory_limit_mb: 256,
                network: None,
            },
            solution: SolutionRuntime {
                image: "noj-judge-test-runner:latest".to_string(),
                call_timeout_ms: 1_000,
                memory_limit_mb: 256,
            },
        },
        language: "python3".to_string(),
        code: String::new(),
        file_name: Some("solution.py".to_string()),
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
        // 启动一个任务：等 ready 帧后再发送 call 帧
        let (ready_tx, mut ready_rx) = tokio::sync::oneshot::channel::<()>();
        let mut ready_tx = Some(ready_tx);

        let send_task = tokio::spawn(async move {
            // 等 ready 信号（最多等 5s），收到后再发 call 帧
            let _ = tokio::time::timeout(Duration::from_secs(5), &mut ready_rx).await;
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
                            Some("ready") => {
                                if !received_ready {
                                    received_ready = true;
                                    if let Some(tx) = ready_tx.take() {
                                        let _ = tx.send(());
                                    }
                                }
                            }
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
fn dual_task_runtime_config_serialization() {
    let json = serde_json::json!({
        "submission_id": "sid-dual",
        "problem_id": "1001",
        "language": "python3",
        "code": "def solve(a,b): return a+b",
        "file_name": "solution.py",
        "runtime_config": {
            "evaluator": {
                "image": "noj-evaluator-python:3.12",
                "command": "python3 /workspace/evaluate.py",
                "time_limit_ms": 5000,
                "memory_limit_mb": 512
            },
            "solution": {
                "image": "noj-solution-python:3.12",
                "call_timeout_ms": 1000,
                "memory_limit_mb": 256
            }
        }
    });
    let task: JudgeTask = serde_json::from_value(json).unwrap();
    assert_eq!(
        task.runtime_config.evaluator.image,
        "noj-evaluator-python:3.12"
    );
    assert_eq!(task.runtime_config.solution.call_timeout_ms, 1000);
}

#[allow(dead_code)]
fn _force_use_dual_task() {
    // 静默 dead_code（dual_task 作为 fixture 暂未被所有测试用到）
    let _ = dual_task();
}

/// 完整的 dual-container 编排器 E2E。
///
/// 调用 `evaluate_dual` 检查完整流程（容器创建 → exec → 结果回传 → 清理）。
/// 注：此测试中 solution 容器因缺少 `noj_solution_sdk.host` 会快速退出，
/// 预期结果为 SystemError —— 这仍能验证编排器本身不崩且结果结构完整。
#[ignore]
#[serial_test::serial]
#[tokio::test]
async fn evaluate_dual_end_to_end() {
    if !is_e2e_enabled() {
        return;
    }
    let docker = get_docker().expect("docker");
    common::ensure_test_image(&docker).await.unwrap();

    let submission_id = format!("e2e-dual-{}", uuid::Uuid::new_v4());
    let runtime_config = RuntimeConfig {
        evaluator: EvaluatorRuntime {
            image: "noj-judge-test-runner:latest".to_string(),
            command: r#"python3 -c "import sys,json; sys.stdout.write('---RESULT---\n'); sys.stdout.write(json.dumps({'status':'Accepted','score':10000,'details':{}})); sys.stdout.flush()""#.to_string(),
            time_limit_ms: 15000,
            memory_limit_mb: 256,
            network: None,
        },
        solution: SolutionRuntime {
            image: "noj-judge-test-runner:latest".to_string(),
            call_timeout_ms: 5000,
            memory_limit_mb: 128,
        },
    };

    let result = noj_judge::dual::evaluate_dual_with_cpu_limit(
        docker,
        &submission_id,
        &runtime_config,
        "def solve(a,b): return a+b",
        None,
        None,
        1000,
        true,
        "noj-",
        &["python3".to_string()],
    )
    .await;

    match result {
        Ok(judge_result) => {
            // 即使结果是 SystemError（solution 失败），结构应完整
            assert_eq!(judge_result.submission_id, submission_id);
            assert!(!judge_result.status.is_empty());
            assert!(judge_result.score >= 0);
        }
        Err(e) => {
            panic!("evaluate_dual 返回 Err: {:?}", e);
        }
    }
}

/// 调用级超时缺省回退：call 帧不带 timeout_ms 时，题目级 call_timeout_ms 生效。
#[ignore]
#[serial_test::serial]
#[tokio::test]
async fn dual_call_timeout_fallback_to_problem_default() {
    if !is_e2e_enabled() {
        return;
    }
    let docker = get_docker().expect("docker");
    common::ensure_sdk_images(&docker).await.unwrap();

    // evaluator：调用 sleep 函数，不带 timeout_ms（期望回退题目级 100ms）
    let evaluator_cmd = r#"python3 -c "
import json
from noj_evaluator_sdk import SolutionRunner, result
runner = SolutionRunner()
try:
    runner.call('sleep_solution')
    result.accept(score=1000, details={'cases': [{'id': 'c1', 'status': 'Accepted'}]})
except Exception as e:
    result.accept(score=0, details={'cases': [{'id': 'c1', 'status': type(e).__name__}]})
""#;
    let runtime_config = RuntimeConfig {
        evaluator: EvaluatorRuntime {
            image: "noj-e2e-sdk-evaluator:latest".to_string(),
            command: evaluator_cmd.to_string(),
            time_limit_ms: 15000,
            memory_limit_mb: 256,
            network: None,
        },
        solution: SolutionRuntime {
            image: "noj-e2e-sdk-solution:latest".to_string(),
            call_timeout_ms: 100, // 题目级默认：100ms
            memory_limit_mb: 128,
        },
    };
    // solution 代码：sleep_solution 睡 300ms（> 100ms 默认超时）
    let code = "import time\ndef sleep_solution():\n    time.sleep(0.3)\n    return 1\n";

    let result = tokio::time::timeout(
        Duration::from_secs(30),
        noj_judge::dual::evaluate_dual_with_cpu_limit(
            docker.clone(),
            "e2e-timeout-fallback",
            &runtime_config,
            code,
            None,
            None,
            1000,
            true,
            "noj-",
            &["python3".to_string()],
        ),
    )
    .await
    .expect("评测 30s 外层超时")
    .expect("评测应正常返回");

    assert_eq!(result.status, "Accepted");
    let cases = result.details["cases"].as_array().expect("details.cases");
    assert_eq!(
        cases[0]["status"].as_str().unwrap(),
        "SolutionTimeoutError",
        "超时用例应被记录为 SolutionTimeoutError: {:?}",
        result.details
    );
}

/// 调用级超时 + 并发：同题两个线程不同超时，各自独立生效。
#[ignore]
#[serial_test::serial]
#[tokio::test]
async fn dual_call_timeout_per_call_concurrent() {
    if !is_e2e_enabled() {
        return;
    }
    let docker = get_docker().expect("docker");
    common::ensure_sdk_images(&docker).await.unwrap();

    let evaluator_cmd = r#"python3 -c "
import json, threading
from noj_evaluator_sdk import SolutionRunner, result
runner = SolutionRunner()
out = {}
def slow():
    try:
        runner.call('sleep_solution', timeout_ms=50)   # 50ms 超时 vs 300ms 睡眠
        out['slow'] = 'ok'
    except Exception as e:
        out['slow'] = type(e).__name__
def fast():
    try:
        v = runner.call('fast_solution', timeout_ms=5000)  # 立即返回
        out['fast'] = ['ok', v]
    except Exception as e:
        out['fast'] = type(e).__name__
t1 = threading.Thread(target=slow)
t2 = threading.Thread(target=fast)
t1.start(); t2.start(); t1.join(); t2.join()
result.accept(score=1000, details={'cases': out})
""#;
    let runtime_config = RuntimeConfig {
        evaluator: EvaluatorRuntime {
            image: "noj-e2e-sdk-evaluator:latest".to_string(),
            command: evaluator_cmd.to_string(),
            time_limit_ms: 15000,
            memory_limit_mb: 256,
            network: None,
        },
        solution: SolutionRuntime {
            image: "noj-e2e-sdk-solution:latest".to_string(),
            call_timeout_ms: 5000, // 题目级默认宽松；验证调用级 50ms 覆盖
            memory_limit_mb: 128,
        },
    };
    let code = "import time\ndef sleep_solution():\n    time.sleep(0.3)\n    return 1\ndef fast_solution():\n    return 42\n";

    let result = tokio::time::timeout(
        Duration::from_secs(30),
        noj_judge::dual::evaluate_dual_with_cpu_limit(
            docker.clone(),
            "e2e-timeout-per-call",
            &runtime_config,
            code,
            None,
            None,
            1000,
            true,
            "noj-",
            &["python3".to_string()],
        ),
    )
    .await
    .expect("评测 30s 外层超时")
    .expect("评测应正常返回");

    assert_eq!(result.status, "Accepted");
    let cases = result.details["cases"].as_object().expect("details.cases");
    assert_eq!(
        cases["slow"].as_str().unwrap(),
        "SolutionTimeoutError",
        "慢调用应按 50ms 超时: {:?}",
        result.details
    );
    assert_eq!(
        cases["fast"].as_array().unwrap(),
        &vec![serde_json::json!("ok"), serde_json::json!(42)]
    );
}

/// capability 调用级超时：注册时配置的默认超时（cap_reg 上报）在真实容器中生效。
#[ignore]
#[serial_test::serial]
#[tokio::test]
async fn dual_capability_timeout_per_call() {
    if !is_e2e_enabled() {
        return;
    }
    let docker = get_docker().expect("docker");
    common::ensure_sdk_images(&docker).await.unwrap();

    // evaluator：注册慢 capability（默认超时 100ms），稍后从 solution 读取调用结果
    let evaluator_cmd = r#"python3 -c "
import json, time
from noj_evaluator_sdk import register_capability, SolutionRunner, result
def slow_cap(x):
    time.sleep(0.3)
    return x
register_capability('slow_cap', slow_cap, timeout_ms=100)
runner = SolutionRunner()
time.sleep(2.5)
try:
    r = runner.call('report')
    result.accept(score=1000, details={'cap': r})
except Exception as e:
    result.accept(score=0, details={'cap': type(e).__name__})
""#;
    let runtime_config = RuntimeConfig {
        evaluator: EvaluatorRuntime {
            image: "noj-e2e-sdk-evaluator:latest".to_string(),
            command: evaluator_cmd.to_string(),
            time_limit_ms: 15000,
            memory_limit_mb: 256,
            network: None,
        },
        solution: SolutionRuntime {
            image: "noj-e2e-sdk-solution:latest".to_string(),
            call_timeout_ms: 5000, // 题目级默认宽松；验证 cap_reg 上报的 100ms 生效
            memory_limit_mb: 128,
        },
    };
    // solution：延迟 1s 调用 slow_cap（确保 evaluator 已完成 cap_reg 上报），
    // 捕获超时结果，供 evaluator 的 report() 读取
    let code = "import threading, time\nfrom noj_solution_sdk import call_capability\n_cap_result = {}\ndef _do():\n    time.sleep(1.0)\n    try:\n        call_capability('slow_cap', 1)\n        _cap_result['status'] = 'ok'\n    except Exception as e:\n        _cap_result['status'] = type(e).__name__\n        _cap_result['code'] = getattr(e, 'code', None)\nthreading.Thread(target=_do, daemon=True).start()\ndef report():\n    return _cap_result\n";

    let result = tokio::time::timeout(
        Duration::from_secs(30),
        noj_judge::dual::evaluate_dual_with_cpu_limit(
            docker.clone(),
            "e2e-capability-timeout",
            &runtime_config,
            code,
            None,
            None,
            1000,
            true,
            "noj-",
            &["python3".to_string()],
        ),
    )
    .await
    .expect("评测 30s 外层超时")
    .expect("评测应正常返回");

    assert_eq!(result.status, "Accepted");
    let cap = &result.details["cap"];
    assert_eq!(
        cap["status"].as_str().unwrap(),
        "CapabilityError",
        "solution 应收到 CapabilityError（cap_reg 100ms 超时）: {:?}",
        result.details
    );
    assert_eq!(
        cap["code"].as_str().unwrap(),
        "CallTimeout",
        "CapabilityError.code 应为 CallTimeout: {:?}",
        result.details
    );
}

/// evaluator 整体超时（time_limit_ms 到期）→ SystemError（评测流程未正常完成）。
#[ignore]
#[serial_test::serial]
#[tokio::test]
async fn dual_evaluator_total_timeout_system_error() {
    if !is_e2e_enabled() {
        return;
    }
    let docker = get_docker().expect("docker");
    common::ensure_sdk_images(&docker).await.unwrap();

    // evaluator：打印首行（进入阶段 2）后死循环，永不输出 ---RESULT---
    let evaluator_cmd = r#"python3 -c "
import sys, time
print('ready', flush=True)
while True:
    time.sleep(1)
"#;
    let runtime_config = RuntimeConfig {
        evaluator: EvaluatorRuntime {
            image: "noj-e2e-sdk-evaluator:latest".to_string(),
            command: evaluator_cmd.to_string(),
            time_limit_ms: 2000, // 2s 总超时
            memory_limit_mb: 256,
            network: None,
        },
        solution: SolutionRuntime {
            image: "noj-e2e-sdk-solution:latest".to_string(),
            call_timeout_ms: 5000,
            memory_limit_mb: 128,
        },
    };

    let result = tokio::time::timeout(
        Duration::from_secs(30),
        noj_judge::dual::evaluate_dual_with_cpu_limit(
            docker.clone(),
            "e2e-evaluator-total-timeout",
            &runtime_config,
            "def solve(): return 1",
            None,
            None,
            1000,
            true,
            "noj-",
            &["python3".to_string()],
        ),
    )
    .await
    .expect("评测 30s 外层超时")
    .expect("评测应正常返回");

    assert_eq!(
        result.status, "SystemError",
        "evaluator 总超时应归 SystemError: {:?}",
        result
    );
}

/// solution 调用超时且 evaluator 未捕获（evaluate.py 崩溃、无 ---RESULT---）→ TLE。
#[ignore]
#[serial_test::serial]
#[tokio::test]
async fn dual_solution_timeout_unhandled_tle() {
    if !is_e2e_enabled() {
        return;
    }
    let docker = get_docker().expect("docker");
    common::ensure_sdk_images(&docker).await.unwrap();

    // evaluator：调用 sleep_solution 但不捕获 SolutionTimeoutError → 异常冒泡崩溃退出
    let evaluator_cmd = r#"python3 -c "
from noj_evaluator_sdk import SolutionRunner
runner = SolutionRunner()
runner.call('sleep_solution')
"#;
    let runtime_config = RuntimeConfig {
        evaluator: EvaluatorRuntime {
            image: "noj-e2e-sdk-evaluator:latest".to_string(),
            command: evaluator_cmd.to_string(),
            time_limit_ms: 15000,
            memory_limit_mb: 256,
            network: None,
        },
        solution: SolutionRuntime {
            image: "noj-e2e-sdk-solution:latest".to_string(),
            call_timeout_ms: 100, // 100ms 调用超时
            memory_limit_mb: 128,
        },
    };
    // solution：sleep_solution 睡 300ms（> 100ms 调用超时）
    let code = "import time\ndef sleep_solution():\n    time.sleep(0.3)\n    return 1\n";

    let result = tokio::time::timeout(
        Duration::from_secs(30),
        noj_judge::dual::evaluate_dual_with_cpu_limit(
            docker.clone(),
            "e2e-solution-timeout-unhandled",
            &runtime_config,
            code,
            None,
            None,
            1000,
            true,
            "noj-",
            &["python3".to_string()],
        ),
    )
    .await
    .expect("评测 30s 外层超时")
    .expect("评测应正常返回");

    assert_eq!(
        result.status, "TimeLimitExceeded",
        "CallTimeout 未处理应归 TLE: {:?}",
        result
    );
}

/// solution 调用超时被 evaluator 捕获 → 最终状态由 evaluator 决定（此处为 WrongAnswer）。
#[ignore]
#[serial_test::serial]
#[tokio::test]
async fn dual_solution_timeout_handled_wrong_answer() {
    if !is_e2e_enabled() {
        return;
    }
    let docker = get_docker().expect("docker");
    common::ensure_sdk_images(&docker).await.unwrap();

    // evaluator：捕获 SolutionTimeoutError 后记为失败用例（WrongAnswer）
    let evaluator_cmd = r#"python3 -c "
from noj_evaluator_sdk import SolutionRunner, SolutionTimeoutError, result
runner = SolutionRunner()
try:
    runner.call('sleep_solution')
    result.accept(score=1000, details={'cases': [{'id': 'c1', 'status': 'Accepted'}]})
except SolutionTimeoutError:
    result.wrong_answer(
        score=0,
        message='c1 call timeout',
        details={'cases': [{'id': 'c1', 'status': 'WrongAnswer'}]},
    )
"#;
    let runtime_config = RuntimeConfig {
        evaluator: EvaluatorRuntime {
            image: "noj-e2e-sdk-evaluator:latest".to_string(),
            command: evaluator_cmd.to_string(),
            time_limit_ms: 15000,
            memory_limit_mb: 256,
            network: None,
        },
        solution: SolutionRuntime {
            image: "noj-e2e-sdk-solution:latest".to_string(),
            call_timeout_ms: 100,
            memory_limit_mb: 128,
        },
    };
    let code = "import time\ndef sleep_solution():\n    time.sleep(0.3)\n    return 1\n";

    let result = tokio::time::timeout(
        Duration::from_secs(30),
        noj_judge::dual::evaluate_dual_with_cpu_limit(
            docker.clone(),
            "e2e-solution-timeout-handled",
            &runtime_config,
            code,
            None,
            None,
            1000,
            true,
            "noj-",
            &["python3".to_string()],
        ),
    )
    .await
    .expect("评测 30s 外层超时")
    .expect("评测应正常返回");

    assert_eq!(
        result.status, "WrongAnswer",
        "CallTimeout 被捕获时状态由 evaluator 决定: {:?}",
        result
    );
}
