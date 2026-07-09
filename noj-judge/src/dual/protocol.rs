//! 双容器 NDJSON 协议解析。
//!
//! Evaluator exec stdout 同时承载三类内容（设计稿 §1）：
//! - NDJSON 协议帧（call 帧）
//! - `---RESULT---` 标记（最终结果）
//! - 其他文本（evaluate.py 普通输出，应忽略）
//!
//! Solution exec stdout 仅承载 NDJSON 帧（result/error/log）。
//!
//! 本模块提供：
//! - [`LineParser`]：把字节流按行切分并分类
//! - [`EvaluatorLine`]：行分类枚举
//! - 帧类型常量（与 Python SDK 协议对齐）

use serde_json::Value;

/// NDJSON 帧 `type` 字段允许的值（与 Python SDK `host.py` 对齐）。
///
/// 这些常量目前未在生产代码中引用，但保留供 spec 对照与外部调用方使用。
#[allow(dead_code)]
pub const FRAME_READY: &str = "ready";
#[allow(dead_code)]
pub const FRAME_CALL: &str = "call";
#[allow(dead_code)]
pub const FRAME_RESULT: &str = "result";
#[allow(dead_code)]
pub const FRAME_ERROR: &str = "error";
#[allow(dead_code)]
pub const FRAME_LOG: &str = "log";
#[allow(dead_code)]
pub const FRAME_SHUTDOWN: &str = "shutdown";

/// 错误码允许的值。
#[allow(dead_code)]
pub const ERR_TIMEOUT: &str = "Timeout";
#[allow(dead_code)]
pub const ERR_NOT_FOUND: &str = "NotFound";
#[allow(dead_code)]
pub const ERR_EXCEPTION: &str = "Exception";
#[allow(dead_code)]
pub const ERR_SYSTEM: &str = "SystemError";
#[allow(dead_code)]
pub const ERR_REJECTED: &str = "Rejected";

/// Evaluator stdout 的行分类。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum EvaluatorLine {
    /// NDJSON 协议帧（必须是含 `type` 字段的合法 JSON 对象）。
    Frame(Value),
    /// `---RESULT---` 标记行。下一行非空 JSON 为最终结果。
    ResultMarker,
    /// 非协议行（evaluate.py 普通 print/日志）。调用方应记录后丢弃。
    Unknown(String),
}

/// 把字节流切分为行的解析器。
///
/// docker exec 的 stdout 是字节流，帧可能跨多个 chunk，因此需要缓冲。
#[derive(Debug, Default)]
pub struct LineParser {
    buf: Vec<u8>,
}

impl LineParser {
    pub fn new() -> Self {
        Self { buf: Vec::new() }
    }

    /// 喂入一个 chunk，返回所有切分完成的行。
    pub fn feed(&mut self, chunk: &[u8]) -> Vec<EvaluatorLine> {
        self.buf.extend_from_slice(chunk);
        let mut out = Vec::new();
        while let Some(pos) = self.buf.iter().position(|&b| b == b'\n') {
            let line_bytes: Vec<u8> = self.buf.drain(..=pos).collect();
            // 去掉末尾 \n；保留前导空格在 classify 中 trim
            let trimmed = String::from_utf8_lossy(&line_bytes[..line_bytes.len() - 1]);
            out.push(classify_line(&trimmed));
        }
        out
    }

    /// 取走当前缓冲区剩余内容（不含换行）。用于 EOF 后的尾部残留。
    pub fn drain_remaining(&mut self) -> Vec<EvaluatorLine> {
        if self.buf.is_empty() {
            return Vec::new();
        }
        let s = String::from_utf8_lossy(&self.buf).to_string();
        self.buf.clear();
        vec![classify_line(&s)]
    }

    /// 丢弃所有缓冲（错误路径上避免被 Drop 时占用内存）。
    #[allow(dead_code)]
    pub fn discard(&mut self) {
        self.buf.clear();
    }
}

fn classify_line(line: &str) -> EvaluatorLine {
    let trimmed = line.trim();
    if trimmed == "---RESULT---" {
        return EvaluatorLine::ResultMarker;
    }
    if trimmed.is_empty() {
        return EvaluatorLine::Unknown(String::new());
    }
    if let Ok(v) = serde_json::from_str::<Value>(trimmed) {
        if v.is_object() && v.get("type").is_some() {
            return EvaluatorLine::Frame(v);
        }
    }
    EvaluatorLine::Unknown(line.to_string())
}

/// 从帧中取出 `type` 字段（不存在则返回 None）。
pub fn frame_type(frame: &Value) -> Option<&str> {
    frame.get("type").and_then(Value::as_str)
}

#[cfg(test)]
mod tests {
    use super::*;

    // ── classify_line ─────────────────────────────────

    #[test]
    fn test_classify_result_marker() {
        assert_eq!(classify_line("---RESULT---"), EvaluatorLine::ResultMarker);
        assert_eq!(
            classify_line("   ---RESULT---   "),
            EvaluatorLine::ResultMarker
        );
    }

    #[test]
    fn test_classify_frame() {
        let frame = serde_json::json!({"type": "call", "id": "x", "fn": "solve", "args": [1,2]});
        match classify_line(&frame.to_string()) {
            EvaluatorLine::Frame(v) => {
                assert_eq!(frame_type(&v), Some("call"));
            }
            other => panic!("expected Frame, got {:?}", other),
        }
    }

    #[test]
    fn test_classify_unknown_plain_text() {
        match classify_line("hello world") {
            EvaluatorLine::Unknown(s) => assert_eq!(s, "hello world"),
            other => panic!("expected Unknown, got {:?}", other),
        }
    }

    #[test]
    fn test_classify_unknown_json_without_type() {
        // 合法 JSON 但没有 type 字段 → 不算协议帧
        match classify_line(r#"{"a": 1}"#) {
            EvaluatorLine::Unknown(_) => {}
            other => panic!("expected Unknown, got {:?}", other),
        }
    }

    #[test]
    fn test_classify_unknown_json_array() {
        // JSON 数组不是对象 → 不算协议帧
        match classify_line("[1,2,3]") {
            EvaluatorLine::Unknown(_) => {}
            other => panic!("expected Unknown, got {:?}", other),
        }
    }

    // ── LineParser::feed ──────────────────────────────

    #[test]
    fn test_feed_split_lines() {
        let mut p = LineParser::new();
        let lines = p.feed(
            b"{\"type\":\"call\",\"id\":\"a\"}\n{\"type\":\"result\",\"id\":\"b\",\"value\":1}\n",
        );
        assert_eq!(lines.len(), 2);
        assert!(matches!(lines[0], EvaluatorLine::Frame(_)));
        assert!(matches!(lines[1], EvaluatorLine::Frame(_)));
    }

    #[test]
    fn test_feed_partial_line_buffered() {
        // 半行不应输出，等到 \n 一起出
        let mut p = LineParser::new();
        assert!(p.feed(b"{\"type\":").is_empty());
        assert!(p.feed(b"\"call\",\"id\":\"a\"}\n").len() == 1);
    }

    #[test]
    fn test_feed_multiple_lines_in_one_chunk() {
        let mut p = LineParser::new();
        let lines = p.feed(b"line1\nline2\nline3\n");
        assert_eq!(lines.len(), 3);
        for (i, expected) in ["line1", "line2", "line3"].iter().enumerate() {
            match &lines[i] {
                EvaluatorLine::Unknown(s) => assert_eq!(s, *expected),
                _ => panic!("expected Unknown"),
            }
        }
    }

    #[test]
    fn test_feed_no_newline_keeps_buffered() {
        let mut p = LineParser::new();
        p.feed(b"partial");
        assert_eq!(p.buf, b"partial");
        let lines = p.feed(b" rest\n");
        assert_eq!(lines.len(), 1);
        match &lines[0] {
            EvaluatorLine::Unknown(s) => assert_eq!(s, "partial rest"),
            _ => panic!("expected Unknown"),
        }
    }

    #[test]
    fn test_drain_remaining_no_newline() {
        let mut p = LineParser::new();
        p.feed(b"no newline at end");
        let lines = p.drain_remaining();
        assert_eq!(lines.len(), 1);
        match &lines[0] {
            EvaluatorLine::Unknown(s) => assert_eq!(s, "no newline at end"),
            _ => panic!("expected Unknown"),
        }
    }

    #[test]
    fn test_mixed_protocol_and_unknown() {
        let mut p = LineParser::new();
        let input = b"---RESULT---\n{\"a\":1}\n{\"type\":\"call\",\"id\":\"x\"}\nplain text\n";
        let lines = p.feed(input);
        // 4 行：Marker / Unknown(JSON-no-type) / Frame / Unknown(text)
        assert_eq!(lines.len(), 4);
        assert_eq!(lines[0], EvaluatorLine::ResultMarker);
        assert!(matches!(lines[1], EvaluatorLine::Unknown(_)));
        assert!(matches!(lines[2], EvaluatorLine::Frame(_)));
        assert!(matches!(lines[3], EvaluatorLine::Unknown(_)));
    }

    #[test]
    fn test_empty_line_classified_as_unknown() {
        // 空行（含纯空白）应作为 Unknown，调用方记录后丢弃
        let mut p = LineParser::new();
        let lines = p.feed(b"\n   \n");
        assert_eq!(lines.len(), 2);
        for l in &lines {
            assert!(matches!(l, EvaluatorLine::Unknown(_)));
        }
    }

    #[test]
    fn test_discard_clears_buffer() {
        let mut p = LineParser::new();
        p.feed(b"unfinished");
        assert!(!p.buf.is_empty());
        p.discard();
        assert!(p.buf.is_empty());
    }
}
