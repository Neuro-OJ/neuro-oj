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
use tracing::warn;

/// NDJSON 帧 `type` 字段允许的值（与 Python SDK `host.py` 对齐）。
pub const FRAME_READY: &str = "ready";
pub const FRAME_CALL: &str = "call";
pub const FRAME_CAPABILITY: &str = "capability";
/// cap_reg：evaluator → judge 私有帧（capability 默认超时上报），judge 不转发
pub const FRAME_CAP_REG: &str = "cap_reg";
pub const FRAME_RESULT: &str = "result";
pub const FRAME_ERROR: &str = "error";
pub const FRAME_LOG: &str = "log";
pub const FRAME_SHUTDOWN: &str = "shutdown";

/// 最终结果标记行（evaluator stdout 中的独立一行）。
pub const RESULT_MARKER: &str = "---RESULT---";

/// 行分类枚举（同时用于 Evaluator 与 Solution 的 stdout 行）。
///
/// 命名沿用早期仅覆盖 Evaluator 时期的 `EvaluatorLine`，现被 [`LineParser`] 双向复用。
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
///
/// 安全上限：恶意提交可向 stdout 输出超长无换行行，若无限缓冲会拖垮 judge
/// 进程（容器内存限制不约束 judge）。超过 [`MAX_BUFFER_BYTES`] 时丢弃头部、
/// 保留尾部（诊断信息优先，评测继续）。
#[derive(Debug, Default)]
pub struct LineParser {
    buf: Vec<u8>,
}

/// 缓冲上限：4 MiB（覆盖正常协议帧 + 日志余量，远超单帧 1 MiB 软上限）。
pub const MAX_BUFFER_BYTES: usize = 4 * 1024 * 1024;

impl LineParser {
    pub fn new() -> Self {
        Self { buf: Vec::new() }
    }

    /// 喂入一个 chunk，返回所有切分完成的行。
    ///
    /// 若缓冲将超过 [`MAX_BUFFER_BYTES`]，丢弃头部、保留尾部
    /// （诊断信息优先；避免恶意超长输出拖垮 judge 进程）。
    pub fn feed(&mut self, chunk: &[u8]) -> Vec<EvaluatorLine> {
        if self.buf.len() + chunk.len() > MAX_BUFFER_BYTES {
            warn!(
                "LineParser 缓冲超过上限 {} 字节，丢弃头部（恶意超长输出？）",
                MAX_BUFFER_BYTES
            );
            // 保留尾部：buf 超过保留阈值时丢头部到只剩一半；
            // buf 本身很小（超大 chunk 一次灌入）则清空，避免无界累积
            let keep = MAX_BUFFER_BYTES / 2;
            if self.buf.len() > keep {
                let start = self.buf.len() - keep;
                self.buf.drain(..start);
            } else {
                self.buf.clear();
            }
            // chunk 仍超剩余空间时只取尾部（诊断信息优先），截断后不解析
            let remaining = MAX_BUFFER_BYTES - self.buf.len();
            if chunk.len() > remaining {
                let from = chunk.len() - remaining;
                self.buf.extend_from_slice(&chunk[from..]);
                return Vec::new();
            }
        }
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
}

#[cfg(test)]
impl LineParser {
    /// 丢弃所有缓冲（错误路径上避免被 Drop 时占用内存）。
    pub fn discard(&mut self) {
        self.buf.clear();
    }
}

fn classify_line(line: &str) -> EvaluatorLine {
    let trimmed = line.trim();
    if trimmed == RESULT_MARKER {
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

    #[test]
    fn test_feed_buffer_limit_discards_on_overflow() {
        // 恶意超长无换行输出：超过 MAX_BUFFER_BYTES 时丢弃头部（防 judge OOM）
        let mut p = LineParser::new();
        let big = vec![b'a'; MAX_BUFFER_BYTES + 1];
        let lines = p.feed(&big);
        assert!(lines.is_empty());
        assert!(
            p.buf.len() <= MAX_BUFFER_BYTES,
            "超限后缓冲应被截断到上限内: {}",
            p.buf.len()
        );

        // 截断后恢复正常解析（评测继续）——残留行先以换行结束，再解析合法帧
        let lines = p.feed(b"\n{\"type\":\"call\",\"id\":\"x\"}\n");
        assert!(
            lines.iter().any(|l| matches!(l, EvaluatorLine::Frame(_))),
            "超限截断后应能继续解析协议帧: {:?}",
            lines
        );
    }

    #[test]
    fn test_feed_just_below_limit_ok() {
        // 恰好低于上限的缓冲不丢弃
        let mut p = LineParser::new();
        let chunk = vec![b'a'; MAX_BUFFER_BYTES - 1024];
        let lines = p.feed(&chunk);
        assert!(lines.is_empty());
        assert_eq!(p.buf.len(), MAX_BUFFER_BYTES - 1024);
    }
}
