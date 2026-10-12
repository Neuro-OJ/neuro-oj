// JudgeResult 跨模块契约测试（defect #28：结果封套必须完整携带
// attempt_id / run_id / problem_version_id / result_kind）。
//
// 对齐 noj-core 的 `JudgeResult` 接口
// （noj-core/src/domains/submission/types/index.ts）与 `saveEvaluationResult`
// 的准入条件：协议号必须为 2、`run_id` / `problem_version_id` 非空、
// `result_kind ∈ {graded, platform_error}`、`attempt_id === run_id`。
// core 对不满足者直接 `applied=false`（零写入、零事件），因此 judge 侧的任何
// 成功/失败/超时构造入口都必须补齐这些字段。
//
// 另钉住核心语义白名单：Rust `PLATFORM_ERROR_STATUSES` 必须与 core
// `noj-core/src/shared/versioning/verdict.ts` 的同名常量逐项一致（Handbook §3.3）。

use std::fs;
use std::path::PathBuf;

use serde_json::json;

use noj_judge::types::{
    result_kind_for_status, JudgeResult, JudgeTask, EVALUATION_PROTOCOL_VERSION,
    PLATFORM_ERROR_STATUSES,
};

/// JudgeResult wire 字段全集（core 侧 `JudgeResult` 接口）。
const JUDGE_RESULT_FIELDS: [&str; 13] = [
    "submission_id",
    "status",
    "score",
    "output",
    "details",
    "time_ms",
    "memory_kb",
    "rejudge_seq",
    "run_id",
    "attempt_id",
    "problem_version_id",
    "evaluation_protocol_version",
    "result_kind",
];

fn repo_path(relative: &str) -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join(relative)
}

fn fixture_task() -> JudgeTask {
    let raw = fs::read_to_string(repo_path("../noj-tests/fixtures/judge-task.contract.json"))
        .expect("读取 JudgeTask 契约 fixture 失败");
    serde_json::from_str(&raw).expect("fixture 必须可反序列化为 JudgeTask")
}

/// 构造一份"字段全满"的结果，用于钉住 wire 字段集合。
fn full_result() -> JudgeResult {
    JudgeResult {
        submission_id: "11111111-1111-4111-8111-111111111111".to_string(),
        status: "finished".to_string(),
        score: 1000,
        output: "---RESULT---\n{\"score\":1000,\"details\":{}}".to_string(),
        details: json!({"cases": []}),
        time_ms: Some(42),
        memory_kb: Some(18432),
        rejudge_seq: Some(1),
        run_id: None,
        attempt_id: None,
        problem_version_id: None,
        evaluation_protocol_version: None,
        result_kind: None,
    }
}

#[test]
fn judge_result_wire_fields_match_core_interface() {
    let task = fixture_task();
    let mut result = full_result();
    result.apply_protocol(&task);

    let value = serde_json::to_value(&result).expect("JudgeResult 必须可序列化");
    let object = value.as_object().expect("JudgeResult 顶层必须是对象");
    let mut actual: Vec<&str> = object.keys().map(String::as_str).collect();
    actual.sort_unstable();
    let mut expected = JUDGE_RESULT_FIELDS.to_vec();
    expected.sort_unstable();
    assert_eq!(
        actual, expected,
        "JudgeResult wire 字段集合与 core 接口不一致；新增字段必须同步 noj-core 的 JudgeResult 类型"
    );

    // core `saveEvaluationResult` 的准入条件
    assert_eq!(value["evaluation_protocol_version"], 2);
    assert_eq!(value["result_kind"], "graded");
    assert_eq!(value["run_id"], value["attempt_id"]);
    assert!(value["run_id"].as_str().is_some_and(|s| !s.is_empty()));
    assert!(value["problem_version_id"]
        .as_str()
        .is_some_and(|s| !s.is_empty()));

    // Handbook §5.5：协议字段只走可信封套，不放进 evaluator 可控的 details
    assert!(
        value["details"].get("run_id").is_none(),
        "details 不得承载协议字段（禁止用 details 代替可信封套）"
    );

    assert!(
        result.envelope_gaps().is_empty(),
        "封套必须完整: {:?}",
        result.envelope_gaps()
    );
}

#[test]
fn judge_result_envelope_uses_protocol_version_constant() {
    assert_eq!(EVALUATION_PROTOCOL_VERSION, 2);
}

#[test]
fn judge_result_protocol_version_is_always_2_and_details_get_no_protocol_fields() {
    let task = fixture_task();
    // 模拟 main.rs 的成功路径：结果取得后统一 apply_protocol 再推送。
    let mut result = full_result();
    result.details = json!({"cases": [], "run_id": "伪造的尝试标识"});
    result.apply_protocol(&task);

    let value = serde_json::to_value(&result).unwrap();
    assert_eq!(value["evaluation_protocol_version"], 2);
    assert!(result.envelope_gaps().is_empty());

    // 即便 evaluator 在 details 里伪造 run_id，judge 也不改写/依赖它（core 不读取）；
    // 可信封套字段与任务一致。
    assert_eq!(value["run_id"], task.run_id.clone().unwrap());
    assert_eq!(value["attempt_id"], task.run_id.clone().unwrap());
    assert_eq!(
        value["problem_version_id"],
        task.problem_version_id.clone().unwrap()
    );
}

/// defect #28：成功 / 失败 / 超时 全部构造入口，经 `apply_protocol` 后封套完整，
/// 且平台错误类入口显式标注 `platform_error`。
#[test]
fn all_construction_entries_carry_complete_envelope() {
    let task = fixture_task();

    let mut entries = [
        full_result(),
        JudgeResult::timeout("sid-tle", "timeout", Some(1)),
        JudgeResult::system_error("sid-se", "system error", Some(1)),
        JudgeResult::error("sid-err", Some(1)),
        JudgeResult::from_error(&anyhow::anyhow!("docker 不可用"), "sid-anyhow", Some(1)),
    ];

    for result in entries.iter_mut() {
        result.apply_protocol(&task);
        assert!(
            result.envelope_gaps().is_empty(),
            "entry 封套不完整: status={} gaps={:?}",
            result.status,
            result.envelope_gaps()
        );
        let value = serde_json::to_value(&*result).unwrap();
        assert_eq!(value["evaluation_protocol_version"], 2);
        assert_eq!(value["run_id"], task.run_id.clone().unwrap());
        assert_eq!(value["attempt_id"], value["run_id"]);
    }

    // 平台错误类入口（超时/系统错误/通用错误/anyhow 失败）必须是 platform_error
    for result in entries.iter_mut().skip(1) {
        assert_eq!(
            result.result_kind.as_deref(),
            Some("platform_error"),
            "status={} 必须是平台错误",
            result.status
        );
    }
    assert_eq!(entries[0].result_kind.as_deref(), Some("graded"));
}

/// 自测任务（core 不补 `attempt_id`）：judge 必须用 `run_id` 补齐，
/// 否则 core 会因 `attempt_id !== run_id` 整体丢弃结果。
#[test]
fn self_test_task_result_envelope_backfills_attempt_id() {
    let mut value = serde_json::to_value(fixture_task()).unwrap();
    value["submission_id"] = json!("st_11111111-1111-4111-8111-111111111111");
    value.as_object_mut().unwrap().remove("attempt_id");
    let task: JudgeTask = serde_json::from_value(value).expect("自测任务必须可反序列化");
    assert!(task.attempt_id.is_none());

    let mut result = full_result();
    result.apply_protocol(&task);

    assert_eq!(
        result.attempt_id, result.run_id,
        "缺 attempt_id 时必须回退为 run_id"
    );
    let value = serde_json::to_value(&result).unwrap();
    assert_eq!(value["attempt_id"], value["run_id"]);
    assert!(result.envelope_gaps().is_empty());
}

/// 旧协议任务（无 run_id/版本）：judge 只标注协议与类别，封套必然不完整，
/// 由 noj-core 拒绝——`envelope_gaps` 必须把它暴露出来（main.rs 记录 error 日志）。
#[test]
fn legacy_task_without_run_id_reports_envelope_gaps() {
    let mut value = serde_json::to_value(fixture_task()).unwrap();
    let object = value.as_object_mut().unwrap();
    object.remove("run_id");
    object.remove("attempt_id");
    object.remove("problem_version_id");
    object.remove("evaluation_protocol_version");
    let task: JudgeTask = serde_json::from_value(value).expect("旧任务必须可反序列化");

    let mut result = full_result();
    result.apply_protocol(&task);

    let gaps = result.envelope_gaps();
    assert_eq!(gaps, vec!["run_id", "attempt_id", "problem_version_id"]);
    let value = serde_json::to_value(&result).unwrap();
    assert!(value.get("run_id").is_none());
    assert!(value.get("attempt_id").is_none());
    assert_eq!(value["evaluation_protocol_version"], 2);
    assert_eq!(value["result_kind"], "graded");
}

/// Rust `PLATFORM_ERROR_STATUSES` 必须与 core `verdict.ts` 的同名常量逐项一致。
#[test]
fn platform_error_status_whitelist_matches_core() {
    let raw = fs::read_to_string(repo_path("../noj-core/src/shared/versioning/verdict.ts"))
        .expect("读取 core verdict.ts 失败（跨模块契约源）");
    let marker = "PLATFORM_ERROR_STATUSES: readonly string[] = [";
    let start = raw
        .find(marker)
        .expect("core verdict.ts 缺少 PLATFORM_ERROR_STATUSES 声明")
        + marker.len();
    let end = raw[start..]
        .find(']')
        .expect("PLATFORM_ERROR_STATUSES 数组未闭合")
        + start;
    let body = &raw[start..end];

    let mut core_statuses: Vec<String> = Vec::new();
    let mut rest = body;
    while let Some(open) = rest.find('"') {
        let after = &rest[open + 1..];
        let close = after
            .find('"')
            .expect("PLATFORM_ERROR_STATUSES 字符串字面量未闭合");
        core_statuses.push(after[..close].to_string());
        rest = &after[close + 1..];
    }

    assert_eq!(
        core_statuses, PLATFORM_ERROR_STATUSES,
        "Rust 与 core 的平台错误白名单漂移：两侧必须同步（Handbook §3.3）"
    );
    for status in PLATFORM_ERROR_STATUSES {
        assert_eq!(
            result_kind_for_status(status),
            "platform_error",
            "status={status}"
        );
    }
    for status in ["finished", "Accepted", "WA", "TLE", "MLE", "RE", "CE"] {
        assert_eq!(result_kind_for_status(status), "graded", "status={status}");
    }
}
