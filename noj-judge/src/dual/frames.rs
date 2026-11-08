//! 双容器编排的 exec 输出帧处理：解析 Evaluator/Solution NDJSON 输出并按协议转发。

use std::time::Instant;

use anyhow::Result;
use bollard::container::LogOutput;
use serde_json::Value;
use tracing::{debug, warn};

use super::config::append_capped;
use super::payload::ResultPayload;
use super::pipe::{forward_frame, PipeWriteOutcome};
use super::protocol::{
    frame_type, EvaluatorLine, LineParser, FRAME_CALL, FRAME_CAPABILITY, FRAME_CAP_REG,
    FRAME_ERROR, FRAME_LOG, FRAME_READY, FRAME_RESULT, FRAME_SHUTDOWN, RESULT_MARKER,
};
use super::tracker::InFlightTracker;

/// 取出 Evaluator 解析器缓冲区中的尾部残留并尝试提取 RESULT payload。
///
/// 用于 Evaluator EOF / 编排循环收尾：`---RESULT---` 之后的 payload 行可能**没有
/// 以换行结尾**（评测脚本直接退出，或 stdout 缓冲在退出时才 flush），此时该行仍
/// 留在 [`LineParser`] 的内部缓冲中，从未经过 `feed()` 切分。若不 drain 就结束编排，
/// 合法结果会因「已见标记但无 payload」被误判为 SystemError（提交丢分）。
///
/// 幂等：`drain_remaining()` 会清空缓冲，重复调用不再产生内容。
pub(crate) fn drain_eval_tail(
    parser: &mut LineParser,
    stdout_full: &mut String,
    result_payload: &mut ResultPayload,
) {
    for line in parser.drain_remaining() {
        if let EvaluatorLine::Unknown(s) = line {
            append_capped(stdout_full, &s);
            append_capped(stdout_full, "\n");
            // 仅在「已见标记」时吸收为候选（候选有界，见 ResultPayload）
            result_payload.push_line(&s);
        }
    }
}

/// 处理 Evaluator exec 的一个 chunk：解析 + 转发 call 帧 + 检测 RESULT 标记。
///
/// 返回 `Ok(true)` 表示 forwarding 方向（Solution stdin）仍可用；`Ok(false)`
/// 表示 Solution stdin 已死（写入超时/EPIPE），调用方应立即把 Solution 流标记为
/// 结束（VULN-16），不得继续尝试写入。真实错误仍为 `Err`。
#[allow(clippy::too_many_arguments)]
pub(crate) async fn handle_eval_chunk(
    parser: &mut LineParser,
    stderr_buf: &mut String,
    stdout_full: &mut String,
    sol_input: &mut std::pin::Pin<Box<dyn tokio::io::AsyncWrite + Send + Unpin>>,
    result_payload: &mut ResultPayload,
    tracker: &mut InFlightTracker,
    chunk: LogOutput,
) -> Result<bool> {
    let (data, is_err) = match chunk {
        LogOutput::StdOut { message } => (message, false),
        LogOutput::StdErr { message } => (message, true),
        _ => return Ok(true),
    };

    if is_err {
        let s = String::from_utf8_lossy(&data);
        append_capped(stderr_buf, &s);
        // Evaluator stderr 透传到日志（诊断用）
        debug!("[eval-stderr] {}", s);
        return Ok(true);
    }

    // stdout: feed 到 LineParser
    let lines = parser.feed(&data);
    for line in lines {
        match line {
            EvaluatorLine::ResultMarker => {
                // NOJ-160：标记进入「等待候选」状态，跨 chunk 保持。
                result_payload.on_marker();
                append_capped(stdout_full, RESULT_MARKER);
                append_capped(stdout_full, "\n");
            }
            EvaluatorLine::Frame(v) => {
                // 协议帧处理：
                // - call 帧：evaluator → solution 的函数调用，登记调用级超时后原样转发
                // - cap_reg 帧：judge 与 evaluator 的私有协议（capability 默认超时上报），不转发
                // - result/error 帧：capability 调用的响应（solution 等待），按 id 命中判定转发
                // 其他类型（log 等）记录但不转发
                match frame_type(&v) {
                    Some(FRAME_CALL) => {
                        // 登记调用级超时（缺省回退题目级默认），原样转发
                        tracker.on_call_frame(&v, Instant::now());
                        if forward_frame(sol_input, &v).await? == PipeWriteOutcome::PeerGone {
                            return Ok(false);
                        }
                    }
                    Some(FRAME_CAP_REG) => {
                        // judge 侧私有协议：更新 capability 超时映射，不转发给 solution
                        tracker.on_cap_reg_frame(&v);
                        debug!("cap_reg 帧已记录（不转发）: {}", v);
                    }
                    Some(FRAME_RESULT) | Some(FRAME_ERROR) => {
                        // capability 响应帧：命中则转发给 solution，迟到/未知丢弃
                        if let Some(id) = v.get("id").and_then(Value::as_str) {
                            if tracker.resolve_response(id) {
                                if forward_frame(sol_input, &v).await? == PipeWriteOutcome::PeerGone
                                {
                                    return Ok(false);
                                }
                            } else {
                                warn!("丢弃迟到的 evaluator 响应帧（id={}）", id);
                            }
                        }
                    }
                    // log：合法帧，judge 收集但不转发（保持既有语义）
                    Some(FRAME_LOG) => {}
                    // 未知/非法 type：按协议记录 warn 并丢弃
                    _ => {
                        warn!("丢弃未知 type 的 evaluator 帧: {}", v);
                    }
                }
                // 记录所有帧到 stdout 全文（供结果展示）
                let s = v.to_string();
                append_capped(stdout_full, &s);
                append_capped(stdout_full, "\n");
            }
            EvaluatorLine::Unknown(s) => {
                // 普通 evaluate.py 输出，丢弃
                append_capped(stdout_full, &s);
                append_capped(stdout_full, "\n");
                // Issue #654：标记后的非空行**全部**作为候选保留（有界），
                // 由解析阶段依次尝试；只留首行会让噪声行吞掉真结果。
                result_payload.push_line(&s);
            }
        }
    }
    Ok(true)
}

/// 处理 Solution exec 的一个 chunk：转发 NDJSON 帧到 evaluator stdin。
///
/// 返回 `Ok(true)` 表示 Evaluator stdin 仍可用；`Ok(false)` 表示 Evaluator stdin
/// 已死（写入超时/EPIPE），调用方应立即按协议转入异常收尾（VULN-16）。
pub(crate) async fn handle_sol_chunk(
    parser: &mut LineParser,
    eval_input: &mut std::pin::Pin<Box<dyn tokio::io::AsyncWrite + Send + Unpin>>,
    chunk: LogOutput,
    solution_ready: &mut bool,
    tracker: &mut InFlightTracker,
) -> Result<bool> {
    let data = match chunk {
        LogOutput::StdOut { message } => message,
        LogOutput::StdErr { message } => {
            // Solution stderr 透传到日志（诊断用）
            let s = String::from_utf8_lossy(&message);
            debug!("[sol-stderr] {}", s);
            return Ok(true);
        }
        _ => return Ok(true),
    };

    let lines = parser.feed(&data);
    for line in lines {
        if let EvaluatorLine::Frame(v) = line {
            // ready 之前只接受 ready 帧，其余忽略（防御）
            if !*solution_ready {
                if frame_type(&v) == Some(FRAME_READY) {
                    *solution_ready = true;
                }
                continue;
            }
            match frame_type(&v) {
                Some(FRAME_CAPABILITY) => {
                    // solution 请求 capability：查注册超时登记后转发 evaluator
                    tracker.on_capability_frame(&v, Instant::now());
                    if forward_frame(eval_input, &v).await? == PipeWriteOutcome::PeerGone {
                        return Ok(false);
                    }
                }
                Some(FRAME_RESULT) | Some(FRAME_ERROR) => {
                    // call 响应帧（evaluator 等待）：命中则转发，迟到/未知丢弃
                    if let Some(id) = v.get("id").and_then(Value::as_str) {
                        if tracker.resolve_response(id) {
                            if forward_frame(eval_input, &v).await? == PipeWriteOutcome::PeerGone {
                                return Ok(false);
                            }
                        } else {
                            warn!("丢弃迟到的 solution 响应帧（id={}）", id);
                        }
                    }
                }
                // log / shutdown 等合法帧：保持既有转发语义（solution → evaluator）
                Some(FRAME_LOG) | Some(FRAME_SHUTDOWN) => {
                    if forward_frame(eval_input, &v).await? == PipeWriteOutcome::PeerGone {
                        return Ok(false);
                    }
                }
                // 未知/非法 type：按协议记录 warn 并丢弃
                _ => {
                    warn!("丢弃未知 type 的 solution 帧: {}", v);
                }
            }
        }
    }
    Ok(true)
}
