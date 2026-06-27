//! 端到端验证：标准题全链路（容器 + per-case exec + 评分）。
//!
//! 补全 issue #66 端到端测试：模拟 run_standard_evaluate 的完整流程
//! （与 orchestrator 行为一致）：
//! 1. 创建测试容器（work_dir 挂载 /tmp）
//! 2. 写入 main.py + visible.jsonl + hidden.jsonl
//! 3. 对每个 case 执行 `sh -c "python3 /tmp/main.py < /tmp/case.in.N"`
//! 4. 收集 RunnerOutput
//! 5. 调用 `standard::score_cases` 和 `build_final_score_report` 评分
//! 6. 断言 status / score / 关键 details 字段
//!
//! 与 e2e_standard_judge.rs 的区别：
//! - 那里：调 evaluate_legacy → standard 返回 SystemError（路径不支持）
//! - 这里：直接复现 orchestrator 行为（手动调度 per-case exec + 评分）
//!   覆盖真实评分算法在容器输出上的表现

mod common;
use common::{
    create_test_container, ensure_test_image, get_docker, is_e2e_enabled, wait_container,
};

use noj_judge::judge::standard::{
    build_final_score_report, parse_jsonl_cases, score_cases, RunnerOutput, TestCase,
};
use noj_judge::pool::exec::execute_in_container;
use noj_judge::types::{JudgeStatus, JudgeType};

/// 共享辅助：把 visible.jsonl 写到 work_dir，注入容器并跑完，返回 (visible_outputs, hidden_outputs)。
async fn run_standard_judge_simulation(
    docker: &bollard::Docker,
    work_dir: &std::path::Path,
    container_id: &str,
    visible_jsonl: &str,
    hidden_jsonl: Option<&str>,
    user_code: &str,
) -> anyhow::Result<(
    Vec<TestCase>,
    Vec<RunnerOutput>,
    Vec<TestCase>,
    Vec<RunnerOutput>,
)> {
    // 1. 写入 main.py
    tokio::fs::write(work_dir.join("main.py"), user_code).await?;

    // 2. 写入 visible.jsonl / hidden.jsonl
    tokio::fs::write(work_dir.join("visible.jsonl"), visible_jsonl).await?;
    if let Some(h) = hidden_jsonl {
        tokio::fs::write(work_dir.join("hidden.jsonl"), h).await?;
    }

    // 3. 解析
    let visible_cases = parse_jsonl_cases(visible_jsonl)?;
    let hidden_cases = match hidden_jsonl {
        Some(content) if !content.trim().is_empty() => parse_jsonl_cases(content)?,
        _ => Vec::new(),
    };

    // 4. 逐 case 执行（与 orchestrator 完全一致的 per-case 调度：sh -c "python3 ... < /tmp/case.in.N"）
    let mut visible_outputs = Vec::with_capacity(visible_cases.len());
    for (idx, case) in visible_cases.iter().enumerate() {
        let cmd_str = format!("python3 /tmp/main.py < /tmp/case.in.{}", idx);
        // 必须用 sh -c 包一层，parse_command 不处理 < 重定向
        let cmd_parts = vec!["sh".to_string(), "-c".to_string(), cmd_str];
        // 把 stdin 写到 case.in.N
        tokio::fs::write(work_dir.join(format!("case.in.{}", idx)), &case.input).await?;
        let (stdout, stderr, exit_code, time_ms) =
            execute_in_container(docker, container_id, &cmd_parts, 5000, 2).await?;
        visible_outputs.push(RunnerOutput {
            stdout,
            stderr,
            exit_code,
            time_ms,
            memory_kb: 0,
        });
    }

    // 5. hidden（如果有）
    let mut hidden_outputs = Vec::with_capacity(hidden_cases.len());
    for (idx, case) in hidden_cases.iter().enumerate() {
        let cmd_str = format!("python3 /tmp/main.py < /tmp/case.in.h.{}", idx);
        let cmd_parts = vec!["sh".to_string(), "-c".to_string(), cmd_str];
        tokio::fs::write(work_dir.join(format!("case.in.h.{}", idx)), &case.input).await?;
        let (stdout, stderr, exit_code, time_ms) =
            execute_in_container(docker, container_id, &cmd_parts, 5000, 2).await?;
        hidden_outputs.push(RunnerOutput {
            stdout,
            stderr,
            exit_code,
            time_ms,
            memory_kb: 0,
        });
    }

    Ok((visible_cases, visible_outputs, hidden_cases, hidden_outputs))
}

// ── E2E #1: 标准题全部正确 → Accepted, score=1000 ──

#[ignore]
#[serial_test::serial]
#[tokio::test]
async fn test_e2e_standard_judge_all_correct_accepted() {
    if !is_e2e_enabled() {
        return;
    }

    let docker = get_docker().expect("Docker 连接失败");
    ensure_test_image(&docker).await.expect("测试镜像缺失");

    let user_code = "print(sum(map(int, input().split())))";
    let visible_jsonl = "{\"id\":\"v001\",\"input\":\"1 2\\n\",\"expected\":3}\n\
                          {\"id\":\"v002\",\"input\":\"5 7\\n\",\"expected\":12}\n\
                          {\"id\":\"v003\",\"input\":\"10 20\\n\",\"expected\":30}\n";
    let hidden_jsonl = "{\"id\":\"h001\",\"input\":\"100 200\\n\",\"expected\":300}\n\
                         {\"id\":\"h002\",\"input\":\"0 0\\n\",\"expected\":0}\n";

    let (container_id, work_dir) = create_test_container(
        &docker,
        "noj-judge-test-runner",
        &["sleep", "300"],
        256,
        60_000,
    )
    .await
    .expect("创建测试容器失败");

    let result = run_standard_judge_simulation(
        &docker,
        &work_dir,
        &container_id,
        visible_jsonl,
        Some(hidden_jsonl),
        user_code,
    )
    .await
    .expect("标准评测模拟失败");

    let (visible_cases, visible_outputs, hidden_cases, hidden_outputs) = result;

    // 验证所有 case 实际执行成功
    for (i, out) in visible_outputs.iter().enumerate() {
        assert_eq!(
            out.exit_code, 0,
            "visible case {} 失败: stderr={}",
            i, out.stderr
        );
    }
    for (i, out) in hidden_outputs.iter().enumerate() {
        assert_eq!(
            out.exit_code, 0,
            "hidden case {} 失败: stderr={}",
            i, out.stderr
        );
    }

    // 验证评分算法
    let visible_report = score_cases(&visible_cases, &visible_outputs);
    let hidden_report = score_cases(&hidden_cases, &hidden_outputs);
    let (report, status, score) = build_final_score_report(visible_report, hidden_report, true);

    assert_eq!(status, JudgeStatus::Accepted.as_str());
    assert_eq!(score, 1000); // 10.00 分 × 100
    assert_eq!(report.visible.passed, 3);
    assert_eq!(report.hidden.passed, 2);
    assert!(report.visible.all_valid_int);
    assert!(report.hidden.all_valid_int);

    // 清理
    let _ = wait_container(&docker, &container_id, 1000).await;
    let _ = tokio::fs::remove_dir_all(&work_dir).await;
}

// ── E2E #2: 标准题部分错 → WrongAnswer, 正确分数 ──

#[ignore]
#[serial_test::serial]
#[tokio::test]
async fn test_e2e_standard_judge_partial_wrong_wrong_answer() {
    if !is_e2e_enabled() {
        return;
    }

    let docker = get_docker().expect("Docker 连接失败");
    ensure_test_image(&docker).await.expect("测试镜像缺失");

    // 用户代码只答对部分 case
    let user_code = "n = int(input().strip())\nif n % 2 == 0:\n    print(n)\nelse:\n    print(0)";
    let visible_jsonl = "{\"id\":\"v001\",\"input\":\"2\\n\",\"expected\":2}\n\
                          {\"id\":\"v002\",\"input\":\"3\\n\",\"expected\":3}\n\
                          {\"id\":\"v003\",\"input\":\"4\\n\",\"expected\":4}\n";

    let (container_id, work_dir) = create_test_container(
        &docker,
        "noj-judge-test-runner",
        &["sleep", "300"],
        256,
        60_000,
    )
    .await
    .expect("创建测试容器失败");

    let result = run_standard_judge_simulation(
        &docker,
        &work_dir,
        &container_id,
        visible_jsonl,
        None,
        user_code,
    )
    .await
    .expect("标准评测模拟失败");

    let (visible_cases, visible_outputs, _, _) = result;
    let visible_report = score_cases(&visible_cases, &visible_outputs);
    let empty_hidden = noj_judge::judge::standard::SplitReport {
        passed: 0,
        total: 0,
        all_valid_int: true,
        cases: vec![],
    };
    let (_, status, score) = build_final_score_report(visible_report, empty_hidden, false);

    // 期望：v001 通过(2==2)，v002 失败(0!=3)，v003 通过(4==4)
    // 2/3 passed → score_content = 8.0 * 2/3 ≈ 5.33
    // 整数格式全对 → score_format = 2.0
    // total ≈ 7.33 → score=733
    assert_eq!(status, JudgeStatus::WrongAnswer.as_str());
    assert_eq!(score, 733);
    assert!(!visible_outputs.is_empty());

    let _ = wait_container(&docker, &container_id, 1000).await;
    let _ = tokio::fs::remove_dir_all(&work_dir).await;
}

// ── E2E #3: 标准题格式错（print("3.0")）→ WrongAnswer, content 满分但 format 0 ──

#[ignore]
#[serial_test::serial]
#[tokio::test]
async fn test_e2e_standard_judge_format_fail_wrong_answer() {
    if !is_e2e_enabled() {
        return;
    }

    let docker = get_docker().expect("Docker 连接失败");
    ensure_test_image(&docker).await.expect("测试镜像缺失");

    // 用户代码：内容对但格式错（"3.0" 而不是 "3"）
    let user_code = "a, b = map(int, input().split())\nprint(f'{a + b}.0')";
    let visible_jsonl = "{\"id\":\"v001\",\"input\":\"1 2\\n\",\"expected\":3}\n";

    let (container_id, work_dir) = create_test_container(
        &docker,
        "noj-judge-test-runner",
        &["sleep", "300"],
        256,
        60_000,
    )
    .await
    .expect("创建测试容器失败");

    let result = run_standard_judge_simulation(
        &docker,
        &work_dir,
        &container_id,
        visible_jsonl,
        None,
        user_code,
    )
    .await
    .expect("标准评测模拟失败");

    let (visible_cases, visible_outputs, _, _) = result;
    let visible_report = score_cases(&visible_cases, &visible_outputs);
    let empty_hidden = noj_judge::judge::standard::SplitReport {
        passed: 0,
        total: 0,
        all_valid_int: true,
        cases: vec![],
    };
    let (_, status, score) = build_final_score_report(visible_report.clone(), empty_hidden, false);

    // 内容错（"3.0" != "3"）→ content_ok=false
    // 格式错（"3.0" 不是整数）→ all_valid_int=false
    // score_content=0, score_format=0, total=0 → score=0, status=WrongAnswer
    assert_eq!(status, JudgeStatus::WrongAnswer.as_str());
    assert_eq!(score, 0);
    assert!(!visible_report.cases[0].content_ok);
    assert!(!visible_report.all_valid_int);

    let _ = wait_container(&docker, &container_id, 1000).await;
    let _ = tokio::fs::remove_dir_all(&work_dir).await;
}

// ── E2E #4: 标准题超时（无限循环）→ TLE ──

#[ignore]
#[serial_test::serial]
#[tokio::test]
async fn test_e2e_standard_judge_timeout() {
    if !is_e2e_enabled() {
        return;
    }

    let docker = get_docker().expect("Docker 连接失败");
    ensure_test_image(&docker).await.expect("测试镜像缺失");

    // 用户代码：读 case.in.0（不消耗 stdin）→ while True
    // 用 time_limit_ms=500 强制超时
    let user_code = "import time; time.sleep(10)";
    let visible_jsonl = "{\"id\":\"v001\",\"input\":\"1 2\\n\",\"expected\":3}\n";

    let (container_id, work_dir) = create_test_container(
        &docker,
        "noj-judge-test-runner",
        &["sleep", "300"],
        256,
        60_000,
    )
    .await
    .expect("创建测试容器失败");

    tokio::fs::write(work_dir.join("main.py"), user_code)
        .await
        .unwrap();
    let visible_cases = parse_jsonl_cases(visible_jsonl).unwrap();
    tokio::fs::write(work_dir.join("case.in.0"), &visible_cases[0].input)
        .await
        .unwrap();

    let cmd_parts = vec![
        "sh".to_string(),
        "-c".to_string(),
        "python3 /tmp/main.py < /tmp/case.in.0".to_string(),
    ];
    let (_stdout, _stderr, exit_code, _time_ms) = execute_in_container(
        &docker,
        &container_id,
        &cmd_parts,
        500, // 500ms 超时
        2,
    )
    .await
    .expect("exec 失败");

    // 验证超时：exit_code 应该为 -1（execute_in_container 的超时信号）
    assert_eq!(exit_code, -1, "TLE 应返回 exit_code=-1，实际 {}", exit_code);

    let _ = wait_container(&docker, &container_id, 1000).await;
    let _ = tokio::fs::remove_dir_all(&work_dir).await;
}

// ── E2E #5: 标准题 hidden 缺失 → 仍可评分（hidden_provided=false）──

#[ignore]
#[serial_test::serial]
#[tokio::test]
async fn test_e2e_standard_judge_no_hidden_data() {
    if !is_e2e_enabled() {
        return;
    }

    let docker = get_docker().expect("Docker 连接失败");
    ensure_test_image(&docker).await.expect("测试镜像缺失");

    let user_code = "print(int(input().strip()) * 2)";
    let visible_jsonl = "{\"id\":\"v001\",\"input\":\"5\\n\",\"expected\":10}\n\
                          {\"id\":\"v002\",\"input\":\"7\\n\",\"expected\":14}\n";

    let (container_id, work_dir) = create_test_container(
        &docker,
        "noj-judge-test-runner",
        &["sleep", "300"],
        256,
        60_000,
    )
    .await
    .expect("创建测试容器失败");

    let result = run_standard_judge_simulation(
        &docker,
        &work_dir,
        &container_id,
        visible_jsonl,
        None, // 无 hidden.jsonl
        user_code,
    )
    .await
    .expect("标准评测模拟失败");

    let (visible_cases, visible_outputs, _, _) = result;
    let visible_report = score_cases(&visible_cases, &visible_outputs);
    let empty_hidden = noj_judge::judge::standard::SplitReport {
        passed: 0,
        total: 0,
        all_valid_int: true,
        cases: vec![],
    };
    let (report, status, score) = build_final_score_report(visible_report, empty_hidden, false);

    assert!(!report.hidden_provided);
    assert_eq!(status, JudgeStatus::Accepted.as_str());
    assert_eq!(score, 1000); // 2/2 + format=2.0 → 10.0

    let _ = wait_container(&docker, &container_id, 1000).await;
    let _ = tokio::fs::remove_dir_all(&work_dir).await;
}

// ── E2E #6: 用户代码带 debug 输出 → 末行提取正确 ──

#[ignore]
#[serial_test::serial]
#[tokio::test]
async fn test_e2e_standard_judge_debug_output_extraction() {
    if !is_e2e_enabled() {
        return;
    }

    let docker = get_docker().expect("Docker 连接失败");
    ensure_test_image(&docker).await.expect("测试镜像缺失");

    // 用户代码：print debug + 最终答案
    let user_code = "import sys\nprint(\"DEBUG: starting\", file=sys.stderr)\na, b = map(int, input().split())\nprint(f\"DEBUG: a={a}, b={b}\")\nprint(a + b)";
    let visible_jsonl = "{\"id\":\"v001\",\"input\":\"1 2\\n\",\"expected\":3}\n";

    let (container_id, work_dir) = create_test_container(
        &docker,
        "noj-judge-test-runner",
        &["sleep", "300"],
        256,
        60_000,
    )
    .await
    .expect("创建测试容器失败");

    let result = run_standard_judge_simulation(
        &docker,
        &work_dir,
        &container_id,
        visible_jsonl,
        None,
        user_code,
    )
    .await
    .expect("标准评测模拟失败");

    let (visible_cases, visible_outputs, _, _) = result;

    // 验证末行提取：stdout 应包含 "DEBUG: a=1, b=2" 和 "3"，末行是 "3"
    assert!(visible_outputs[0].stdout.contains("DEBUG"));
    let visible_report = score_cases(&visible_cases, &visible_outputs);

    // 末行应是 "3"，与 expected 匹配
    assert_eq!(visible_report.cases[0].actual, "3");
    assert!(visible_report.cases[0].content_ok);

    let _ = wait_container(&docker, &container_id, 1000).await;
    let _ = tokio::fs::remove_dir_all(&work_dir).await;
}

// ── E2E #7: JudgeTask 旧消息向后兼容（无 judge_type 字段）──

#[ignore]
#[serial_test::serial]
#[tokio::test]
async fn test_e2e_legacy_judge_task_compatibility() {
    if !is_e2e_enabled() {
        return;
    }

    // 关键回归：从旧 noj-core 推送的消息无 judge_type 字段，
    // 必须是 JudgeType::Special（确保 SPJ 题目走原路径）
    let legacy_json = r#"{
        "submission_id": "legacy-e2e-001",
        "problem_id": "1001",
        "judge_image": "noj-judge-python",
        "judge_command": "python3 /tmp/evaluate.py",
        "language": "python3",
        "code": "print('hello')",
        "time_limit_ms": 5000,
        "memory_limit_mb": 512
    }"#;

    let task: noj_judge::types::JudgeTask =
        serde_json::from_str(legacy_json).expect("旧消息反序列化失败");
    assert_eq!(task.judge_type, JudgeType::Special);
    assert_eq!(task.submission_id, "legacy-e2e-001");
    assert_eq!(task.judge_command, "python3 /tmp/evaluate.py");
}
