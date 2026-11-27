/**
 * `dual` 模块 P0–P2 扩展单元测试：
 * - Solution log 配额限流（P0-1）
 * - `isolation_mode` 配置校验与 `cancel` 帧写出（P1-1）
 * - 双向分片帧 `chunk` 中继与防 OOM 配额（P2-1）
 */
use super::pipe::PipeWriteOutcome;
use super::*;

struct EvalHarness {
    parser: LineParser,
    stderr_buf: String,
    stdout_full: String,
    result_payload: ResultPayload,
    tracker: InFlightTracker,
}

impl EvalHarness {
    fn new() -> Self {
        Self {
            parser: LineParser::new(),
            stderr_buf: String::new(),
            stdout_full: String::new(),
            result_payload: ResultPayload::new(),
            tracker: InFlightTracker::new(2000, 0),
        }
    }
}

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
            tracker: InFlightTracker::new(2000, 0),
        }
    }
}

#[tokio::test]
async fn test_handle_sol_chunk_enforces_log_frame_and_total_quota() {
    let (sink, mut source) = tokio::io::duplex(2 * 1024 * 1024);
    let mut writer: std::pin::Pin<Box<dyn tokio::io::AsyncWrite + Send + Unpin>> = Box::pin(sink);
    let SolHarness {
        mut parser,
        mut solution_ready,
        mut tracker,
    } = SolHarness::new();

    // 1. 单帧 > 64 KiB 被丢弃
    let oversized = serde_json::json!({
        "type": "log",
        "stream": "stdout",
        "data": "x".repeat(crate::dual::tracker::MAX_SOLUTION_LOG_FRAME_BYTES + 1)
    });
    let mut oversized_bytes = serde_json::to_vec(&oversized).unwrap();
    oversized_bytes.push(b'\n');
    assert!(handle_sol_chunk(
        &mut parser,
        &mut writer,
        LogOutput::StdOut {
            message: bytes::Bytes::from(oversized_bytes),
        },
        &mut solution_ready,
        &mut tracker,
    )
    .await
    .unwrap());

    // 2. 合法帧累积直到超过 1 MiB，超出后丢弃但后续 result 帧仍正常转发
    let chunk_data = "y".repeat(crate::dual::tracker::MAX_SOLUTION_LOG_FRAME_BYTES);
    let log_frame = serde_json::json!({
        "type": "log",
        "stream": "stdout",
        "data": chunk_data
    });
    let mut log_line = serde_json::to_vec(&log_frame).unwrap();
    log_line.push(b'\n');

    // 16 * 64 KiB = 1 MiB 全部放行，第 17 次超限丢弃
    for _ in 0..17 {
        assert!(handle_sol_chunk(
            &mut parser,
            &mut writer,
            LogOutput::StdOut {
                message: bytes::Bytes::from(log_line.clone()),
            },
            &mut solution_ready,
            &mut tracker,
        )
        .await
        .unwrap());
    }

    // 注册 call 帧以让 result 帧命中转发
    tracker.on_call_frame(
        &serde_json::json!({"type": "call", "id": "c-ok", "fn": "solve", "args": []}),
        std::time::Instant::now(),
    );
    assert!(handle_sol_chunk(
        &mut parser,
        &mut writer,
        LogOutput::StdOut {
            message: bytes::Bytes::from_static(
                b"{\"type\":\"result\",\"id\":\"c-ok\",\"value\":42}\n"
            ),
        },
        &mut solution_ready,
        &mut tracker,
    )
    .await
    .unwrap());

    drop(writer);
    use tokio::io::AsyncReadExt;
    let mut out = String::new();
    source.read_to_string(&mut out).await.unwrap();
    let lines: Vec<&str> = out.lines().collect();
    assert_eq!(lines.len(), 17, "应包含 16 条合规 log 帧 + 1 条 result 帧");
    assert!(lines.last().unwrap().contains("\"id\":\"c-ok\""));
}

#[test]
fn test_validate_runtime_config_checks_isolation_mode() {
    use crate::types::{EvaluatorRuntime, SolutionRuntime};

    let make_rc = |mode: Option<&str>| RuntimeConfig {
        evaluator: EvaluatorRuntime {
            image: "noj-evaluator".to_string(),
            command: "python3 /workspace/evaluate.py".to_string(),
            time_limit_ms: 1000,
            memory_limit_mb: 256,
            network: None,
            workspace_size_mb: None,
        },
        solution: Some(SolutionRuntime {
            image: "noj-solution".to_string(),
            call_timeout_ms: 1000,
            memory_limit_mb: 256,
            isolation_mode: mode.map(str::to_string),
        }),
    };

    for valid in [None, Some("shared"), Some("fork_per_call")] {
        assert!(validate_runtime_config(
            "sid-iso-ok",
            &make_rc(valid),
            false,
            "noj-",
            &["python3".to_string()]
        )
        .is_ok());
    }

    let err = validate_runtime_config(
        "sid-iso-bad",
        &make_rc(Some("invalid_mode")),
        false,
        "noj-",
        &["python3".to_string()],
    )
    .unwrap_err();
    assert_eq!(
        err.downcast_ref::<crate::types::PublicJudgeError>(),
        Some(&crate::types::PublicJudgeError(
            super::config::MSG_ISOLATION_MODE_NOT_ALLOWED
        )),
    );
}

#[tokio::test]
async fn test_write_cancel_frame_writes_ndjson_cancel() {
    let (sink, mut source) = tokio::io::duplex(4096);
    let mut writer: std::pin::Pin<Box<dyn tokio::io::AsyncWrite + Send + Unpin>> = Box::pin(sink);
    let outcome = super::pipe::write_cancel_frame(&mut writer, "call-42")
        .await
        .unwrap();
    assert_eq!(outcome, PipeWriteOutcome::Written);
    drop(writer);

    use tokio::io::AsyncReadExt;
    let mut out = String::new();
    source.read_to_string(&mut out).await.unwrap();
    let v: serde_json::Value = serde_json::from_str(out.trim()).unwrap();
    assert_eq!(v["type"], "cancel");
    assert_eq!(v["id"], "call-42");
}

#[tokio::test]
async fn test_handle_eval_chunk_relays_chunked_call_and_skips_stdout_full() {
    let mut h = EvalHarness::new();
    let (sink, mut source) = tokio::io::duplex(65536);
    let mut writer: std::pin::Pin<Box<dyn tokio::io::AsyncWrite + Send + Unpin>> = Box::pin(sink);

    let f0 = serde_json::json!({
        "type": "chunk",
        "stream_id": "s-1",
        "id": "call-chunk-1",
        "kind": "call",
        "seq": 0,
        "total": 2,
        "timeout_ms": 1500,
        "data": "cGFydDA="
    });
    let f1 = serde_json::json!({
        "type": "chunk",
        "stream_id": "s-1",
        "id": "call-chunk-1",
        "kind": "call",
        "seq": 1,
        "total": 2,
        "data": "cGFydDE="
    });
    let mut bytes = Vec::new();
    bytes.extend_from_slice(f0.to_string().as_bytes());
    bytes.push(b'\n');
    bytes.extend_from_slice(f1.to_string().as_bytes());
    bytes.push(b'\n');

    assert!(handle_eval_chunk(
        &mut h.parser,
        &mut h.stderr_buf,
        &mut h.stdout_full,
        &mut writer,
        &mut h.result_payload,
        &mut h.tracker,
        LogOutput::StdOut {
            message: bytes::Bytes::from(bytes),
        },
    )
    .await
    .unwrap());
    drop(writer);

    assert!(
        !h.tracker.is_empty(),
        "首片 call 分片应触发 InFlightTracker 登记"
    );
    assert!(
        h.stdout_full.is_empty(),
        "分片帧不应写入 stdout_full 污染诊断日志"
    );

    use tokio::io::AsyncReadExt;
    let mut out = String::new();
    source.read_to_string(&mut out).await.unwrap();
    let lines: Vec<&str> = out.lines().collect();
    assert_eq!(lines.len(), 2);
}

#[tokio::test]
async fn test_handle_sol_chunk_relays_chunked_result_and_drops_unknown_id() {
    let (sink, mut source) = tokio::io::duplex(65536);
    let mut writer: std::pin::Pin<Box<dyn tokio::io::AsyncWrite + Send + Unpin>> = Box::pin(sink);
    let SolHarness {
        mut parser,
        mut solution_ready,
        mut tracker,
    } = SolHarness::new();

    tracker.on_call_frame(
        &serde_json::json!({"type": "call", "id": "c-big", "fn": "solve", "args": []}),
        std::time::Instant::now(),
    );

    // 未知 call id 分片应丢弃
    let unknown_chunk = serde_json::json!({
        "type": "chunk",
        "stream_id": "u-0",
        "id": "c-missing",
        "kind": "result",
        "seq": 0,
        "total": 1,
        "data": "YWJj"
    });
    // 合法 2 片 result：首片保持 in-flight，末片释放
    let r0 = serde_json::json!({
        "type": "chunk",
        "stream_id": "s-2",
        "id": "c-big",
        "kind": "result",
        "seq": 0,
        "total": 2,
        "data": "cGFydDA="
    });
    let r1 = serde_json::json!({
        "type": "chunk",
        "stream_id": "s-2",
        "id": "c-big",
        "kind": "result",
        "seq": 1,
        "total": 2,
        "data": "cGFydDE="
    });

    for (idx, frame) in [&unknown_chunk, &r0, &r1].into_iter().enumerate() {
        let mut line = frame.to_string().into_bytes();
        line.push(b'\n');
        assert!(handle_sol_chunk(
            &mut parser,
            &mut writer,
            LogOutput::StdOut {
                message: bytes::Bytes::from(line),
            },
            &mut solution_ready,
            &mut tracker,
        )
        .await
        .unwrap());
        if idx == 1 {
            assert!(
                !tracker.is_empty(),
                "首片未结束前不应提前清除 in-flight 状态"
            );
        }
    }
    assert!(tracker.is_empty(), "末片完成后应移除 in-flight 状态");
    drop(writer);

    use tokio::io::AsyncReadExt;
    let mut out = String::new();
    source.read_to_string(&mut out).await.unwrap();
    let lines: Vec<&str> = out.lines().collect();
    assert_eq!(lines.len(), 2, "未知 id 丢弃，仅转发两条有效 result 分片");
}

#[tokio::test]
async fn test_handle_sol_chunk_enforces_chunk_frame_and_total_quota() {
    let (sink, mut source) = tokio::io::duplex(256 * 1024);
    let mut writer: std::pin::Pin<Box<dyn tokio::io::AsyncWrite + Send + Unpin>> = Box::pin(sink);
    let SolHarness {
        mut parser,
        mut solution_ready,
        mut tracker,
    } = SolHarness::new();

    tracker.on_call_frame(
        &serde_json::json!({"type": "call", "id": "c-quota", "fn": "solve", "args": []}),
        std::time::Instant::now(),
    );

    // 1. 单片 > 1 MiB 被拒绝
    let oversized_chunk = serde_json::json!({
        "type": "chunk",
        "stream_id": "s-big",
        "id": "c-quota",
        "kind": "result",
        "seq": 0,
        "total": 2,
        "data": "a".repeat(crate::dual::tracker::MAX_CHUNK_FRAME_BYTES + 1)
    });
    let mut bytes = oversized_chunk.to_string().into_bytes();
    bytes.push(b'\n');
    assert!(handle_sol_chunk(
        &mut parser,
        &mut writer,
        LogOutput::StdOut {
            message: bytes::Bytes::from(bytes),
        },
        &mut solution_ready,
        &mut tracker,
    )
    .await
    .unwrap());
    assert!(!tracker.is_empty());

    // 2. 累计超过 64 MiB 后被拒绝
    let unit_len = crate::dual::tracker::MAX_CHUNK_FRAME_BYTES;
    let unit_chunk = serde_json::json!({
        "type": "chunk",
        "stream_id": "s-flood",
        "id": "c-quota",
        "kind": "result",
        "seq": 0,
        "total": 100,
        "data": "b".repeat(unit_len)
    });
    for _ in 0..64 {
        assert!(tracker.on_sol_chunk_frame(&unit_chunk, std::time::Instant::now()));
    }
    assert!(
        !tracker.on_sol_chunk_frame(&unit_chunk, std::time::Instant::now()),
        "超出 64 MiB 总配额的分片应被拒绝"
    );

    drop(writer);
    use tokio::io::AsyncReadExt;
    let mut out = String::new();
    source.read_to_string(&mut out).await.unwrap();
    assert!(out.is_empty(), "单帧超限的分片不得写入输出管道");
}
