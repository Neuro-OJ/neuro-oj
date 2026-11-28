/**
 * `dual` 模块 Solution log 配额限流单元测试（保留 `#801` 日志捕获配额）。
 */
use super::*;

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
