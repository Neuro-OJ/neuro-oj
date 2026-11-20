//! evaluator `---RESULT---` 结果的构造与评分合法性校验（defect #29）。
//!
//! 从 `dual/mod.rs` 拆出：`dual/mod.rs` 受单文件规模棘轮（`scripts/check-file-size.ts`，
//! 阈值 1200 行）约束，评分校验与结果封套构造是独立可测的一段逻辑。

use crate::types::{JudgeResult, PublicJudgeError};
use serde_json::Value;

/// 合法评分上限：`score` 为百分制 ×100（100 分 = 10000，与 core `sanitizeJudgeResult` 一致）。
pub(crate) const MAX_SCORE: i64 = 10_000;

/// evaluator 输出非法评分时回传给提交详情页的公开文案（defect #29）。
///
/// 非法评分属于**平台错误**：绝不能 `unwrap_or(0)` 退化成零分、也不能 clamp 成
/// 边界分数变成正式判定，否则会覆盖提交已有的正式成绩。
pub(crate) const MSG_INVALID_SCORE: &str =
    "评测结果缺少合法的整数评分（0~10000），本次评测记为平台错误并保留已有成绩，请联系管理员检查评测脚本";

/// 非法评分的平台错误：`Display` 带可诊断细节（只写日志），
/// [`JudgeResult::from_error`] 只回传 [`MSG_INVALID_SCORE`] 固定公开文案。
fn invalid_score_error(submission_id: &str, reason: &str) -> anyhow::Error {
    PublicJudgeError(MSG_INVALID_SCORE)
        .with_detail(format!("submission {}: {}", submission_id, reason))
}

/// 描述非法 `score` 的 JSON 类型（日志用；不回显原始值，避免超长/敏感内容入日志）。
fn score_type_name(value: &Value) -> &'static str {
    match value {
        Value::Null => "null",
        Value::Bool(_) => "布尔",
        Value::Number(n) if n.is_f64() => "浮点数",
        Value::Number(_) => "整数",
        Value::String(_) => "字符串",
        Value::Array(_) => "数组",
        Value::Object(_) => "对象",
    }
}

/// 把 `score` 收窄为整数值：JSON 整数，或数值上为整数的浮点。
///
/// 与 core `isValidGradedScore`（`Number.isInteger(value)`）**逐语义对齐**：
/// JSON 的 `800.0` 在 JS 侧就是一个 number 且 `Number.isInteger(800.0) === true`，
/// 而 serde_json 会区分 int/float。若不接受整数值浮点，judge 会比 core 更严，
/// 把 core 本可正常落库的评分误判为平台错误。
fn as_integral_score(value: &Value) -> Option<i64> {
    if let Some(n) = value.as_i64() {
        return Some(n);
    }
    let f = value.as_f64()?;
    if !f.is_finite() || f.fract() != 0.0 {
        return None;
    }
    // 越界值交给统一的 0..=MAX_SCORE 范围检查（`as i64` 饱和转换，不会 UB）
    Some(f as i64)
}

/// 校验 `---RESULT---` payload 并返回 `(结果对象, 评分)`。
///
/// 要求顶层是 JSON 对象，且 `score` 是 `0..=MAX_SCORE` 的整数（官方 SDK 输出
/// `int(round(score * 100))`）。缺失、字符串、非整数浮点、布尔、越界一律返回平台
/// 错误（[`MSG_INVALID_SCORE`]），**不做** `unwrap_or(0)` 兜底、**不做** clamp。
fn parse_result_object<'a>(
    submission_id: &str,
    parsed: &'a Value,
) -> anyhow::Result<(&'a serde_json::Map<String, Value>, i32)> {
    let object = parsed
        .as_object()
        .ok_or_else(|| invalid_score_error(submission_id, "---RESULT--- payload 不是 JSON 对象"))?;

    let score = match object.get("score") {
        None => {
            return Err(invalid_score_error(
                submission_id,
                "结果 JSON 缺少 score 字段",
            ))
        }
        Some(value) => match as_integral_score(value) {
            Some(n) if (0..=MAX_SCORE).contains(&n) => n as i32,
            Some(n) => {
                return Err(invalid_score_error(
                    submission_id,
                    &format!("score 越界（合法范围 0~{}，实际 {}）", MAX_SCORE, n),
                ))
            }
            None => {
                return Err(invalid_score_error(
                    submission_id,
                    &format!("score 不是整数（实际类型: {}）", score_type_name(value)),
                ))
            }
        },
    };

    Ok((object, score))
}

/// 构造正式评测结果（defect #29）。
///
/// 评分校验是**强制**的：`---RESULT---` 的 payload 必须是 JSON 对象，且 `score`
/// 必须是 `0..=MAX_SCORE` 的整数值（官方 SDK 输出 `int(round(score * 100))`）。
/// 缺失、字符串、非整数浮点、布尔、越界评分一律返回平台错误（[`MSG_INVALID_SCORE`]），
/// 由 main 的失败路径落成 `platform_error` 封套，而不是退化成零分/边界分的正式
/// 判定去覆盖已有成绩。
///
/// `status` 说明：新协议下 `evaluate.py` 不再输出 `status`，因此**评分合法**时
/// 缺省 `finished` 是协议要求的行为；只有旧协议残留的明确错误状态才映射为
/// `error`。非法评分在任何状态下都不会变成 `graded`。
pub(crate) fn build_judge_result(
    submission_id: &str,
    parsed: &Value,
    stderr: &str,
    stdout: &str,
    rejudge_seq: Option<i64>,
) -> anyhow::Result<JudgeResult> {
    let full_output = crate::merge_output(stdout, stderr);
    let (object, score) = parse_result_object(submission_id, parsed)?;

    // evaluate.py 结果 JSON 不再输出 status；即使携带旧 status 也统一映射为
    // finished / error，分数是唯一结果。
    let raw_status = object.get("status").and_then(Value::as_str);
    let status = match raw_status {
        Some(
            "error" | "SystemError" | "TimeLimitExceeded" | "MemoryLimitExceeded" | "RuntimeError",
        ) => "error",
        _ => "finished",
    }
    .to_string();
    let details = object.get("details").cloned().unwrap_or(Value::Null);

    Ok(JudgeResult {
        submission_id: submission_id.to_string(),
        status,
        score,
        output: full_output,
        details,
        time_ms: None,
        memory_kb: None,
        // NOJ-161：成功路径必须透传任务 rejudge_seq。
        rejudge_seq,
        task_kind: None,
        // 版本化封套由 main.rs 在状态最终确定后统一补齐（apply_protocol）。
        run_id: None,
        self_test_run_id: None,
        attempt_id: None,
        problem_version_id: None,
        evaluation_protocol_version: None,
        result_kind: None,
    })
}
