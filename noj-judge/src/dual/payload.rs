//! `---RESULT---` 之后的候选 payload 收集与选取。
//!
//! dual 路径的 evaluator 可能在标记与真正的 JSON 之间打印任意非空噪声行
//! （库告警、初始化日志）。早期实现把标记后的**第一个**非空行无条件当作
//! payload，噪声占位后 `serde_json::from_str` 失败并经 `?` 冒泡，整次评测被判为
//! `platform_error`，合法成绩被丢弃（Issue #654）。
//!
//! 这里按出现顺序保留标记后的若干行候选（有界），由 [`resolve_payload`] 依次
//! 尝试解析，取第一个「合法 JSON 且含 `score`」的行作为结果；只有全部候选都
//! 不可用时才报错，并在错误里保留候选数量与片段。

use anyhow::Result;
use serde_json::Value;

use super::result::build_judge_result;
use crate::dual::append_capped;
use crate::types::JudgeResult;

/// 候选行数量上限（与 prediction 路径同口径，防恶意 evaluator 刷屏）。
pub(crate) const MAX_RESULT_CANDIDATES: usize = 8;

/// 错误信息中候选片段的截断长度（字符数）。
const SNIPPET_CHARS: usize = 120;

/// 标记之后的候选 payload 收集器。
///
/// 候选**只来自标记之后**：标记之前的诊断 JSON 若被当成结果，会因缺 `score`
/// 被判为非法评分（platform_error），反而丢掉后面的合法成绩。
#[derive(Debug, Default)]
pub struct ResultPayload {
    /// 是否已见 `---RESULT---`。
    seen_marker: bool,
    /// 标记后的候选行，按出现顺序，最多 [`MAX_RESULT_CANDIDATES`] 条。
    candidates: Vec<String>,
}

impl ResultPayload {
    pub fn new() -> Self {
        Self::default()
    }

    /// 收到 `---RESULT---` 标记：进入（或重置为）「等待候选」状态。
    ///
    /// 与既有语义一致：后出现的标记重置候选，payload 以最后一段标记后的行为准。
    pub(crate) fn on_marker(&mut self) {
        self.seen_marker = true;
        self.candidates.clear();
    }

    /// 记录标记后的一行普通输出（空行不计入候选）。
    pub(crate) fn push_line(&mut self, line: &str) {
        if !self.seen_marker || self.candidates.len() >= MAX_RESULT_CANDIDATES {
            return;
        }
        let trimmed = line.trim();
        if trimmed.is_empty() {
            return;
        }
        // 单条候选沿用 append_capped 的硬上限（1 MiB，超出丢头部保尾部），
        // 避免恶意超长行把 judge 进程内存撑爆。
        let mut candidate = String::new();
        append_capped(&mut candidate, trimmed);
        self.candidates.push(candidate);
    }

    /// 是否已见标记（跨 chunk 状态，供测试断言）。
    #[cfg(test)]
    pub(crate) fn seen_marker(&self) -> bool {
        self.seen_marker
    }

    /// 是否存在任何候选行。
    pub fn has_candidates(&self) -> bool {
        !self.candidates.is_empty()
    }

    /// 首个候选（保持「标记后第一行」的既有展示语义）。
    ///
    /// 仅单元测试与 `tests/` 集成测试断言使用（bin 目标下未被引用）。
    #[allow(dead_code)]
    pub fn primary(&self) -> Option<&str> {
        self.candidates.first().map(String::as_str)
    }

    /// 是否存在**可用**候选：可解析为 JSON 且含 `score`。
    ///
    /// 这是评测循环的提前退出条件。若用「存在任意候选」代替，则
    /// 「标记 → 噪声 → 真 JSON」会在噪声行处提前收尾，真结果永远读不到
    /// （prediction 路径的同类缺陷，2026-09-24 评审）。
    pub(crate) fn has_usable(&self) -> bool {
        self.candidates
            .iter()
            .any(|c| serde_json::from_str::<Value>(c).is_ok_and(|v| v.get("score").is_some()))
    }

    /// 按出现顺序返回去重后的候选。
    pub(crate) fn candidates_ordered(&self) -> Vec<String> {
        let mut out: Vec<String> = Vec::with_capacity(self.candidates.len());
        for c in &self.candidates {
            let t = c.trim();
            if t.is_empty() || out.iter().any(|e| e == t) {
                continue;
            }
            out.push(t.to_string());
        }
        out
    }
}

/// 依次尝试候选，返回第一个可评分的结果。
///
/// 全部候选都不可用时才报错：解析失败的错误里带上候选数量与首个候选片段，
/// 便于从日志定位 evaluator 到底打印了什么。
pub(crate) fn resolve_payload(
    submission_id: &str,
    payload: &ResultPayload,
    stderr: &str,
    stdout: &str,
    rejudge_seq: Option<i64>,
) -> Result<JudgeResult> {
    let candidates = payload.candidates_ordered();
    if candidates.is_empty() {
        anyhow::bail!("---RESULT--- 之后没有可解析的结果行");
    }

    let total = candidates.len();
    let mut last_err: Option<String> = None;
    let mut parsed_without_score: Option<Value> = None;

    for (idx, candidate) in candidates.iter().enumerate() {
        match serde_json::from_str::<Value>(candidate) {
            Ok(parsed) if parsed.get("score").is_some() => {
                return build_judge_result(submission_id, &parsed, stderr, stdout, rejudge_seq);
            }
            Ok(parsed) => {
                // 合法 JSON 但不是结果（调试输出等）：继续尝试后续候选。
                last_err = Some(format!(
                    "第 {} 个候选是合法 JSON 但缺少 score 字段",
                    idx + 1
                ));
                parsed_without_score.get_or_insert(parsed);
            }
            Err(e) => {
                last_err = Some(format!("第 {} 个候选不是合法 JSON: {}", idx + 1, e));
            }
        }
    }

    if let Some(parsed) = parsed_without_score {
        // 候选里没有任何带 score 的 JSON：沿用 defect #29 的口径，由
        // build_judge_result 统一给出非法评分错误（平台错误，不覆盖已有成绩）。
        return build_judge_result(submission_id, &parsed, stderr, stdout, rejudge_seq);
    }

    Err(anyhow::anyhow!(
        "---RESULT--- JSON 解析失败：已尝试 {} 个候选均不可解析（最后一个错误: {}）；首个候选片段: {}",
        total,
        last_err.unwrap_or_else(|| "无".to_string()),
        snippet(&candidates[0]),
    ))
}

/// 截断候选片段，避免错误信息被超长行刷屏。
fn snippet(s: &str) -> String {
    let total = s.chars().count();
    if total <= SNIPPET_CHARS {
        return s.to_string();
    }
    let head: String = s.chars().take(SNIPPET_CHARS).collect();
    format!("{head}…（已截断，原长 {} 字符）", total)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::dual::protocol::LineParser;
    use crate::dual::tracker::InFlightTracker;
    use bollard::container::LogOutput;

    fn stdout_chunk(s: &'static str) -> LogOutput {
        LogOutput::StdOut {
            message: bytes::Bytes::from_static(s.as_bytes()),
        }
    }

    /// 用真实的 `handle_eval_chunk` 喂入一个 stdout chunk（忽略转发与全文收集）。
    async fn feed(
        parser: &mut LineParser,
        payload: &mut ResultPayload,
        tracker: &mut InFlightTracker,
        chunk: LogOutput,
    ) {
        let (sink, _source) = tokio::io::duplex(8192);
        let mut writer: std::pin::Pin<Box<dyn tokio::io::AsyncWrite + Send + Unpin>> =
            Box::pin(sink);
        let mut stderr = String::new();
        let mut stdout = String::new();
        super::super::handle_eval_chunk(
            parser,
            &mut stderr,
            &mut stdout,
            &mut writer,
            payload,
            tracker,
            chunk,
        )
        .await
        .unwrap();
    }

    /// 标记 → 噪声行 → 真 JSON：仍须取到真结果（与 prediction 路径同构）。
    ///
    /// 回归 Issue #654：噪声行占位后解析失败，合法成绩被丢弃为 platform_error。
    #[test]
    fn test_noise_line_between_marker_and_json_still_resolves() {
        let mut payload = ResultPayload::new();
        payload.on_marker();
        payload.push_line("warning: deprecated API");
        payload.push_line("{\"score\":6666,\"details\":{}}");

        assert_eq!(payload.primary(), Some("warning: deprecated API"));
        assert!(payload.has_usable());

        let result =
            resolve_payload("sub-1", &payload, "", "", None).expect("噪声行不得吞掉真结果");
        assert_eq!(result.score, 6666);
        assert_eq!(result.status, "finished");
    }

    /// 经真实 `handle_eval_chunk` 的同一场景：噪声与标记同 chunk，真 JSON 后到。
    ///
    /// 同时覆盖「提前退出条件」：噪声行到达后 `has_usable()` 必须为假，否则编排
    /// 循环会在噪声处收尾，真结果永远读不到。
    #[tokio::test]
    async fn test_noise_line_does_not_stop_reading_via_handle_eval_chunk() {
        let mut parser = LineParser::new();
        let mut payload = ResultPayload::new();
        let mut tracker = InFlightTracker::new(2000);

        feed(
            &mut parser,
            &mut payload,
            &mut tracker,
            stdout_chunk("---RESULT---\nwarning: deprecated API\n"),
        )
        .await;
        assert!(
            !payload.has_usable(),
            "噪声行不得被视为可用结果（否则编排循环提前收尾）"
        );

        feed(
            &mut parser,
            &mut payload,
            &mut tracker,
            stdout_chunk("{\"score\":1000,\"details\":{}}\n"),
        )
        .await;
        assert!(payload.has_usable());

        let result =
            resolve_payload("sub-654", &payload, "", "", None).expect("噪声行不得吞掉真结果");
        assert_eq!(result.score, 1000);
    }

    /// 经真实 `handle_eval_chunk` 的边界场景：噪声行本身是合法 JSON 但不是结果。
    #[tokio::test]
    async fn test_valid_json_noise_line_is_skipped_via_handle_eval_chunk() {
        let mut parser = LineParser::new();
        let mut payload = ResultPayload::new();
        let mut tracker = InFlightTracker::new(2000);

        feed(
            &mut parser,
            &mut payload,
            &mut tracker,
            stdout_chunk(
                "---RESULT---\n{\"warning\":\"deprecated API\"}\n{\"score\":6666,\"details\":{}}\n",
            ),
        )
        .await;

        let result = resolve_payload("sub-654b", &payload, "", "", None)
            .expect("合法 JSON 噪声不得被当作结果");
        assert_eq!(result.score, 6666);
    }

    /// 噪声行本身是合法 JSON 但不是结果：不得误取，须继续找到带 score 的候选。
    #[test]
    fn test_valid_json_noise_is_not_taken_as_result() {
        let mut payload = ResultPayload::new();
        payload.on_marker();
        payload.push_line("{\"warning\":\"deprecated API\"}");
        payload.push_line("{\"score\":1000,\"details\":{}}");

        assert!(payload.has_usable());
        let result = resolve_payload("sub-2", &payload, "", "", None).expect("应取到第二个候选");
        assert_eq!(result.score, 1000);
    }

    /// 只有合法 JSON 噪声、没有可评分候选：按 defect #29 判为非法评分（平台错误），
    /// 而不是把噪声 JSON 当成正式判定。
    #[test]
    fn test_json_without_score_anywhere_is_invalid_score_error() {
        let mut payload = ResultPayload::new();
        payload.on_marker();
        payload.push_line("{\"warning\":\"deprecated API\"}");
        payload.push_line("{\"cases\":[1,2,3]}");

        assert!(!payload.has_usable());
        let err =
            resolve_payload("sub-3", &payload, "", "", None).expect_err("无可评分候选必须报错");
        let public = err
            .downcast_ref::<crate::types::PublicJudgeError>()
            .expect("应沿用非法评分的平台错误类型");
        assert_eq!(public.0, super::super::result::MSG_INVALID_SCORE);
    }

    /// 全部候选都不可解析：错误里保留候选数量与片段（可诊断）。
    #[test]
    fn test_all_candidates_unparseable_reports_context() {
        let mut payload = ResultPayload::new();
        payload.on_marker();
        payload.push_line("warning: deprecated API");
        payload.push_line("another noise line");

        let err = resolve_payload("sub-4", &payload, "", "", None).expect_err("全部候选不可解析");
        let msg = err.to_string();
        assert!(msg.contains("已尝试 2 个候选"), "实际: {msg}");
        assert!(msg.contains("warning: deprecated API"), "实际: {msg}");
    }

    /// 候选数量有界：恶意 evaluator 刷屏不得无限累积。
    #[test]
    fn test_candidates_are_bounded() {
        let mut payload = ResultPayload::new();
        payload.on_marker();
        for i in 0..(MAX_RESULT_CANDIDATES * 4) {
            payload.push_line(&format!("noise-{i}"));
        }
        assert_eq!(payload.candidates_ordered().len(), MAX_RESULT_CANDIDATES);
    }

    /// 标记之前的行不得进入候选（否则诊断 JSON 会被误当结果）。
    #[test]
    fn test_lines_before_marker_are_not_candidates() {
        let mut payload = ResultPayload::new();
        payload.push_line("{\"score\":0,\"details\":{}}");
        assert!(!payload.has_candidates());

        payload.on_marker();
        payload.push_line("{\"score\":10000,\"details\":{}}");
        assert_eq!(payload.primary(), Some("{\"score\":10000,\"details\":{}}"));
        assert_eq!(payload.candidates_ordered().len(), 1);
    }

    /// 后出现的标记重置候选（保持既有语义）。
    #[test]
    fn test_second_marker_resets_candidates() {
        let mut payload = ResultPayload::new();
        payload.on_marker();
        payload.push_line("{\"score\":0,\"details\":{}}");
        payload.on_marker();
        payload.push_line("{\"score\":777,\"details\":{}}");

        let result =
            resolve_payload("sub-5", &payload, "", "", None).expect("取最后一段标记后的结果");
        assert_eq!(result.score, 777);
    }

    /// 超长候选按 append_capped 截断，不会无界增长。
    #[test]
    fn test_single_candidate_is_capped() {
        let mut payload = ResultPayload::new();
        payload.on_marker();
        let huge = "x".repeat(crate::dual::MAX_OUTPUT_BYTES + 4096);
        payload.push_line(&huge);
        assert_eq!(
            payload.primary().map(str::len),
            Some(crate::dual::MAX_OUTPUT_BYTES)
        );
    }

    /// 无候选时给出明确错误，而不是静默 0 分。
    #[test]
    fn test_no_candidates_is_error() {
        let mut payload = ResultPayload::new();
        payload.on_marker();
        payload.push_line("   ");
        assert!(!payload.has_candidates());
        assert!(resolve_payload("sub-6", &payload, "", "", None).is_err());
    }
}
