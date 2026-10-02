use noj_judge::oi::{score_submission, OiCaseResult, OiJudgeTask, OiRuntimeConfig, OiStatus};
use noj_judge::types::JudgeTask;
use serde_json::json;

fn config() -> OiRuntimeConfig {
    serde_json::from_value(json!({
        "backend": "native",
        "languages": ["c", "cpp"],
        "time_limit_ms": 1000,
        "memory_limit_mb": 256,
        "checker": { "type": "default" },
        "subtasks": [
            { "id": "base", "score": 40, "cases": [
                { "input": "tests/1.in", "output": "tests/1.out" },
                { "input": "tests/2.in", "output": "tests/2.out" }
            ] },
            { "id": "advanced", "score": 60, "depends_on": ["base"], "cases": [
                { "input": "tests/3.in", "output": "tests/3.out", "time_limit_ms": 2000 }
            ] }
        ]
    }))
    .unwrap()
}

fn case(input: &str, status: OiStatus) -> OiCaseResult {
    OiCaseResult {
        case_id: Some(input.to_string()),
        input: input.to_string(),
        status,
        time_ms: Some(12),
        memory_kb: Some(4096),
        cpu_time_ms: None,
        wall_time_ms: None,
        equivalent_time_ms: None,
    }
}

#[test]
fn oi_task_uses_runtime_config_and_cpp_source() {
    let wire = json!({
        "submission_id": "s1", "problem_id": "p1", "user_id": "u1",
        "judge_type": "oi", "language": "cpp", "code": "int main() {}",
        "runtime_config": config(), "download_url": "noj-download://base64/?content=abc"
    });
    let task: OiJudgeTask = serde_json::from_value(wire.clone()).unwrap();
    assert_eq!(task.judge_type, "oi");
    assert_eq!(task.language, "cpp");
    assert_eq!(task.runtime_config.subtasks.len(), 2);
    assert_eq!(
        task.runtime_config.subtasks[1].cases[0].time_limit_ms,
        Some(2000)
    );
    assert_eq!(task.priority, "medium");
    let generic_task: JudgeTask = serde_json::from_value(wire).unwrap();
    assert_eq!(generic_task.judge_type, "oi");
    assert_eq!(
        generic_task.runtime_config.as_oi().unwrap().subtasks.len(),
        2
    );
}

#[test]
fn all_cases_accepted_awards_every_subtask() {
    let result = score_submission(
        &config(),
        &[
            case("tests/1.in", OiStatus::Accepted),
            case("tests/2.in", OiStatus::Accepted),
            case("tests/3.in", OiStatus::Accepted),
        ],
    )
    .unwrap();
    assert_eq!(result.status, OiStatus::Accepted);
    assert_eq!(result.score, 10_000);
    assert_eq!(result.subtasks[0].score, 4_000);
    assert_eq!(result.subtasks[1].score, 6_000);
}

#[test]
fn failed_case_zeroes_entire_subtask_and_ignores_dependent() {
    let result = score_submission(
        &config(),
        &[
            case("tests/1.in", OiStatus::Accepted),
            case("tests/2.in", OiStatus::WrongAnswer),
        ],
    )
    .unwrap();
    assert_eq!(result.status, OiStatus::WrongAnswer);
    assert_eq!(result.score, 0);
    assert_eq!(result.subtasks[0].score, 0);
    assert_eq!(result.subtasks[0].status, OiStatus::WrongAnswer);
    assert_eq!(result.subtasks[1].score, 0);
    assert_eq!(result.subtasks[1].status, OiStatus::Ignored);
}

#[test]
fn independent_subtask_keeps_its_points() {
    let mut config = config();
    config.subtasks[1].depends_on.clear();
    let result = score_submission(
        &config,
        &[
            case("tests/1.in", OiStatus::TimeLimitExceeded),
            case("tests/2.in", OiStatus::Accepted),
            case("tests/3.in", OiStatus::Accepted),
        ],
    )
    .unwrap();
    assert_eq!(result.status, OiStatus::TimeLimitExceeded);
    assert_eq!(result.score, 6_000);
}

#[test]
fn missing_or_duplicate_case_result_is_rejected() {
    let accepted = case("tests/1.in", OiStatus::Accepted);
    assert!(score_submission(&config(), std::slice::from_ref(&accepted)).is_err());
    assert!(score_submission(&config(), &[accepted.clone(), accepted]).is_err());
}

#[test]
fn invalid_subtask_dependency_is_rejected() {
    let mut config = config();
    config.subtasks[0].depends_on = vec!["advanced".to_string()];
    assert!(score_submission(&config, &[]).is_err());
}

#[test]
fn forward_dependency_is_scored_without_reordering_report() {
    let mut config = config();
    config.subtasks.swap(0, 1);
    let result = score_submission(
        &config,
        &[
            case("tests/1.in", OiStatus::Accepted),
            case("tests/2.in", OiStatus::Accepted),
            case("tests/3.in", OiStatus::Accepted),
        ],
    )
    .unwrap();
    assert_eq!(result.score, 10_000);
    assert_eq!(result.subtasks[0].id, "advanced");
    assert_eq!(result.subtasks[0].score, 6_000);
    assert_eq!(result.subtasks[1].id, "base");
}

#[test]
fn oi_status_uses_common_short_codes() {
    for (status, code) in [
        (OiStatus::Accepted, "AC"),
        (OiStatus::WrongAnswer, "WA"),
        (OiStatus::TimeLimitExceeded, "TLE"),
        (OiStatus::MemoryLimitExceeded, "MLE"),
        (OiStatus::OutputLimitExceeded, "OLE"),
        (OiStatus::RuntimeError, "RE"),
        (OiStatus::CompileError, "CE"),
        (OiStatus::SystemError, "SE"),
        (OiStatus::FormatError, "FE"),
        (OiStatus::Ignored, "IGN"),
    ] {
        assert_eq!(serde_json::to_value(status).unwrap(), json!(code));
    }
}

#[test]
fn evaluation_maps_to_existing_result_envelope() {
    let evaluation = score_submission(
        &config(),
        &[
            case("tests/1.in", OiStatus::Accepted),
            case("tests/2.in", OiStatus::Accepted),
            case("tests/3.in", OiStatus::Accepted),
        ],
    )
    .unwrap();
    let result = evaluation.to_judge_result("submission-1", Some(4), Some(20), Some(8192));
    assert_eq!(result.submission_id, "submission-1");
    assert_eq!(result.status, "finished");
    assert_eq!(result.score, 10_000);
    assert_eq!(result.details["oi_status"], "AC");
    assert_eq!(result.details["subtasks"][1]["cases"][0]["status"], "AC");
    assert_eq!(result.time_ms, Some(20));
    assert_eq!(result.memory_kb, Some(8192));
    assert_eq!(result.rejudge_seq, Some(4));
}
