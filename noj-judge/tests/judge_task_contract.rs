// JudgeTask 跨模块契约快照测试（2026-09-12 架构评审 §3.1）。
//
// 与 noj-core 侧共用同一份 fixture：noj-tests/fixtures/judge-task.contract.json。
// TS 侧断言"构造出的消息 == fixture"；这里断言 Rust 结构体能**反序列化该 fixture**
// 并取到全部字段值——两侧任一方改字段名/结构，这份测试或对方那份会失败。
//
// 历史问题：两侧此前靠注释互指"字段对齐 noj-core/src/types/index.ts"，而该路径早已
// 不存在（目录迁移到 domains/submission/types/），对齐完全靠人工记忆。

use std::fs;
use std::path::PathBuf;

use serde_json::Value;

use noj_judge::types::JudgeTask;

fn fixture_path() -> PathBuf {
    // 集成测试的 cwd 是 crate 根（noj-judge）
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../noj-tests/fixtures/judge-task.contract.json")
}

fn load_fixture() -> Value {
    let raw = fs::read_to_string(fixture_path()).expect("读取契约 fixture 失败");
    serde_json::from_str(&raw).expect("fixture 不是合法 JSON")
}

#[test]
fn judge_task_contract_fixture_deserializes() {
    let value = load_fixture();
    let task: JudgeTask =
        serde_json::from_value(value.clone()).expect("Rust JudgeTask 必须能反序列化契约 fixture");

    assert_eq!(task.submission_id, "11111111-1111-4111-8111-111111111111");
    assert_eq!(task.problem_id, "22222222-2222-4222-8222-222222222222");
    assert_eq!(task.user_id, "33333333-3333-4333-8333-333333333333");
    assert_eq!(task.priority, "medium");
    assert_eq!(task.language, "python3");
    assert_eq!(task.code, "print('hello')");
    assert_eq!(task.file_name.as_deref(), Some("main.py"));
    assert_eq!(task.rejudge_seq, Some(1));
    assert!(task.download_url.is_some());
    assert!(task.artifact_download_url.is_some());

    let runtime = &task.runtime_config;
    assert_eq!(runtime.evaluator.image, "noj-evaluator-python");
    assert_eq!(runtime.evaluator.command, "python3 /workspace/evaluate.py");
    assert_eq!(runtime.evaluator.time_limit_ms, 5000);
    assert_eq!(runtime.evaluator.memory_limit_mb, 512);
    assert_eq!(runtime.solution.image, "noj-solution-python");
    assert_eq!(runtime.solution.call_timeout_ms, 2000);

    let llm = task.llm.expect("fixture 应包含 llm 字段");
    assert_eq!(llm.gateway_url, "http://llm-gateway:8001");
    assert_eq!(llm.allowed_models.len(), 2);
    let user_llm = task.user_llm.expect("fixture 应包含 user_llm 字段");
    assert_eq!(user_llm.allowed_models, vec!["gpt-4o-mini"]);
}

/// fixture 的字段必须被结构体**全部**消费：任何 fixture 里的键在结构体中不存在，
/// 说明两侧契约已漂移（Rust 侧会静默忽略未知字段）。
#[test]
fn judge_task_contract_has_no_unknown_fields() {
    let value = load_fixture();
    let object = value.as_object().expect("fixture 顶层应为对象");

    let expected = [
        "submission_id",
        "problem_id",
        "user_id",
        "priority",
        "runtime_config",
        "download_url",
        "artifact_download_url",
        "language",
        "code",
        "file_name",
        "rejudge_seq",
        "llm",
        "user_llm",
    ];
    let mut actual: Vec<&str> = object.keys().map(|k| k.as_str()).collect();
    actual.sort_unstable();
    let mut expected_sorted = expected.to_vec();
    expected_sorted.sort_unstable();

    assert_eq!(
        actual, expected_sorted,
        "契约 fixture 的字段集合与 Rust 侧期望不一致：请同步 JudgeTask 结构体、\
         noj-core 的 JUDGE_TASK_FIELDS 与该 fixture"
    );
}

/// 必填字段缺失时必须反序列化失败（防止"字段丢了但静默用默认值"）。
#[test]
fn judge_task_contract_rejects_missing_required_field() {
    let value = load_fixture();
    let mut object = value.as_object().expect("fixture 顶层应为对象").clone();
    object.remove("runtime_config");
    let err = serde_json::from_value::<JudgeTask>(Value::Object(object));
    assert!(err.is_err(), "缺少 runtime_config 时必须反序列化失败");
}
