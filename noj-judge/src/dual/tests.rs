/**
 * `dual` 模块的单元测试（自 `dual/mod.rs` 拆出，见该文件顶部说明）。
 *
 * 作为 `dual` 的**子模块**，`use super::*;` 仍可访问 `dual` 的私有项（含其
 * `use` 别名），因此本文件与拆分前的内联 `mod tests` 语义完全一致；拆出只是为了
 * 让 `dual/mod.rs` 回到单文件规模棘轮（`scripts/check-file-size.ts`）允许的范围。
 */
use super::pipe::forward_frame_with_timeout;
use super::result::{build_judge_result, MSG_INVALID_SCORE};
use super::*;

/// handle_eval_chunk 测试公共状态。
struct EvalHarness {
    parser: LineParser,
    stderr_buf: String,
    stdout_full: String,
    result_payload: Option<String>,
    tracker: InFlightTracker,
}

impl EvalHarness {
    fn new() -> Self {
        Self {
            parser: LineParser::new(),
            stderr_buf: String::new(),
            stdout_full: String::new(),
            result_payload: None,
            tracker: InFlightTracker::new(2000),
        }
    }
}

/// handle_sol_chunk 测试公共状态。
struct SolHarness {
    parser: LineParser,
    solution_ready: bool,
    tracker: InFlightTracker,
}

impl SolHarness {
    fn new() -> Self {
        Self {
            parser: LineParser::new(),
            solution_ready: true,
            tracker: InFlightTracker::new(2000),
        }
    }
}

#[test]
fn test_build_judge_result_legacy_accepted_maps_to_finished() {
    let parsed = serde_json::json!({
        "status": "Accepted",
        "score": 10000,
        "details": {"cases": []}
    });
    let r = build_judge_result("sid-1", &parsed, "", "", Some(7)).expect("合法评分必须构造成功");
    assert_eq!(r.rejudge_seq, Some(7));
    assert_eq!(r.status, "finished");
    assert_eq!(r.score, 10000);
}

#[test]
fn test_build_judge_result_legacy_wrong_answer_maps_to_finished() {
    let parsed = serde_json::json!({
        "status": "WrongAnswer",
        "score": 0,
        "details": {"message": "expected 3 got 4"}
    });
    let r = build_judge_result("sid-2", &parsed, "stderr", "stdout", None).expect("合法评分");
    assert_eq!(r.status, "finished");
    assert!(r.output.contains("stderr"));
}

// ── defect #29：非法评分必须归为平台错误，绝不退化成正式零分/满分 ──

/// 构造平台错误结果并断言「不覆盖已有正式判定」所需的封套性质。
fn platform_error_from_invalid_score(
    submission_id: &str,
    parsed: &serde_json::Value,
) -> crate::types::JudgeResult {
    let err = build_judge_result(submission_id, parsed, "", "", Some(4))
        .expect_err("非法评分不得构造出正式判定结果");
    let r = JudgeResult::from_error(&err, submission_id, Some(4));
    assert_eq!(r.status, "error", "非法评分必须是平台错误状态");
    assert_eq!(
        r.result_kind.as_deref(),
        Some("platform_error"),
        "非法评分必须标注 platform_error（core 据此跳过正式判定指针更新）"
    );
    assert!(
        r.output.starts_with(MSG_INVALID_SCORE),
        "必须回传固定公开文案，实际: {}",
        r.output
    );
    r
}

#[test]
fn test_build_judge_result_rejects_empty_payload_as_platform_error() {
    // 基线缺陷场景：`{}` 曾被 unwrap_or(0) + 缺省 finished 转成 graded 零分。
    let r = platform_error_from_invalid_score("sid-3", &serde_json::json!({}));
    assert_eq!(r.score, 0);
    assert_eq!(r.rejudge_seq, Some(4));
}

#[test]
fn test_build_judge_result_rejects_string_score() {
    let parsed = serde_json::json!({"score": "1000", "details": {}});
    let r = platform_error_from_invalid_score("sid-str", &parsed);
    // 原始字符串评分（带引号的 JSON 字符串）不得出现在面向用户的公开输出里
    assert!(!r.output.contains("\"1000\""), "实际输出: {}", r.output);
}

#[test]
fn test_build_judge_result_rejects_out_of_range_score_without_clamping() {
    // 越界（>MAX_SCORE）：绝不能被 clamp 成满分 10000
    let high = serde_json::json!({"score": 99999, "details": {}});
    let err = build_judge_result("sid-high", &high, "", "", None).expect_err("越界评分");
    let r = JudgeResult::from_error(&err, "sid-high", None);
    assert_eq!(r.result_kind.as_deref(), Some("platform_error"));
    assert_eq!(r.score, 0, "越界评分不得被 clamp 成 10000");

    // 越界（负数）：绝不能被 clamp 成 0 分正式判定
    let low = serde_json::json!({"score": -5, "details": {}});
    let err = build_judge_result("sid-low", &low, "", "", None).expect_err("负分");
    let r = JudgeResult::from_error(&err, "sid-low", None);
    assert_eq!(r.result_kind.as_deref(), Some("platform_error"));

    // 边界内仍必须接受（0 分与满分都是合法正式判定，Handbook §3.3）
    assert_eq!(
        build_judge_result("sid-zero", &serde_json::json!({"score": 0}), "", "", None)
            .expect("0 分合法")
            .score,
        0
    );
    assert_eq!(
        build_judge_result(
            "sid-full",
            &serde_json::json!({"score": 10000}),
            "",
            "",
            None
        )
        .expect("满分合法")
        .score,
        10000
    );
}

#[test]
fn test_build_judge_result_rejects_invalid_score_types() {
    for parsed in [
        serde_json::json!({"score": 800.5, "details": {}}),
        serde_json::json!({"score": null, "details": {}}),
        serde_json::json!({"score": true, "details": {}}),
        serde_json::json!({"score": [1000], "details": {}}),
        serde_json::json!({"score": {"value": 1000}, "details": {}}),
        serde_json::json!({"details": {"cases": []}}),
    ] {
        let err = build_judge_result("sid-type", &parsed, "", "", None).unwrap_err();
        let r = JudgeResult::from_error(&err, "sid-type", None);
        assert_eq!(
            r.result_kind.as_deref(),
            Some("platform_error"),
            "非法评分类型必须平台错误: {parsed}"
        );
    }
}

#[test]
fn test_build_judge_result_accepts_integral_float_score_like_core() {
    // 与 core `isValidGradedScore`（`Number.isInteger(800.0) === true`）对齐：
    // JSON 的 800.0 数值上就是 800，不能比 core 更严而误判平台错误。
    let r = build_judge_result(
        "sid-float",
        &serde_json::json!({"score": 800.0, "details": {}}),
        "",
        "",
        None,
    )
    .expect("整数值浮点必须与 core 语义一致地接受");
    assert_eq!(r.score, 800);
    assert_eq!(r.status, "finished");

    // 但真正的越界浮点仍必须拒绝
    assert!(build_judge_result(
        "sid-float-oob",
        &serde_json::json!({"score": 1.5e9, "details": {}}),
        "",
        "",
        None,
    )
    .is_err());
}

#[test]
fn test_build_judge_result_rejects_non_object_payload() {
    for parsed in [
        serde_json::json!([]),
        serde_json::json!(1000),
        serde_json::json!("1000"),
        serde_json::Value::Null,
    ] {
        let err = build_judge_result("sid-nonobj", &parsed, "", "", None).unwrap_err();
        let r = JudgeResult::from_error(&err, "sid-nonobj", None);
        assert_eq!(r.result_kind.as_deref(), Some("platform_error"));
    }
}

#[test]
fn test_build_judge_result_valid_score_without_status_is_graded_finished() {
    // 新协议：evaluate.py 不再输出 status，评分合法时缺省 finished（graded）。
    // 这正是 #29 的修复边界——非法评分被拦下后，缺省 status 不再构成风险。
    let task_json = serde_json::json!({
        "submission_id": "sid-ok",
        "problem_id": "p-1",
        "user_id": "u-1",
        "run_id": "attempt-ok",
        "attempt_id": "attempt-ok",
        "problem_version_id": "ver-ok",
        "runtime_config": {
            "evaluator": {
                "image": "noj-evaluator-python",
                "command": "python3 /workspace/evaluate.py",
                "time_limit_ms": 1000,
                "memory_limit_mb": 128
            },
            "solution": {
                "image": "noj-solution-python",
                "call_timeout_ms": 1000,
                "memory_limit_mb": 128
            }
        },
        "language": "python3",
        "code": "print(1)"
    });
    let task: crate::types::JudgeTask = serde_json::from_value(task_json).unwrap();
    let parsed = serde_json::json!({"score": 1000, "details": {}});

    let mut graded = build_judge_result(&task.submission_id, &parsed, "", "", task.rejudge_seq)
        .expect("合法评分 + 缺省 status 必须构造正式判定");
    assert_eq!(graded.status, "finished");
    assert_eq!(graded.score, 1000);
    graded.apply_protocol(&task);
    assert_eq!(graded.result_kind.as_deref(), Some("graded"));
    assert!(graded.envelope_gaps().is_empty(), "封套必须完整");
}

#[test]
fn test_finalize_outcome_mapping() {
    // 启动等待超时（Startup）归因于平台侧 SystemError
    assert_eq!(
        finalize_outcome(Some(TimeoutKind::Startup), false),
        JudgeStatus::SystemError
    );
    assert_eq!(
        finalize_outcome(Some(TimeoutKind::Startup), true),
        JudgeStatus::SystemError
    );
    // 运行总超时（Total）归因于用户代码慢 TimeLimitExceeded（决策 5 / AR-07）
    assert_eq!(
        finalize_outcome(Some(TimeoutKind::Total), false),
        JudgeStatus::TimeLimitExceeded
    );
    assert_eq!(
        finalize_outcome(Some(TimeoutKind::Total), true),
        JudgeStatus::TimeLimitExceeded
    );
    // 无总超时 + 发过 CallTimeout → TLE（用户代码慢是根因）
    assert_eq!(finalize_outcome(None, true), JudgeStatus::TimeLimitExceeded);
    // 无总超时 + 未发过 → SystemError（evaluator 自身异常）
    assert_eq!(finalize_outcome(None, false), JudgeStatus::SystemError);
}

#[tokio::test]
async fn test_forward_frame_writes_ndjson_line() {
    // 验证 NDJSON 帧序列化格式（forward_frame 的核心逻辑）
    //   forward_frame = serde_json::to_string(frame) + "\n" + flush
    // 这里只验证序列化部分的格式，避免与 AsyncWrite trait object 纠缠
    let frame = serde_json::json!({"type":"result","id":"x","value":42});
    let line = serde_json::to_string(&frame).unwrap();
    assert!(line.contains("\"type\":\"result\""));
    assert!(line.contains("\"value\":42"));
    // 实际写盘逻辑已通过 line_parser 单测间接覆盖（call 帧解析 → solution stdin 转发）
}

#[tokio::test]
async fn test_handle_eval_chunk_forwards_result_error_frames() {
    // capability 响应（result/error）帧必须转发到 solution stdin；
    // log 帧与普通文本不转发。
    use tokio::io::AsyncReadExt;

    let (sink, mut source) = tokio::io::duplex(8192);
    let mut writer: std::pin::Pin<Box<dyn tokio::io::AsyncWrite + Send + Unpin>> = Box::pin(sink);

    let EvalHarness {
        mut parser,
        mut stderr_buf,
        mut stdout_full,
        mut result_payload,
        mut tracker,
    } = EvalHarness::new();
    // 预登记 capability 调用（solution 已发过 capability 帧，等待响应）
    tracker.on_capability_frame(
        &serde_json::json!({"type":"capability","id":"abc","name":"x","args":[]}),
        Instant::now(),
    );
    tracker.on_capability_frame(
        &serde_json::json!({"type":"capability","id":"def","name":"x","args":[]}),
        Instant::now(),
    );

    let chunk = LogOutput::StdOut {
        message: bytes::Bytes::from_static(
            b"{\"type\":\"result\",\"id\":\"abc\",\"value\":42}\n\
              {\"type\":\"error\",\"id\":\"def\",\"code\":\"NotFound\",\"message\":\"x\"}\n\
              {\"type\":\"log\",\"stream\":\"stdout\",\"data\":\"hi\"}\n",
        ),
    };

    handle_eval_chunk(
        &mut parser,
        &mut stderr_buf,
        &mut stdout_full,
        &mut writer,
        &mut result_payload,
        &mut tracker,
        chunk,
    )
    .await
    .unwrap();

    // 读取转发到 solution stdin 的内容
    // 注意：duplex 的 read_to_end 需等写端 drop 才 EOF，这里用带超时的 read
    let mut buf = [0u8; 4096];
    let n = tokio::time::timeout(Duration::from_secs(2), source.read(&mut buf))
        .await
        .expect("读取转发内容超时")
        .unwrap();
    let text = String::from_utf8_lossy(&buf[..n]).to_string();

    assert!(text.contains("\"type\":\"result\""));
    assert!(text.contains("\"type\":\"error\""));
    assert!(!text.contains("\"type\":\"log\""), "log 帧不应转发");
    assert!(result_payload.is_none());
    // 帧被记录到 stdout 全文（含未转发的 log）
    assert!(stdout_full.contains("\"type\":\"log\""));
}

#[tokio::test]
async fn test_handle_eval_chunk_still_forwards_call_frames() {
    // 既有行为回归：evaluator → solution 的 call 帧仍转发
    use tokio::io::AsyncReadExt;

    let (sink, mut source) = tokio::io::duplex(8192);
    let mut writer: std::pin::Pin<Box<dyn tokio::io::AsyncWrite + Send + Unpin>> = Box::pin(sink);

    let EvalHarness {
        mut parser,
        mut stderr_buf,
        mut stdout_full,
        mut result_payload,
        mut tracker,
    } = EvalHarness::new();

    let chunk = LogOutput::StdOut {
        message: bytes::Bytes::from_static(
            b"{\"type\":\"call\",\"id\":\"x\",\"fn\":\"solve\",\"args\":[1]}\nplain text\n",
        ),
    };

    handle_eval_chunk(
        &mut parser,
        &mut stderr_buf,
        &mut stdout_full,
        &mut writer,
        &mut result_payload,
        &mut tracker,
        chunk,
    )
    .await
    .unwrap();

    let mut buf = [0u8; 4096];
    let n = tokio::time::timeout(Duration::from_secs(2), source.read(&mut buf))
        .await
        .expect("读取转发内容超时")
        .unwrap();
    let text = String::from_utf8_lossy(&buf[..n]).to_string();

    assert!(text.contains("\"type\":\"call\""));
    assert!(!text.contains("plain text"), "普通文本不应转发");
    // call 帧已被追踪：响应可命中
    assert!(tracker.resolve_response("x"));
}

#[tokio::test]
async fn test_handle_eval_chunk_result_marker_sets_payload() {
    // ---RESULT--- 标记行为回归：下一行 JSON 成为结果 payload

    let (sink, _source) = tokio::io::duplex(8192);
    let mut writer: std::pin::Pin<Box<dyn tokio::io::AsyncWrite + Send + Unpin>> = Box::pin(sink);

    let EvalHarness {
        mut parser,
        mut stderr_buf,
        mut stdout_full,
        mut result_payload,
        mut tracker,
    } = EvalHarness::new();

    let chunk = LogOutput::StdOut {
        message: bytes::Bytes::from_static(b"---RESULT---\n{\"score\":100}\n"),
    };

    handle_eval_chunk(
        &mut parser,
        &mut stderr_buf,
        &mut stdout_full,
        &mut writer,
        &mut result_payload,
        &mut tracker,
        chunk,
    )
    .await
    .unwrap();

    assert_eq!(result_payload.as_deref(), Some("{\"score\":100}"));
    assert!(stdout_full.contains("---RESULT---"));
}

#[tokio::test]
async fn test_result_marker_and_payload_split_across_chunks() {
    let (sink, _source) = tokio::io::duplex(8192);
    let mut writer: std::pin::Pin<Box<dyn tokio::io::AsyncWrite + Send + Unpin>> = Box::pin(sink);

    let EvalHarness {
        mut parser,
        mut stderr_buf,
        mut stdout_full,
        mut result_payload,
        mut tracker,
    } = EvalHarness::new();

    handle_eval_chunk(
        &mut parser,
        &mut stderr_buf,
        &mut stdout_full,
        &mut writer,
        &mut result_payload,
        &mut tracker,
        LogOutput::StdOut {
            message: bytes::Bytes::from_static(b"---RESULT---\n"),
        },
    )
    .await
    .unwrap();
    // 标记与 payload 跨 chunk 时，状态必须保持到下一 chunk。
    assert_eq!(result_payload.as_deref(), Some(""));

    handle_eval_chunk(
        &mut parser,
        &mut stderr_buf,
        &mut stdout_full,
        &mut writer,
        &mut result_payload,
        &mut tracker,
        LogOutput::StdOut {
            message: bytes::Bytes::from_static(b"{\"score\":100}\n"),
        },
    )
    .await
    .unwrap();
    assert_eq!(result_payload.as_deref(), Some("{\"score\":100}"));
}

#[tokio::test]
async fn test_eval_call_frame_tracked_and_forwarded() {
    // call 帧：登记 in-flight 并原样转发（含 timeout_ms 字段）到 sol_input
    use tokio::io::AsyncReadExt;

    let (sink, mut source) = tokio::io::duplex(8192);
    let mut writer: std::pin::Pin<Box<dyn tokio::io::AsyncWrite + Send + Unpin>> = Box::pin(sink);

    let EvalHarness {
        mut parser,
        mut stderr_buf,
        mut stdout_full,
        mut result_payload,
        mut tracker,
    } = EvalHarness::new();

    let chunk = LogOutput::StdOut {
        message: bytes::Bytes::from_static(
            b"{\"type\":\"call\",\"id\":\"c1\",\"fn\":\"solve\",\"args\":[1],\"timeout_ms\":500}\n",
        ),
    };
    handle_eval_chunk(
        &mut parser,
        &mut stderr_buf,
        &mut stdout_full,
        &mut writer,
        &mut result_payload,
        &mut tracker,
        chunk,
    )
    .await
    .unwrap();

    // 转发到 sol_input
    let mut buf = [0u8; 4096];
    let n = tokio::time::timeout(Duration::from_secs(2), source.read(&mut buf))
        .await
        .expect("读取转发内容超时")
        .unwrap();
    let text = String::from_utf8_lossy(&buf[..n]).to_string();
    assert!(text.contains("\"type\":\"call\""));
    assert!(text.contains("\"timeout_ms\":500"), "帧应原样透传");

    // in-flight 已登记：响应命中可转发
    assert!(tracker.resolve_response("c1"), "c1 应被追踪");
}

#[tokio::test]
async fn test_eval_cap_reg_frame_not_forwarded() {
    // cap_reg 帧：仅更新映射，不转发给 solution（同批 call 帧正常转发）
    use tokio::io::AsyncReadExt;

    let (sink, mut source) = tokio::io::duplex(8192);
    let mut writer: std::pin::Pin<Box<dyn tokio::io::AsyncWrite + Send + Unpin>> = Box::pin(sink);

    let EvalHarness {
        mut parser,
        mut stderr_buf,
        mut stdout_full,
        mut result_payload,
        mut tracker,
    } = EvalHarness::new();

    let chunk = LogOutput::StdOut {
        message: bytes::Bytes::from_static(
            b"{\"type\":\"cap_reg\",\"name\":\"ping\",\"timeout_ms\":9000}\n\
              {\"type\":\"call\",\"id\":\"c9\",\"fn\":\"solve\",\"args\":[1]}\n",
        ),
    };
    handle_eval_chunk(
        &mut parser,
        &mut stderr_buf,
        &mut stdout_full,
        &mut writer,
        &mut result_payload,
        &mut tracker,
        chunk,
    )
    .await
    .unwrap();

    // 只应转发 call 帧；cap_reg 帧不应出现
    let mut buf = [0u8; 4096];
    let n = tokio::time::timeout(Duration::from_secs(2), source.read(&mut buf))
        .await
        .expect("读取转发内容超时")
        .unwrap();
    let text = String::from_utf8_lossy(&buf[..n]).to_string();
    assert!(text.contains("\"type\":\"call\""), "call 帧应转发");
    assert!(!text.contains("cap_reg"), "cap_reg 帧不应转发到 solution");
    // 映射已记录
    let f = serde_json::json!({"type":"capability","id":"cap-1","name":"ping","args":[]});
    assert_eq!(
        tracker.on_capability_frame(&f, Instant::now()).unwrap().1,
        9000
    );
}

#[tokio::test]
async fn test_sol_log_frame_still_forwarded() {
    // 回归：solution 的 log 等非 call/capability 帧应保持既有转发语义
    use tokio::io::AsyncReadExt;

    let (sink, mut source) = tokio::io::duplex(8192);
    let mut writer: std::pin::Pin<Box<dyn tokio::io::AsyncWrite + Send + Unpin>> = Box::pin(sink);

    let SolHarness {
        mut parser,
        mut solution_ready,
        mut tracker,
    } = SolHarness::new();

    let chunk = LogOutput::StdOut {
        message: bytes::Bytes::from_static(
            b"{\"type\":\"log\",\"stream\":\"stdout\",\"data\":\"hi\"}\n",
        ),
    };
    handle_sol_chunk(
        &mut parser,
        &mut writer,
        chunk,
        &mut solution_ready,
        &mut tracker,
    )
    .await
    .unwrap();

    let mut buf = [0u8; 4096];
    let n = tokio::time::timeout(Duration::from_secs(2), source.read(&mut buf))
        .await
        .expect("读取转发内容超时")
        .unwrap();
    let text = String::from_utf8_lossy(&buf[..n]).to_string();
    assert!(
        text.contains("\"type\":\"log\""),
        "solution log 帧应转发给 evaluator"
    );
}

#[tokio::test]
async fn test_sol_unknown_frame_dropped() {
    // spec：未知/非法 type 帧应记录 warn 并丢弃（不转发）
    use tokio::io::AsyncReadExt;

    let (sink, mut source) = tokio::io::duplex(8192);
    let mut writer: std::pin::Pin<Box<dyn tokio::io::AsyncWrite + Send + Unpin>> = Box::pin(sink);

    let SolHarness {
        mut parser,
        mut solution_ready,
        mut tracker,
    } = SolHarness::new();

    let chunk = LogOutput::StdOut {
        message: bytes::Bytes::from_static(b"{\"type\":\"bogus\",\"id\":\"x\"}\n"),
    };
    handle_sol_chunk(
        &mut parser,
        &mut writer,
        chunk,
        &mut solution_ready,
        &mut tracker,
    )
    .await
    .unwrap();

    // 未知 type 帧不应转发（duplex 写端未写数据 → read 超时/空）
    let mut buf = [0u8; 4096];
    let read = tokio::time::timeout(Duration::from_millis(300), source.read(&mut buf)).await;
    match read {
        Err(_) => {} // 超时 = 无数据转发，符合预期
        Ok(Ok(0)) => {}
        Ok(Ok(n)) => {
            let text = String::from_utf8_lossy(&buf[..n]).to_string();
            panic!("未知 type 帧不应转发: {}", text);
        }
        Ok(Err(e)) => panic!("读取出错: {}", e),
    }
}

#[test]
fn test_clamp_runtime_config_caps_time_and_memory() {
    use crate::types::{EvaluatorRuntime, SolutionRuntime};

    let rc = RuntimeConfig {
        evaluator: EvaluatorRuntime {
            image: "noj-evaluator".to_string(),
            command: "python3 /workspace/evaluate.py".to_string(),
            time_limit_ms: 999_999,
            memory_limit_mb: 9999,
            network: None,
            workspace_size_mb: None,
        },
        solution: Some(SolutionRuntime {
            image: "noj-solution".to_string(),
            call_timeout_ms: 999_999,
            memory_limit_mb: 9999,
        }),
    };
    let clamped = clamp_runtime_config(&rc, 5000, 1000);
    assert_eq!(clamped.evaluator.time_limit_ms, 5000);
    assert_eq!(clamped.solution.as_ref().unwrap().call_timeout_ms, 1000);
    assert_eq!(clamped.evaluator.memory_limit_mb, 4096);
    assert_eq!(clamped.solution.as_ref().unwrap().memory_limit_mb, 4096);
}

#[test]
fn test_image_allowed_checks_basename_prefix() {
    assert!(image_allowed("noj-evaluator:latest", "noj-"));
    assert!(image_allowed(
        "registry.example.com/noj-evaluator:latest",
        "noj-"
    ));
    assert!(!image_allowed("other:latest", "noj-"));
    assert!(!image_allowed("", "noj-"));
    assert!(!image_allowed("noj-../evil", "noj-"));
}

#[test]
fn test_validate_runtime_config_rejects_bad_image() {
    use crate::types::{EvaluatorRuntime, SolutionRuntime};

    let rc = RuntimeConfig {
        evaluator: EvaluatorRuntime {
            image: "evil:latest".to_string(),
            command: "python3 x".to_string(),
            time_limit_ms: 1000,
            memory_limit_mb: 256,
            network: None,
            workspace_size_mb: None,
        },
        solution: Some(SolutionRuntime {
            image: "noj-solution".to_string(),
            call_timeout_ms: 1000,
            memory_limit_mb: 256,
        }),
    };
    let err =
        validate_runtime_config("sid-1", &rc, false, "noj-", &["python3".to_string()]).unwrap_err();
    assert!(err.to_string().contains("镜像"));
    assert_eq!(
        err.downcast_ref::<crate::types::PublicJudgeError>(),
        Some(&crate::types::PublicJudgeError(MSG_IMAGE_NOT_ALLOWED)),
    );
}

#[test]
fn test_validate_runtime_config_rejects_network_when_disallowed() {
    use crate::types::{EvaluatorRuntime, SolutionRuntime};

    let rc = RuntimeConfig {
        evaluator: EvaluatorRuntime {
            image: "noj-evaluator".to_string(),
            command: "python3 x".to_string(),
            time_limit_ms: 1000,
            memory_limit_mb: 256,
            network: Some(crate::types::EvaluatorNetwork { enabled: true }),
            workspace_size_mb: None,
        },
        solution: Some(SolutionRuntime {
            image: "noj-solution".to_string(),
            call_timeout_ms: 1000,
            memory_limit_mb: 256,
        }),
    };
    let err =
        validate_runtime_config("sid-2", &rc, false, "noj-", &["python3".to_string()]).unwrap_err();
    assert!(err.to_string().contains("网络"));
    assert_eq!(
        err.downcast_ref::<crate::types::PublicJudgeError>(),
        Some(&crate::types::PublicJudgeError(MSG_NETWORK_NOT_ALLOWED)),
    );
}

#[test]
fn test_validate_runtime_config_rejects_command_not_in_whitelist() {
    use crate::types::{EvaluatorRuntime, SolutionRuntime};

    let rc = RuntimeConfig {
        evaluator: EvaluatorRuntime {
            image: "noj-evaluator".to_string(),
            command: "/opt/secret/run.sh --flag".to_string(),
            time_limit_ms: 1000,
            memory_limit_mb: 256,
            network: None,
            workspace_size_mb: None,
        },
        solution: Some(SolutionRuntime {
            image: "noj-solution".to_string(),
            call_timeout_ms: 1000,
            memory_limit_mb: 256,
        }),
    };
    let err =
        validate_runtime_config("sid-3", &rc, false, "noj-", &["python3".to_string()]).unwrap_err();
    assert!(err.to_string().contains("/opt/secret/run.sh"));
    let r = JudgeResult::from_error(&err, "sid-3", None);
    assert!(r.output.starts_with(MSG_COMMAND_NOT_ALLOWED));
    assert!(!r.output.contains("/opt/secret"));
}

#[test]
fn test_build_judge_result_maps_error_statuses() {
    for status in [
        "error",
        "SystemError",
        "TimeLimitExceeded",
        "MemoryLimitExceeded",
        "RuntimeError",
    ] {
        let r = build_judge_result(
            "sid-status",
            &serde_json::json!({"status": status, "score": 0}),
            "",
            "",
            None,
        )
        .expect("合法评分");
        assert_eq!(r.status, "error", "status={}", status);
    }
    for status in ["Accepted", "WrongAnswer", "finished"] {
        let r = build_judge_result(
            "sid-status2",
            &serde_json::json!({"status": status, "score": 0}),
            "",
            "",
            None,
        )
        .expect("合法评分");
        assert_eq!(r.status, "finished", "status={}", status);
    }
}

#[test]
fn test_build_judge_result_missing_details_is_null() {
    let r = build_judge_result(
        "sid-details",
        &serde_json::json!({"score": 1}),
        "",
        "",
        None,
    )
    .expect("合法评分");
    assert_eq!(r.details, serde_json::Value::Null);
}

// ── append_capped：UTF-8 字符边界回归测试（2026-09-12 评审 §2.2）──
//
// 原实现在截断点落在多字节字符内部时 panic。中文评测输出累计超过 1 MiB
// 是常态，因此这不是理论风险：panic 后结果永不推送、任务永不 ACK，
// 提交会永久卡在 judging 并被 sweeper 反复重投。

#[test]
fn test_append_capped_multibyte_boundary_no_panic() {
    let mut buf = String::new();
    // 1800 字节 = 600 个 3 字节汉字。每个块长度都是 3 的倍数，
    // 而 keep = MAX_OUTPUT_BYTES - 1800 不是 3 的倍数
    //（1046776 % 3 == 1）→ 旧实现的 start 必然落在字符内部，必 panic。
    let chunk = "中".repeat(600);
    assert_eq!(chunk.len(), 1800);
    // 固定迭代 1000 次：跨越 1 MiB 上限（约第 583 次）之后仍持续追加，
    // 覆盖"截断后再截断"的路径。
    for round in 0..1000 {
        append_capped(&mut buf, &chunk);
        assert!(
            buf.len() <= MAX_OUTPUT_BYTES,
            "第 {} 轮后缓冲区超过硬上限: {} > {}",
            round,
            buf.len(),
            MAX_OUTPUT_BYTES
        );
    }
    // 已接近上限（尾部保留策略生效），且内容仍是合法 UTF-8
    assert!(buf.len() > MAX_OUTPUT_BYTES - 1800);
    assert!(buf.ends_with('中'));
}

#[test]
fn test_append_capped_keeps_tail_and_respects_cap() {
    let mut buf = "a".repeat(MAX_OUTPUT_BYTES);
    append_capped(&mut buf, "尾部诊断信息");
    assert!(buf.len() <= MAX_OUTPUT_BYTES);
    assert!(buf.ends_with("尾部诊断信息"));
}

#[test]
fn test_append_capped_single_chunk_larger_than_cap() {
    let mut buf = String::from("已有内容");
    // 单次追加超过上限：只保留尾部，且必须对齐字符边界
    let huge = format!("{}{}", "前".repeat(MAX_OUTPUT_BYTES / 3), "END");
    append_capped(&mut buf, &huge);
    assert!(
        buf.len() <= MAX_OUTPUT_BYTES,
        "单次超大追加后仍须受上限约束: {}",
        buf.len()
    );
    assert!(buf.ends_with("END"));
    assert!(!buf.starts_with("已有内容"));
}

#[test]
fn test_append_capped_small_chunks_accumulate() {
    let mut buf = String::new();
    for i in 0..1000 {
        append_capped(&mut buf, &format!("行 {}\n", i));
    }
    assert!(buf.len() < MAX_OUTPUT_BYTES);
    assert!(buf.starts_with("行 0\n"));
    assert!(buf.ends_with("行 999\n"));
}

// ── VULN-16：管道写入超时 / EPIPE 判定 ──

/// 写成功必须被区分出来（`Written`），不能被当作异常吞掉。
#[tokio::test]
async fn test_forward_frame_with_timeout_reports_written() {
    use tokio::io::AsyncReadExt;

    let (sink, mut source) = tokio::io::duplex(8192);
    let mut writer: std::pin::Pin<Box<dyn tokio::io::AsyncWrite + Send + Unpin>> = Box::pin(sink);

    let frame = serde_json::json!({"type":"call","id":"c1","fn":"solve","args":[1]});
    let outcome = forward_frame_with_timeout(&mut writer, &frame, Duration::from_millis(200))
        .await
        .unwrap();
    assert_eq!(outcome, PipeWriteOutcome::Written);

    let mut buf = [0u8; 256];
    let n = tokio::time::timeout(Duration::from_secs(2), source.read(&mut buf))
        .await
        .expect("读取转发内容超时")
        .unwrap();
    let text = String::from_utf8_lossy(&buf[..n]).to_string();
    assert!(text.contains("\"id\":\"c1\""));
    assert!(text.ends_with('\n'), "NDJSON 帧必须以换行结尾");
}

/// 对端 stdin 已关闭（EPIPE）→ `PeerGone`（不是 Err，也不静默丢失）。
#[tokio::test]
async fn test_forward_frame_reports_peer_gone_on_epipe() {
    let (sink, source) = tokio::io::duplex(8192);
    drop(source); // 对端读端消失 → 写入返回 BrokenPipe

    let mut writer: std::pin::Pin<Box<dyn tokio::io::AsyncWrite + Send + Unpin>> = Box::pin(sink);
    let frame = serde_json::json!({"type":"call","id":"c-dead"});
    let outcome = forward_frame_with_timeout(&mut writer, &frame, Duration::from_millis(200))
        .await
        .unwrap();
    assert_eq!(outcome, PipeWriteOutcome::PeerGone);
}

/// 对端不再读取（管道缓冲写满）→ 必须在短超时内返回 `PeerGone`，
/// 不得无限阻塞（否则外层 select! 死锁、题目总超时失效）。
#[tokio::test]
async fn test_forward_frame_times_out_when_peer_stops_reading() {
    // 缓冲极小且读端存活但不读 → write_all 必然阻塞
    let (sink, _source) = tokio::io::duplex(8);
    let mut writer: std::pin::Pin<Box<dyn tokio::io::AsyncWrite + Send + Unpin>> = Box::pin(sink);

    let frame = serde_json::json!({"type":"log","data":"x".repeat(4096)});
    let started = Instant::now();
    let outcome = forward_frame_with_timeout(&mut writer, &frame, Duration::from_millis(50))
        .await
        .unwrap();
    assert_eq!(outcome, PipeWriteOutcome::PeerGone);
    assert!(
        started.elapsed() < Duration::from_secs(2),
        "写入超时必须快速返回，实际耗时 {:?}",
        started.elapsed()
    );
}

/// handle_eval_chunk：solution stdin 已死时返回 false（调用方据此结束该流）。
#[tokio::test]
async fn test_handle_eval_chunk_reports_solution_pipe_gone() {
    let (sink, source) = tokio::io::duplex(8192);
    drop(source);
    let mut writer: std::pin::Pin<Box<dyn tokio::io::AsyncWrite + Send + Unpin>> = Box::pin(sink);

    let EvalHarness {
        mut parser,
        mut stderr_buf,
        mut stdout_full,
        mut result_payload,
        mut tracker,
    } = EvalHarness::new();

    let chunk = LogOutput::StdOut {
        message: bytes::Bytes::from_static(
            b"{\"type\":\"call\",\"id\":\"x\",\"fn\":\"solve\",\"args\":[1]}\n",
        ),
    };
    let pipe_ok = handle_eval_chunk(
        &mut parser,
        &mut stderr_buf,
        &mut stdout_full,
        &mut writer,
        &mut result_payload,
        &mut tracker,
        chunk,
    )
    .await
    .unwrap();
    assert!(!pipe_ok, "solution stdin 已死时必须返回 false");
}

/// handle_sol_chunk：evaluator stdin 已死时返回 false（触发异常收尾）。
#[tokio::test]
async fn test_handle_sol_chunk_reports_evaluator_pipe_gone() {
    let (sink, source) = tokio::io::duplex(8192);
    drop(source);
    let mut writer: std::pin::Pin<Box<dyn tokio::io::AsyncWrite + Send + Unpin>> = Box::pin(sink);

    let SolHarness {
        mut parser,
        mut solution_ready,
        mut tracker,
    } = SolHarness::new();

    let chunk = LogOutput::StdOut {
        message: bytes::Bytes::from_static(
            b"{\"type\":\"log\",\"stream\":\"stdout\",\"data\":\"hi\"}\n",
        ),
    };
    let pipe_ok = handle_sol_chunk(
        &mut parser,
        &mut writer,
        chunk,
        &mut solution_ready,
        &mut tracker,
    )
    .await
    .unwrap();
    assert!(!pipe_ok, "evaluator stdin 已死时必须返回 false");
}

/// 正常路径回归：管道可用时两个 handler 都返回 true（语义未被破坏）。
#[tokio::test]
async fn test_handlers_report_pipe_ok_in_normal_path() {
    let (sink, _source) = tokio::io::duplex(8192);
    let mut writer: std::pin::Pin<Box<dyn tokio::io::AsyncWrite + Send + Unpin>> = Box::pin(sink);

    let EvalHarness {
        mut parser,
        mut stderr_buf,
        mut stdout_full,
        mut result_payload,
        mut tracker,
    } = EvalHarness::new();

    let eval_ok = handle_eval_chunk(
        &mut parser,
        &mut stderr_buf,
        &mut stdout_full,
        &mut writer,
        &mut result_payload,
        &mut tracker,
        LogOutput::StdOut {
            message: bytes::Bytes::from_static(
                b"{\"type\":\"call\",\"id\":\"ok1\",\"fn\":\"solve\",\"args\":[]}\n",
            ),
        },
    )
    .await
    .unwrap();
    assert!(eval_ok);

    let SolHarness {
        mut parser,
        mut solution_ready,
        mut tracker,
    } = SolHarness::new();
    let sol_ok = handle_sol_chunk(
        &mut parser,
        &mut writer,
        LogOutput::StdOut {
            message: bytes::Bytes::from_static(
                b"{\"type\":\"log\",\"stream\":\"stdout\",\"data\":\"hi\"}\n",
            ),
        },
        &mut solution_ready,
        &mut tracker,
    )
    .await
    .unwrap();
    assert!(sol_ok);
}

/// prediction 提交没有 Solution 运行时；clamp 与 validate 都必须成功，
/// 不得因为 `solution == None` 报错（无 Docker，纯逻辑）。
#[test]
fn test_clamp_and_validate_allow_absent_solution() {
    use crate::types::EvaluatorRuntime;

    let rc = RuntimeConfig {
        evaluator: EvaluatorRuntime {
            image: "noj-evaluator".to_string(),
            command: "python3 /workspace/evaluate.py".to_string(),
            time_limit_ms: 999_999,
            memory_limit_mb: 9999,
            network: None,
            workspace_size_mb: Some(4096),
        },
        solution: None,
    };

    let clamped = clamp_runtime_config(&rc, 5000, 1000);
    assert!(clamped.solution.is_none(), "无 solution 时不应被凭空创建");
    assert_eq!(clamped.evaluator.time_limit_ms, 5000);
    assert_eq!(clamped.evaluator.memory_limit_mb, 4096);

    assert!(
        validate_runtime_config("sid-pred", &rc, false, "noj-", &["python3".to_string()]).is_ok(),
        "无 solution 的 prediction 配置应通过白名单复验"
    );
}

/// 双容器路径必须携带 solution；缺失时给出明确的守卫错误（无 Docker）。
#[test]
fn test_require_solution_rejects_absent_solution() {
    use crate::types::EvaluatorRuntime;

    let rc = RuntimeConfig {
        evaluator: EvaluatorRuntime {
            image: "noj-evaluator".to_string(),
            command: "python3 /workspace/evaluate.py".to_string(),
            time_limit_ms: 1000,
            memory_limit_mb: 256,
            network: None,
            workspace_size_mb: None,
        },
        solution: None,
    };
    let err = require_solution("sid-pred-guard", &rc).unwrap_err();
    assert!(err.to_string().contains("缺少 solution"), "err={}", err);
}
