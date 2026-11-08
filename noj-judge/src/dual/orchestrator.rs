//! 双容器评测编排：evaluate_dual_with_cpu_limit 入口与 run_dual_loop 主循环。

use std::path::Path;
use std::time::{Duration, Instant};

use anyhow::{Context, Result};
use futures_util::StreamExt;
use tracing::{error, info, warn};

use crate::dual::container::{start_exec, DualContainer, ExecSession};
use crate::dual::protocol::LineParser;
use crate::dual::tracker::{InFlightTracker, WaitingSide};
use crate::sandbox::container::{inject_file_to_container, parse_command};
use crate::types::{JudgeResult, JudgeStatus, JudgeTaskLlm, RuntimeConfig};

use super::config::{
    clamp_runtime_config, inject_support_package_to_evaluator, read_container_memory_peak_kb,
    require_solution, validate_runtime_config,
};
use super::frames::{drain_eval_tail, handle_eval_chunk, handle_sol_chunk};
use super::payload::{self, ResultPayload};
use super::pipe::{write_timeout_frame, PipeWriteOutcome};
use super::SOLUTION_ENTRY_FILE;

/// 双容器评测入口，允许通过 Worker 配置传入每个容器的 CPU 上限。
///
/// `instance_id`：由 `Config::instance_id` 显式注入的确定性实例 ID
/// （`noj-{hash12}`），用于容器实例标签与启动清扫（VULN-15）。
#[allow(clippy::too_many_arguments)]
pub async fn evaluate_dual_with_cpu_limit(
    docker: bollard::Docker,
    task_submission_id: &str,
    runtime_config: &RuntimeConfig,
    user_code: &str,
    support_pkg_path: Option<&Path>,
    artifact_zip_path: Option<&Path>,
    task_rejudge_seq: Option<i64>,
    task_llm: Option<&JudgeTaskLlm>,
    cpu_limit_millicores: u64,
    allow_evaluator_network: bool,
    evaluator_network_mode: &str,
    image_prefix: &str,
    command_whitelist: &[String],
    max_evaluator_time_ms: u64,
    max_solution_call_timeout_ms: u64,
    instance_id: &str,
) -> Result<JudgeResult> {
    let runtime_config = clamp_runtime_config(
        runtime_config,
        max_evaluator_time_ms,
        max_solution_call_timeout_ms,
    );
    validate_runtime_config(
        task_submission_id,
        &runtime_config,
        allow_evaluator_network,
        image_prefix,
        command_whitelist,
    )?;
    // prediction 提交（无 Solution）走 `crate::prediction` 独立编排，不应进入本函数。
    let solution = require_solution(task_submission_id, &runtime_config)?;
    let started = Instant::now();
    // F-08：启动期 30s 绝对时限从注入/容器准备阶段开始计时（注入耗时计入启动期）。
    let startup_deadline = Instant::now() + Duration::from_secs(30);
    let evaluator_cmd = parse_command(&runtime_config.evaluator.command);

    // 1. 创建 Evaluator 容器
    let evaluator_network_enabled = runtime_config
        .evaluator
        .network
        .as_ref()
        .map(|n| n.enabled)
        .unwrap_or(false);
    let network_mode = if evaluator_network_enabled {
        evaluator_network_mode
    } else {
        "none"
    };
    let mut dual = DualContainer::create_evaluator(
        &docker,
        &runtime_config.evaluator.image,
        runtime_config.evaluator.memory_limit_mb,
        network_mode,
        cpu_limit_millicores,
        instance_id,
    )
    .await
    .context("创建 Evaluator 容器失败")?;

    // 2. 创建 Solution 容器
    dual.create_solution(
        &solution.image,
        solution.memory_limit_mb,
        cpu_limit_millicores,
    )
    .await
    .context("创建 Solution 容器失败")?;

    // `create_evaluator` / `create_solution` 成功返回时必然已写入容器 ID，
    // `ok_or_else` 只是不可达的兜底；保留其为错误返回而非 panic。
    let evaluator_id = dual
        .evaluator_id
        .clone()
        .ok_or_else(|| anyhow::anyhow!("Evaluator 容器 ID 缺失"))?;
    let solution_id = dual
        .solution_id
        .clone()
        .ok_or_else(|| anyhow::anyhow!("Solution 容器 ID 缺失"))?;

    // VULN-15（Drain 优雅退出）：容器创建之后的**全部**步骤都放在这个内部 async 块里，
    // 使任何提前返回（注入失败 / 启动 exec 失败 / 编排错误）都会走到下面显式的
    // `dual.destroy().await`。否则 `?` 提前返回会触发 `DualContainer::drop`，而 Drop
    // 里的 `tokio::spawn` 在 drain 阶段会被运行时就绪销毁强杀 → 孤儿容器残留。
    let evaluation = async {
        // 3. 注入支持包到 Evaluator 容器（evaluate.py 等评测脚本）
        if let Some(pkg_path) = support_pkg_path {
            info!("注入支持包到 Evaluator 容器: {:?}", pkg_path);
            inject_support_package_to_evaluator(&docker, &evaluator_id, pkg_path)
                .await
                .context("注入支持包到 Evaluator 容器失败")?;
        } else {
            info!("无支持包，跳过注入");
        }

        // 4. 注入用户代码/artifact 到 Solution 容器
        let solution_entry_file = if artifact_zip_path.is_some() {
            "submission.py"
        } else {
            SOLUTION_ENTRY_FILE
        };
        if let Some(artifact_path) = artifact_zip_path {
            info!("注入 artifact zip 到 Solution 容器: {:?}", artifact_path);
            inject_support_package_to_evaluator(&docker, &solution_id, artifact_path)
                .await
                .context("注入 artifact zip 到 Solution 容器失败")?;
        } else {
            inject_file_to_container(
                &docker,
                &solution_id,
                SOLUTION_ENTRY_FILE,
                user_code.as_bytes(),
            )
            .await
            .context("注入用户代码到 Solution 容器失败")?;
        }

        // 5. 构造 Evaluator 环境变量（LLM 任务注入 gateway 地址、eval_token 与提交标识）
        let evaluator_env = task_llm
            .map(|llm| {
                crate::dual::llm_env::build_llm_env(llm, task_submission_id, task_rejudge_seq)
            })
            .unwrap_or_default();

        // 6. 启动 Evaluator exec
        let evaluator_exec = start_exec(&docker, &evaluator_id, evaluator_cmd, evaluator_env)
            .await
            .context("启动 Evaluator exec 失败")?;

        // 7. 启动 Solution exec（Solution 容器不注入任何 NOJ_LLM_* 环境变量）
        let solution_entry_path = format!("/workspace/{}", solution_entry_file);
        let solution_exec = start_exec(
            &docker,
            &solution_id,
            vec![
                "python3".to_string(),
                "-m".to_string(),
                "noj_solution_sdk.host".to_string(),
                "--entry".to_string(),
                solution_entry_path,
            ],
            vec![],
        )
        .await
        .context("启动 Solution exec 失败")?;

        // 8. 运行主循环
        let result = run_dual_loop(
            task_submission_id,
            evaluator_exec,
            solution_exec,
            runtime_config.evaluator.time_limit_ms,
            solution.call_timeout_ms,
            max_solution_call_timeout_ms,
            task_rejudge_seq,
            startup_deadline,
        )
        .await;

        // NOJ-162：销毁前读取 Solution 容器内存峰值（仅尽力而为，失败不影响结果）
        let memory_peak_kb = read_container_memory_peak_kb(&docker, &solution_id).await;
        if let Some(kb) = memory_peak_kb {
            info!(
                submission_id = task_submission_id,
                memory_kb = kb,
                "Solution 容器内存峰值已读取"
            );
        }

        Ok::<_, anyhow::Error>((result, memory_peak_kb))
    }
    .await;

    // 9. 显式 await 销毁（不论成功失败）——正常路径绝不依赖 Drop 的托管的 spawn。
    if let Err(e) = dual.destroy().await {
        warn!("DualContainer 销毁警告: {}", e);
    }

    let (result, memory_peak_kb) = evaluation?;

    // NOJ-162：回填真实总耗时与内存峰值
    let mut result = result?;
    if result.time_ms.is_none() {
        result.time_ms = Some(started.elapsed().as_millis() as u64);
    }
    if result.memory_kb.is_none() {
        result.memory_kb = memory_peak_kb;
    }
    Ok(result)
}

/// 超时种类：判定最终状态时区分启动期与正式评测期。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum TimeoutKind {
    /// 阶段 1：评测程序启动等待超时（容器创建 / 文件注入 / 运行时启动开销）
    Startup,
    /// 阶段 2：evaluator 整体执行超过 time_limit_ms
    Total,
}

/// 评测收尾判定：把「评测如何结束」映射为最终状态。
///
/// 仅在 evaluator 未正常输出 ---RESULT--- 时调用（有 RESULT 走 build_judge_result）。
/// 规则（顺序即优先级，决策 5 / AR-07）：
/// 1. 启动等待超时（Startup）→ SystemError：容器拉取/注入/运行时环境异常，平台侧故障；
/// 2. 总执行超时（Total）或曾向 evaluator 发送过 CallTimeout 错误帧 → TimeLimitExceeded：做题人代码慢/超时；
/// 3. 否则 → SystemError：evaluator 自身异常。
pub(crate) fn finalize_outcome(
    timed_out: Option<TimeoutKind>,
    sent_call_timeout: bool,
) -> JudgeStatus {
    if let Some(kind) = timed_out {
        match kind {
            TimeoutKind::Startup => return JudgeStatus::SystemError,
            TimeoutKind::Total => return JudgeStatus::TimeLimitExceeded,
        }
    }
    if sent_call_timeout {
        return JudgeStatus::TimeLimitExceeded;
    }
    JudgeStatus::SystemError
}

/// 主循环：双向 NDJSON 转发 + 解析 Evaluator 输出。
/// 等待下一个调用级超时到期（无 in-flight 调用时永久等待）。
async fn next_call_timeout(tracker: &InFlightTracker) {
    match tracker.next_deadline() {
        Some(d) => tokio::time::sleep_until(d.into()).await,
        None => std::future::pending::<()>().await,
    }
}

/// 处理调用级超时到期：向等待方（Evaluator/Solution）写 timeout 帧。
///
/// 返回 `(evaluator_stdin, solution_stdin)` 两个方向的写入结果（VULN-16）：
/// [`PipeWriteOutcome::PeerGone`] 表示该方向对端 stdin 已死，调用方应结束对应流。
async fn expire_call_timeouts(
    tracker: &mut InFlightTracker,
    eval_input: &mut std::pin::Pin<Box<dyn tokio::io::AsyncWrite + Send + Unpin>>,
    sol_input: &mut std::pin::Pin<Box<dyn tokio::io::AsyncWrite + Send + Unpin>>,
    sent_call_timeout: &mut bool,
) -> Result<(PipeWriteOutcome, PipeWriteOutcome)> {
    let mut eval_outcome = PipeWriteOutcome::Written;
    let mut sol_outcome = PipeWriteOutcome::Written;
    for (id, side) in tracker.expire_now(Instant::now()) {
        match side {
            WaitingSide::Evaluator => {
                let outcome = write_timeout_frame(eval_input, &id).await?;
                if outcome == PipeWriteOutcome::PeerGone {
                    eval_outcome = PipeWriteOutcome::PeerGone;
                }
                *sent_call_timeout = true;
            }
            WaitingSide::Solution => {
                let outcome = write_timeout_frame(sol_input, &id).await?;
                if outcome == PipeWriteOutcome::PeerGone {
                    sol_outcome = PipeWriteOutcome::PeerGone;
                }
            }
        }
    }
    Ok((eval_outcome, sol_outcome))
}

/// 超时收尾：按 finalize_outcome 判定结果（TLE 或 SystemError）。
/// `kind` 区分启动超时（Startup）与评测总超时（Total），语义上两者归因相同。
fn timeout_result(
    submission_id: &str,
    rejudge_seq: Option<i64>,
    sent_call_timeout: bool,
    kind: TimeoutKind,
    message: &str,
) -> JudgeResult {
    match finalize_outcome(Some(kind), sent_call_timeout) {
        JudgeStatus::TimeLimitExceeded => JudgeResult::timeout(submission_id, message, rejudge_seq),
        _ => JudgeResult::system_error(submission_id, message, rejudge_seq),
    }
}

#[allow(clippy::too_many_arguments)]
async fn run_dual_loop(
    submission_id: &str,
    evaluator_exec: ExecSession,
    solution_exec: ExecSession,
    evaluator_timeout_ms: u64,
    default_call_timeout_ms: u64,
    max_call_timeout_ms: u64,
    rejudge_seq: Option<i64>,
    startup_deadline: Instant,
) -> Result<JudgeResult> {
    // 解构 exec 拿到 output/input
    let ExecSession {
        output: mut eval_output,
        input: mut eval_input,
        ..
    } = evaluator_exec;
    let ExecSession {
        output: mut sol_output,
        input: mut sol_input,
        ..
    } = solution_exec;

    let mut eval_parser = LineParser::new();
    let mut eval_stderr_buf = String::new();
    let mut eval_stdout_full = String::new();

    let mut sol_parser = LineParser::new();
    let mut solution_ready = false;

    let mut result_payload = ResultPayload::new();

    // 调用级超时追踪器（题目级 call_timeout_ms 作为缺省回退值；
    // evaluator 帧里的 timeout_ms 受 judge 硬上限截断，防止绕过 clamp 挂住评测）
    let mut tracker = InFlightTracker::new(default_call_timeout_ms, max_call_timeout_ms);

    // 是否向 evaluator 发送过 CallTimeout 错误帧（solution 调用超时）。
    // 仅 WaitingSide::Evaluator（evaluator 等 solution 的 call）置位；
    // WaitingSide::Solution（capability 反向调用超时）不置位——其错误帧写给 solution，
    // 不构成「evaluator 未处理 CallTimeout」归因。
    let mut sent_call_timeout = false;

    // Solution 流是否已结束。结束后禁用 select 中的 Solution 分支，
    // 但继续消费 Evaluator 输出（见下方修复说明），避免丢失 RESULT payload。
    // VULN-16：Solution stdin 已死（写入超时/EPIPE）时也会置位。
    let mut solution_done = false;

    // Evaluator 流是否已结束（EOF / 流错误 / stdin 已死）。结束后禁用 Evaluator 分支，
    // 避免对已耗尽的流反复 poll（select 会立即就绪导致忙循环）。
    let mut evaluator_done = false;

    // 阶段 1：等待评测程序真正开始运行（收到首条输出，通常为 ready 帧）。
    // F-08：启动期 30s 绝对时限从注入/容器准备阶段开始计时，
    // 因此这里按剩余时间生成 sleep，注入耗时不再“重置”启动超时。
    let startup_remaining = startup_deadline.saturating_duration_since(Instant::now());
    let startup_deadline = tokio::time::sleep(startup_remaining);
    tokio::pin!(startup_deadline);

    let mut evaluator_started = false;
    while !evaluator_started {
        tokio::select! {
            _ = &mut startup_deadline => {
                warn!("Evaluator 启动超时（30s）: {}", submission_id);
                return Ok(timeout_result(
                    submission_id,
                    rejudge_seq,
                    sent_call_timeout,
                    TimeoutKind::Startup,
                    "Evaluator 启动超时",
                ));
            }
            // 调用级超时（in-flight 到期）
            _ = next_call_timeout(&tracker) => {
                let (eval_pipe, sol_pipe) = expire_call_timeouts(
                    &mut tracker,
                    &mut eval_input,
                    &mut sol_input,
                    &mut sent_call_timeout,
                )
                .await?;
                // VULN-16：Evaluator stdin 已死 → 立即异常收尾，不空转到启动超时。
                if eval_pipe == PipeWriteOutcome::PeerGone {
                    warn!("Evaluator stdin 已关闭，启动阶段异常收尾: {}", submission_id);
                    return Ok(JudgeResult::system_error(
                        submission_id,
                        "Evaluator stdin 已关闭（写入超时或 EPIPE）",
                        rejudge_seq,
                    ));
                }
                if sol_pipe == PipeWriteOutcome::PeerGone {
                    solution_done = true;
                }
            }
            chunk = eval_output.next() => {
                let chunk = match chunk {
                    Some(Ok(c)) => c,
                    Some(Err(e)) => {
                        error!("Evaluator exec 流错误: {}", e);
                        return Ok(JudgeResult::system_error(
                            submission_id,
                            &format!("Evaluator 启动失败: {}", e),
                            rejudge_seq,
                        ));
                    }
                    None => {
                        // 评测程序未输出任何内容即退出
                        return Ok(JudgeResult::system_error(
                            submission_id,
                            "Evaluator 未启动（无输出即退出）",
                            rejudge_seq,
                        ));
                    }
                };
                // VULN-16：启动阶段若 Solution stdin 已死，立刻标记该流结束
                // （阶段 2 不再向它写帧，避免每帧都等满 3s 超时）。
                let solution_pipe_ok = handle_eval_chunk(
                    &mut eval_parser,
                    &mut eval_stderr_buf,
                    &mut eval_stdout_full,
                    &mut sol_input,
                    &mut result_payload,
                    &mut tracker,
                    chunk,
                )
                .await?;
                if !solution_pipe_ok {
                    warn!("Solution stdin 已关闭（启动阶段），终止该方向转发");
                    solution_done = true;
                }
                if result_payload.has_usable() {
                    break;
                }
                evaluator_started = true;
            }
            else => break,
        }
    }

    // 阶段 2：正式评测——总超时从评测程序开始运行起算（题目 time_limit_ms）。
    //
    // 修复（D0）：守卫条件必须是「结果**尚未完整取得**」，而不只是「未见标记」。
    // 阶段 1 是 `while !evaluator_started` 循环：一旦收到首条输出
    // （例如只有 `---RESULT---` 标记的那一个 chunk）就会正常退出循环，此时已见
    // 标记但候选 payload 仍为空。若此处只看「是否已见标记」，阶段 2 会被整体跳过，
    // payload 永远不被读取 —— 随后尾部逻辑判定「已见标记但无 payload」，把合法
    // 评测结果误判为 SystemError（提交丢分）。
    //
    // Issue #654：退出条件从「已捕获任意非空行」改为「已捕获**可解析且含 score**
    // 的候选」。否则「标记 → 噪声行 → 真 JSON」会在噪声行处提前收尾，真结果
    // 永远读不到。
    //
    // 该缺陷表现为时序相关的偶发失败：标记与 payload 落在**同一个** chunk 时
    // （一次 handle_eval_chunk 内连续处理两行）恰好正常；分成两个 chunk 到达
    // （评测脚本先 flush 标记、稍后再写 payload）则必然丢结果。
    if !result_payload.has_usable() {
        let deadline = tokio::time::sleep(Duration::from_millis(evaluator_timeout_ms));
        tokio::pin!(deadline);

        'outer: loop {
            // 退出条件 1（首选）：结果 payload 已完整取得 → 立即收尾。
            //
            // 必须优先于下面的「Evaluator 流结束」条件：Solution 容器承载的是常驻
            // host 进程，它只在收到 `shutdown` 帧或 **stdin EOF** 时退出，而编排
            // 循环全程持有 `sol_input` 从不关闭、也从不向它发 shutdown 帧。因此
            // Solution 的 EOF 在生产中基本不会出现；若等它结束才收尾，必然拖到
            // 总超时（表现为 status=error「Evaluator 总超时」，而结果其实早已拿到）。
            if result_payload.has_usable() {
                break 'outer;
            }

            // 退出条件 2：Evaluator 流已结束 → 立即收尾。
            //
            // Evaluator 是 RESULT 的唯一来源：它的 stdout 一旦关闭（EOF 或流错误），
            // payload 不可能再补全，继续等待没有意义。先 drain 尾部残留（payload
            // 可能没有以换行结尾而留在解析器缓冲里），再退出。
            //
            // 修复（评审）：此前这里是 `evaluator_done && solution_done`。由于上述
            // 原因 `solution_done` 在生产中不可达，该条件实际永不成立 —— 当评测器
            // **不带 RESULT 标记**结束（崩溃、`sys.exit(1)`、被 OOM kill）时，循环会
            // 空转到 `evaluator_time_limit_ms` 才由 deadline 收尾。判定结果不受影响
            // （两条路径最终都是 error），但会白占评测槽位并拉长失败延迟。
            // 阶段 2 重构前这里是「Evaluator EOF 即 break」，本次恢复该快速失败语义。
            if evaluator_done {
                drain_eval_tail(&mut eval_parser, &mut eval_stdout_full, &mut result_payload);
                break 'outer;
            }

            tokio::select! {
                // 总超时
                _ = &mut deadline => {
                    warn!("Evaluator 总超时: {}", submission_id);
                    return Ok(timeout_result(
                        submission_id,
                        rejudge_seq,
                        sent_call_timeout,
                        TimeoutKind::Total,
                        "Evaluator 总超时",
                    ));
                }

                // 调用级超时（in-flight 到期）
                _ = next_call_timeout(&tracker) => {
                    let (eval_pipe, sol_pipe) = expire_call_timeouts(
                        &mut tracker,
                        &mut eval_input,
                        &mut sol_input,
                        &mut sent_call_timeout,
                    )
                    .await?;
                    // VULN-16：超时帧写不进去 = 对端 stdin 已死。
                    // Evaluator stdin 死 → 立即异常收尾；Solution stdin 死 → 结束其流。
                    if eval_pipe == PipeWriteOutcome::PeerGone {
                        warn!("Evaluator stdin 已关闭，异常收尾: {}", submission_id);
                        drain_eval_tail(
                            &mut eval_parser,
                            &mut eval_stdout_full,
                            &mut result_payload,
                        );
                        evaluator_done = true;
                    }
                    if sol_pipe == PipeWriteOutcome::PeerGone {
                        solution_done = true;
                    }
                }

                // Evaluator stdout/stderr
                chunk = eval_output.next(), if !evaluator_done => {
                    let chunk = match chunk {
                        Some(Ok(c)) => c,
                        Some(Err(e)) => {
                            error!("Evaluator exec 流错误: {}", e);
                            evaluator_done = true;
                            continue;
                        }
                        None => {
                            // 修复（D0）：Evaluator EOF 时**先 drain 解析器缓冲**再退出。
                            // payload 行可能没有以换行结尾（EOF 残留），此时它仍在
                            // eval_parser.buf 中；直接 break 会丢弃它，把合法结果误判为
                            // SystemError（提交丢分）。drain_remaining() 将其作为最后
                            // 一行交回，交由下方统一的 payload 提取逻辑处理。
                            drain_eval_tail(
                                &mut eval_parser,
                                &mut eval_stdout_full,
                                &mut result_payload,
                            );
                            evaluator_done = true;
                            continue;
                        }
                    };
                    // VULN-16：Solution stdin 已死（写入超时/EPIPE）→ 该流结束，
                    // 后续帧不再尝试投递（避免每帧都等满 3s 超时）。
                    if !handle_eval_chunk(
                        &mut eval_parser,
                        &mut eval_stderr_buf,
                        &mut eval_stdout_full,
                        &mut sol_input,
                        &mut result_payload,
                        &mut tracker,
                        chunk,
                    )
                    .await?
                    {
                        solution_done = true;
                    }
                    if result_payload.has_usable() {
                        break 'outer;
                    }
                }

                // Solution stdout/stderr
                //
                // 修复（D0）：Solution 流结束**不代表**评测结束。
                // Evaluator 可能仍有在途/待 flush 输出——典型场景是 evaluate.py
                // 先写 `---RESULT---`（若 stdout 为行缓冲则立即下发），payload 行
                // 则要等进程退出时才 flush。此前在此处直接 `break 'outer` 会抛弃
                // Evaluator 的剩余输出，导致 payload 丢失 → 合法结果被误判为
                // SystemError（提交丢分），且表现为时序相关的偶发失败。
                //
                // 现在只把 Solution 标记为已结束并禁用该分支，继续等待 Evaluator
                // 输出，直到其 EOF、payload 完整，或总超时兜底（不会无限挂起）。
                chunk = sol_output.next(), if !solution_done => {
                    match chunk {
                        Some(Ok(c)) => {
                            // VULN-16：Evaluator stdin 已死 → 按协议转入异常收尾
                            // （置 evaluator_done，由循环顶部 drain + 结束）。
                            if !handle_sol_chunk(
                                &mut sol_parser,
                                &mut eval_input,
                                c,
                                &mut solution_ready,
                                &mut tracker,
                            )
                            .await?
                            {
                                warn!(
                                    "Evaluator stdin 已关闭，停止转发 solution 帧: {}",
                                    submission_id
                                );
                                evaluator_done = true;
                            }
                        }
                        Some(Err(e)) => {
                            error!("Solution exec 流错误: {}", e);
                            solution_done = true;
                        }
                        None => {
                            solution_done = true;
                        }
                    }
                }

                else => {
                    // 安全网：所有分支同时不可用时的兜底退出（正常路径由循环顶部的
                    // 「payload 完整」/「evaluator_done」两个判定处理）。
                    drain_eval_tail(
                        &mut eval_parser,
                        &mut eval_stdout_full,
                        &mut result_payload,
                    );
                    break 'outer;
                }
            }
        }
    }

    // 解析最终结果：标记后的候选按出现顺序逐个尝试，取第一个「合法 JSON 且含
    // score」的行（Issue #654：噪声行不得让整次评测变成 platform_error）。
    if result_payload.has_candidates() {
        return payload::resolve_payload(
            submission_id,
            &result_payload,
            &eval_stderr_buf,
            &eval_stdout_full,
            rejudge_seq,
        );
    }

    // 已见 RESULT 标记但 payload 行未以换行结束（EOF 残留）时，
    // 把 drain 出的最后一行当作候选，避免把合法结果误判为 SystemError。
    // （幂等：循环内的 drain 已执行过时，此处不再产生内容。）
    drain_eval_tail(&mut eval_parser, &mut eval_stdout_full, &mut result_payload);

    if result_payload.has_candidates() {
        return payload::resolve_payload(
            submission_id,
            &result_payload,
            &eval_stderr_buf,
            &eval_stdout_full,
            rejudge_seq,
        );
    }

    // 未拿到 RESULT 标记
    warn!("Evaluator 未输出 ---RESULT--- 标记: {}", submission_id);
    let full_output = crate::merge_output(&eval_stdout_full, &eval_stderr_buf);
    match finalize_outcome(None, sent_call_timeout) {
        JudgeStatus::TimeLimitExceeded => Ok(JudgeResult::timeout(
            submission_id,
            &full_output,
            rejudge_seq,
        )),
        _ => Ok(JudgeResult::system_error(
            submission_id,
            &full_output,
            rejudge_seq,
        )),
    }
}
