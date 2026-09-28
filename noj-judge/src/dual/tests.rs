/**
 * `dual` 模块的单元测试（自 `dual/mod.rs` 拆出，见该文件顶部说明）。
 *
 * 作为 `dual` 的**子模块**，`use super::*;` 仍可访问 `dual` 的私有项（含其
 * `use` 别名），因此本文件与拆分前的内联 `mod tests` 语义完全一致；拆出只是为了
 * 让 `dual/mod.rs` 回到单文件规模棘轮（`scripts/check-file-size.ts`）允许的范围。
 */
use super::pipe::forward_frame_with_timeout;
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
    let r = build_judge_result("sid-1", &parsed, "", "", Some(7));
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
    let r = build_judge_result("sid-2", &parsed, "stderr", "stdout", None);
    assert_eq!(r.status, "finished");
    assert!(r.output.contains("stderr"));
}

#[test]
fn test_build_judge_result_missing_fields() {
    let parsed = serde_json::json!({});
    let r = build_judge_result("sid-3", &parsed, "", "", None);
    assert_eq!(r.status, "finished");
    assert_eq!(r.score, 0);
}

#[test]
fn test_finalize_outcome_mapping() {
    // 总超时优先：无论是否发过 CallTimeout 都归 SystemError
    assert_eq!(
        finalize_outcome(Some(TimeoutKind::Startup), false),
        JudgeStatus::SystemError
    );
    assert_eq!(
        finalize_outcome(Some(TimeoutKind::Startup), true),
        JudgeStatus::SystemError
    );
    assert_eq!(
        finalize_outcome(Some(TimeoutKind::Total), false),
        JudgeStatus::SystemError
    );
    assert_eq!(
        finalize_outcome(Some(TimeoutKind::Total), true),
        JudgeStatus::SystemError
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
        },
        solution: SolutionRuntime {
            image: "noj-solution".to_string(),
            call_timeout_ms: 999_999,
            memory_limit_mb: 9999,
        },
    };
    let clamped = clamp_runtime_config(&rc, 5000, 1000);
    assert_eq!(clamped.evaluator.time_limit_ms, 5000);
    assert_eq!(clamped.solution.call_timeout_ms, 1000);
    assert_eq!(clamped.evaluator.memory_limit_mb, 4096);
    assert_eq!(clamped.solution.memory_limit_mb, 4096);
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
        },
        solution: SolutionRuntime {
            image: "noj-solution".to_string(),
            call_timeout_ms: 1000,
            memory_limit_mb: 256,
        },
    };
    let err =
        validate_runtime_config("sid-1", &rc, false, "noj-", &["python3".to_string()]).unwrap_err();
    assert!(err.to_string().contains("镜像"));
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
        },
        solution: SolutionRuntime {
            image: "noj-solution".to_string(),
            call_timeout_ms: 1000,
            memory_limit_mb: 256,
        },
    };
    let err =
        validate_runtime_config("sid-2", &rc, false, "noj-", &["python3".to_string()]).unwrap_err();
    assert!(err.to_string().contains("网络"));
}

#[test]
fn test_build_judge_result_clamps_score() {
    let r = build_judge_result(
        "sid-clamp",
        &serde_json::json!({"score": 99999, "details": {}}),
        "",
        "",
        None,
    );
    assert_eq!(r.score, 10000);

    let r2 = build_judge_result(
        "sid-clamp2",
        &serde_json::json!({"score": -5, "details": {}}),
        "",
        "",
        None,
    );
    assert_eq!(r2.score, 0);
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
        );
        assert_eq!(r.status, "error", "status={}", status);
    }
    for status in ["Accepted", "WrongAnswer", "finished"] {
        let r = build_judge_result(
            "sid-status2",
            &serde_json::json!({"status": status, "score": 0}),
            "",
            "",
            None,
        );
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
    );
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
