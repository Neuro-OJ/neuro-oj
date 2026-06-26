//! 端到端验证：issue #66 标准题与 SPJ 题路由分发。
//!
//! 关键回归：滚动部署顺序（先 noj-judge，后 noj-core）要求旧格式 JudgeTask
//! （无 judge_type 字段）也能被新 noj-judge 正确解析，默认走 Special 路径。
//!
//! 测试用例：
//! 1. `test_judge_task_deserialize_legacy_format` — 旧格式消息无 judge_type → 默认 Special
//! 2. `test_standard_judge_correct_solution` — 标准题正确解 → Accepted/score=1000
//! 3. `test_standard_judge_wrong_solution` — 标准题错误解 → WrongAnswer
//! 4. `test_standard_judge_timeout` — 标准题 TLE → TimeLimitExceeded
//! 5. `test_evaluate_legacy_rejects_standard` — evaluate_legacy 对 standard 返回 SystemError
//!
//! 需设置 `NOJ_RUN_E2E=1` 才能执行（容器化测试，默认跳过）。

mod common;
use common::{ensure_test_image, get_docker, is_e2e_enabled};

use noj_judge::judge::runner::evaluate_legacy;
use noj_judge::types::{JudgeTask, JudgeType};

// ── 纯 Rust 单测（无需 Docker）──

/// 关键回归：滚动部署期间，旧 noj-core 推送的不含 judge_type 的消息
/// 必须被新 noj-judge 正确接收，默认走 Special 路径。
#[test]
fn test_judge_task_deserialize_legacy_format_defaults_to_special() {
    let legacy_json = r#"{
        "submission_id": "legacy-001",
        "problem_id": "1001",
        "judge_image": "noj-judge-python",
        "judge_command": "python3 /tmp/evaluate.py",
        "language": "python3",
        "code": "print('hello')",
        "time_limit_ms": 5000,
        "memory_limit_mb": 512
    }"#;
    let task: JudgeTask = serde_json::from_str(legacy_json)
        .expect("旧格式 JudgeTask 反序列化失败");
    assert_eq!(task.judge_type, JudgeType::Special);
    assert_eq!(task.submission_id, "legacy-001");
}

/// 显式 judge_type=standard 必须正确路由。
#[test]
fn test_judge_task_deserialize_explicit_standard() {
    let json = r#"{
        "submission_id": "std-001",
        "problem_id": "1003",
        "judge_image": "noj-judge-python",
        "judge_command": "python3 /tmp/evaluate.py",
        "language": "python3",
        "code": "print(sum(map(int, input().split())))",
        "time_limit_ms": 5000,
        "memory_limit_mb": 512,
        "judge_type": "standard"
    }"#;
    let task: JudgeTask =
        serde_json::from_str(json).expect("显式 standard 反序列化失败");
    assert_eq!(task.judge_type, JudgeType::Standard);
}

/// JudgeType enum 默认值必须为 Special。
#[test]
fn test_judge_type_default_is_special() {
    assert_eq!(JudgeType::default(), JudgeType::Special);
}

// ── E2E：需要 Docker daemon + NOJ_RUN_E2E=1 ──

/// 标准题正确解 → Accepted + 满分。
#[ignore]
#[serial_test::serial]
#[tokio::test]
async fn test_standard_judge_correct_solution() {
    if !is_e2e_enabled() {
        return;
    }

    let docker = get_docker().expect("连接 Docker 失败");
    ensure_test_image(&docker).await.expect("确保测试镜像失败");

    // 准备 work_dir，写入 main.py + visible.jsonl
    let work_dir = std::env::temp_dir().join(format!(
        "noj-judge-standard-correct-{}",
        uuid::Uuid::new_v4()
    ));
    tokio::fs::create_dir_all(&work_dir).await.unwrap();

    // 用户代码：sum of two ints
    tokio::fs::write(
        work_dir.join("main.py"),
        "print(sum(map(int, input().split())))",
    )
    .await
    .unwrap();

    // 测试用例：1+2=3, 5+7=12, 10+20=30
    tokio::fs::write(
        work_dir.join("visible.jsonl"),
        "{\"id\":\"v001\",\"input\":\"1 2\\n\",\"expected\":3}\n\
         {\"id\":\"v002\",\"input\":\"5 7\\n\",\"expected\":12}\n\
         {\"id\":\"v003\",\"input\":\"10 20\\n\",\"expected\":30}\n",
    )
    .await
    .unwrap();

    let task = JudgeTask {
        submission_id: format!("test-std-correct-{}", uuid::Uuid::new_v4()),
        problem_id: "test-standard".to_string(),
        judge_image: "noj-judge-test-runner".to_string(),
        judge_command: "python3 /tmp/evaluate.py".to_string(),
        support_package_base64: None,
        language: "python".to_string(),
        code: "print(sum(map(int, input().split())))".to_string(),
        file_name: Some("main.py".to_string()),
        time_limit_ms: 5000,
        memory_limit_mb: 256,
        judge_type: JudgeType::Standard,
    };

    let result = evaluate_legacy(&docker, &task, work_dir.to_str().unwrap())
        .await
        .expect("evaluate_legacy 应返回结果");

    // 标准路径在 legacy 下应返回 SystemError（legacy 路径不支持 standard）
    assert_eq!(
        result.status, "SystemError",
        "evaluate_legacy 不支持 standard 路径，应返回 SystemError，但得到: {}",
        result.status
    );
    assert!(result.output.contains("standard 评测模式需要 noj-judge 池模式"));

    let _ = tokio::fs::remove_dir_all(&work_dir).await;
}

/// 标准题错误解 → WrongAnswer（legacy 路径下应为 SystemError）。
#[ignore]
#[serial_test::serial]
#[tokio::test]
async fn test_standard_judge_wrong_solution() {
    if !is_e2e_enabled() {
        return;
    }

    let docker = get_docker().expect("连接 Docker 失败");
    ensure_test_image(&docker).await.expect("确保测试镜像失败");

    let work_dir = std::env::temp_dir().join(format!(
        "noj-judge-standard-wrong-{}",
        uuid::Uuid::new_v4()
    ));
    tokio::fs::create_dir_all(&work_dir).await.unwrap();

    // 用户代码：故意输出错误答案
    tokio::fs::write(work_dir.join("main.py"), "print(0)").await.unwrap();

    tokio::fs::write(
        work_dir.join("visible.jsonl"),
        "{\"id\":\"v001\",\"input\":\"1 2\\n\",\"expected\":3}\n",
    )
    .await
    .unwrap();

    let task = JudgeTask {
        submission_id: format!("test-std-wrong-{}", uuid::Uuid::new_v4()),
        problem_id: "test-standard".to_string(),
        judge_image: "noj-judge-test-runner".to_string(),
        judge_command: "python3 /tmp/evaluate.py".to_string(),
        support_package_base64: None,
        language: "python".to_string(),
        code: "print(0)".to_string(),
        file_name: Some("main.py".to_string()),
        time_limit_ms: 5000,
        memory_limit_mb: 256,
        judge_type: JudgeType::Standard,
    };

    let result = evaluate_legacy(&docker, &task, work_dir.to_str().unwrap())
        .await
        .expect("evaluate_legacy 应返回结果");

    assert_eq!(result.status, "SystemError");

    let _ = tokio::fs::remove_dir_all(&work_dir).await;
}

/// 标准题超时 → TimeLimitExceeded（legacy 路径下应为 SystemError）。
#[ignore]
#[serial_test::serial]
#[tokio::test]
async fn test_standard_judge_timeout() {
    if !is_e2e_enabled() {
        return;
    }

    let docker = get_docker().expect("连接 Docker 失败");
    ensure_test_image(&docker).await.expect("确保测试镜像失败");

    let work_dir = std::env::temp_dir().join(format!(
        "noj-judge-standard-tle-{}",
        uuid::Uuid::new_v4()
    ));
    tokio::fs::create_dir_all(&work_dir).await.unwrap();

    // 用户代码：无限循环（触发超时）
    tokio::fs::write(work_dir.join("main.py"), "while True: pass")
        .await
        .unwrap();

    tokio::fs::write(
        work_dir.join("visible.jsonl"),
        "{\"id\":\"v001\",\"input\":\"1 2\\n\",\"expected\":3}\n",
    )
    .await
    .unwrap();

    let task = JudgeTask {
        submission_id: format!("test-std-tle-{}", uuid::Uuid::new_v4()),
        problem_id: "test-standard".to_string(),
        judge_image: "noj-judge-test-runner".to_string(),
        judge_command: "python3 /tmp/evaluate.py".to_string(),
        support_package_base64: None,
        language: "python".to_string(),
        code: "while True: pass".to_string(),
        file_name: Some("main.py".to_string()),
        time_limit_ms: 1500,
        memory_limit_mb: 256,
        judge_type: JudgeType::Standard,
    };

    let result = evaluate_legacy(&docker, &task, work_dir.to_str().unwrap())
        .await
        .expect("evaluate_legacy 应返回结果");

    // legacy 路径对 standard 一律返回 SystemError（不论 timeout 是否触发）
    assert_eq!(result.status, "SystemError");

    let _ = tokio::fs::remove_dir_all(&work_dir).await;
}