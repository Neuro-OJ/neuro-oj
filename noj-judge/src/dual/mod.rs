//! 双容器编排核心（设计稿 §1）。
//!
//! 关键路径：
//! 1. 创建 Evaluator + Solution 容器（Solution 恒无网；Evaluator 按配置可选联网）
//! 2. 注入支持包到 Evaluator（如有）与用户代码到 Solution
//! 3. 启动两个 exec（Evaluator 跑 evaluate.py；Solution 跑 host.py）
//! 4. 阶段 1：等待 Evaluator 首条输出（30s 启动超时，不计入题目时限）
//! 5. 阶段 2：双向消息转发（evaluator stdout ↔ solution stdin/stderr）+ 调用级超时
//! 6. 等待 Evaluator stdout 出现 `---RESULT---` 标记，解析结果
//! 7. 未出 RESULT 时按 finalize_outcome 判定（总超时 → SystemError；曾发 CallTimeout → TLE）
//! 8. RAII 清理两个容器

pub mod container;
pub mod protocol;
pub mod tracker;

use std::time::{Duration, Instant};

use anyhow::{Context, Result};
use bollard::container::LogOutput;
use futures_util::StreamExt;
use serde_json::Value;
use tokio::io::AsyncWriteExt;
use tracing::{debug, error, info, warn};

use crate::dual::container::{start_exec, DualContainer, ExecSession};
use crate::dual::protocol::{
    frame_type, EvaluatorLine, LineParser, FRAME_CALL, FRAME_CAPABILITY, FRAME_CAP_REG,
    FRAME_ERROR, FRAME_LOG, FRAME_READY, FRAME_RESULT, FRAME_SHUTDOWN, RESULT_MARKER,
};
use crate::dual::tracker::{InFlightTracker, WaitingSide};
use crate::sandbox::container::{extract_zip_entries, parse_command};
use crate::types::{JudgeResult, JudgeStatus, JudgeTaskLlm, RuntimeConfig};

/// 评测输出全文/错误累积上限（1 MiB）。恶意提交可无限打印，
/// 若无限 append 会拖垮 judge 进程（容器内存限制不约束 judge）。
pub const MAX_OUTPUT_BYTES: usize = 1024 * 1024;

/// Solution 容器入口文件名（评测内部约定，硬编码；与 noj_solution_sdk.host
/// 的 `--entry` 路径一致，模块名固定为 `user_solution`，文件名不影响评测）。
pub const SOLUTION_ENTRY_FILE: &str = "main.py";

/// 构造 Evaluator 的 LLM 环境变量（Solution 容器始终不注入）。
fn build_llm_env(llm: &JudgeTaskLlm) -> Vec<String> {
    vec![
        format!("NOJ_LLM_GATEWAY_URL={}", llm.gateway_url),
        format!("NOJ_LLM_TOKEN={}", llm.eval_token),
        format!("NOJ_LLM_PROVIDER_ID={}", llm.provider_id),
        format!("NOJ_LLM_ALLOWED_MODELS={}", llm.allowed_models.join(",")),
    ]
}

/// 文件注入 exec 完成轮询次数与间隔（50 × 100ms = 5s 上限）。
const INJECT_POLL_ATTEMPTS: u32 = 50;
const INJECT_POLL_INTERVAL_MS: u64 = 100;

/// 校验镜像名最后一段是否匹配受信前缀。
fn image_allowed(image: &str, prefix: &str) -> bool {
    if image.is_empty() || image.contains("..") || image.contains('\0') {
        return false;
    }
    let basename = image.rsplit('/').next().unwrap_or(image);
    let name = basename.split(':').next().unwrap_or(basename);
    name.starts_with(prefix)
}

/// NOJ-190：judge 侧对 MQ 消息中的镜像/命令/网络做白名单复验。
fn validate_runtime_config(
    submission_id: &str,
    runtime_config: &RuntimeConfig,
    allow_evaluator_network: bool,
    image_prefix: &str,
    command_whitelist: &[String],
) -> Result<()> {
    if !image_allowed(&runtime_config.evaluator.image, image_prefix) {
        anyhow::bail!(
            "submission {}: evaluator 镜像不在白名单前缀内: {}",
            submission_id,
            runtime_config.evaluator.image
        );
    }
    if !image_allowed(&runtime_config.solution.image, image_prefix) {
        anyhow::bail!(
            "submission {}: solution 镜像不在白名单前缀内: {}",
            submission_id,
            runtime_config.solution.image
        );
    }

    let argv = parse_command(&runtime_config.evaluator.command);
    if argv.is_empty() {
        anyhow::bail!("submission {}: evaluator 命令为空", submission_id);
    }
    let executable = &argv[0];
    if !command_whitelist.iter().any(|w| w == executable) {
        anyhow::bail!(
            "submission {}: evaluator 可执行文件不在白名单内: {}",
            submission_id,
            executable
        );
    }

    let network_enabled = runtime_config
        .evaluator
        .network
        .as_ref()
        .map(|n| n.enabled)
        .unwrap_or(false);
    if network_enabled && !allow_evaluator_network {
        anyhow::bail!(
            "submission {}: 消息请求开启 evaluator 网络，但 judge 未允许（JUDGE_ALLOW_EVALUATOR_NETWORK=false）",
            submission_id
        );
    }
    Ok(())
}

/// 对任务中的资源限制字段执行硬上限收敛，防止 core 配置缺失或消息被篡改。
fn clamp_runtime_config(
    rc: &RuntimeConfig,
    max_evaluator_time_ms: u64,
    max_solution_call_timeout_ms: u64,
) -> RuntimeConfig {
    let mut clamped = rc.clone();
    if max_evaluator_time_ms > 0 {
        clamped.evaluator.time_limit_ms =
            clamped.evaluator.time_limit_ms.min(max_evaluator_time_ms);
    }
    if max_solution_call_timeout_ms > 0 {
        clamped.solution.call_timeout_ms = clamped
            .solution
            .call_timeout_ms
            .min(max_solution_call_timeout_ms);
    }
    // 内存硬上限与容器创建逻辑保持一致（0 由容器层规范化为 512MB，上限 4096MB）。
    clamped.evaluator.memory_limit_mb = clamped.evaluator.memory_limit_mb.min(4096);
    clamped.solution.memory_limit_mb = clamped.solution.memory_limit_mb.min(4096);
    clamped
}

/// 追加到累积缓冲：超过上限时丢弃头部、只保留尾部（诊断信息优先）。
fn append_capped(buf: &mut String, s: &str) {
    if buf.len() + s.len() > MAX_OUTPUT_BYTES {
        let keep = MAX_OUTPUT_BYTES.saturating_sub(s.len());
        let start = buf.len().saturating_sub(keep);
        *buf = buf[start..].to_string();
    }
    buf.push_str(s);
}

/// 注入支持包（zip）到 Evaluator 容器的 /workspace 目录。
///
/// 先同步提取 zip 中所有文件到内存，再逐个异步注入到容器。
async fn inject_support_package_to_evaluator(
    docker: &bollard::Docker,
    container_id: &str,
    zip_bytes: &[u8],
) -> Result<()> {
    // 同步提取 zip 内容到内存（ZipFile 不是 Send，不能在 tokio::spawn 中跨 await 持有）
    let entries = tokio::task::spawn_blocking({
        let data = zip_bytes.to_vec();
        move || extract_zip_entries(&data)
    })
    .await
    .context("spawn_blocking 提取 zip 失败")??;

    // 异步逐个注入到容器（目录条目由 tar 解压自动创建，无需注入）
    for entry in &entries {
        if entry.is_dir {
            continue;
        }
        // 只传文件名（相对路径），因为 docker exec 的 tar 已 -C /workspace
        inject_file_to_container(docker, container_id, &entry.file_name, &entry.data)
            .await
            .context(format!("注入支持包文件 {} 失败", entry.file_name))?;
        info!("已注入支持包文件: {}", entry.file_name);
    }

    info!("支持包注入完成 (共 {} 个文件)", entries.len());
    Ok(())
}

/// 使用 `tar | docker exec tar xf` 模式，注入文件到容器。
async fn inject_file_to_container(
    docker: &bollard::Docker,
    container_id: &str,
    file_name: &str,
    content: &[u8],
) -> Result<()> {
    // 构造 tar in-memory
    let mut header = tar::Header::new_gnu();
    header.set_size(content.len() as u64);
    header.set_mode(0o644);
    header.set_cksum();

    let mut tar_buf: Vec<u8> = Vec::new();
    {
        let mut builder = tar::Builder::new(&mut tar_buf);
        builder.append_data(&mut header, file_name, content)?;
        builder.finish()?;
    }

    // docker exec tar xf - -C /workspace
    let exec = docker
        .create_exec(
            container_id,
            bollard::models::ExecConfig {
                cmd: Some(vec![
                    "sh".to_string(),
                    "-c".to_string(),
                    "tar xf - -C /workspace".to_string(),
                ]),
                attach_stdin: Some(true),
                attach_stdout: Some(false),
                attach_stderr: Some(false),
                ..Default::default()
            },
        )
        .await
        .context("创建 inject exec 失败")?;

    let started = docker.start_exec(&exec.id, None).await?;
    if let bollard::exec::StartExecResults::Attached { mut input, .. } = started {
        input.write_all(&tar_buf).await?;
        input.shutdown().await?;
    }

    // 等 exec 完成（简化处理：用 inspect_exec 轮询直到退出）
    // 轮询上限 50 次 × 100ms = 5s；退出码非 0 时视为注入失败。
    for _ in 0..INJECT_POLL_ATTEMPTS {
        let inspect = docker.inspect_exec(&exec.id).await?;
        if let Some(code) = inspect.exit_code {
            if code != 0 {
                anyhow::bail!("注入文件 {} 失败（exit_code={}）", file_name, code);
            }
            return Ok(());
        }
        tokio::time::sleep(Duration::from_millis(INJECT_POLL_INTERVAL_MS)).await;
    }
    anyhow::bail!("注入文件超时")
}

/// 双容器评测入口，允许通过 Worker 配置传入每个容器的 CPU 上限。
#[allow(clippy::too_many_arguments)]
pub async fn evaluate_dual_with_cpu_limit(
    docker: bollard::Docker,
    task_submission_id: &str,
    runtime_config: &RuntimeConfig,
    user_code: &str,
    support_pkg_bytes: Option<&[u8]>,
    task_rejudge_seq: Option<i64>,
    task_llm: Option<&JudgeTaskLlm>,
    cpu_limit_millicores: u64,
    allow_evaluator_network: bool,
    evaluator_network_mode: &str,
    image_prefix: &str,
    command_whitelist: &[String],
    max_evaluator_time_ms: u64,
    max_solution_call_timeout_ms: u64,
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
    let started = Instant::now();
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
    )
    .await
    .context("创建 Evaluator 容器失败")?;

    // 2. 创建 Solution 容器
    dual.create_solution(
        &runtime_config.solution.image,
        runtime_config.solution.memory_limit_mb,
        cpu_limit_millicores,
    )
    .await
    .context("创建 Solution 容器失败")?;

    let evaluator_id = dual
        .evaluator_id
        .clone()
        .ok_or_else(|| anyhow::anyhow!("Evaluator 容器 ID 缺失"))?;
    let solution_id = dual
        .solution_id
        .clone()
        .ok_or_else(|| anyhow::anyhow!("Solution 容器 ID 缺失"))?;

    // 3. 注入支持包到 Evaluator 容器（evaluate.py 等评测脚本）
    if let Some(pkg_bytes) = support_pkg_bytes {
        info!("注入支持包到 Evaluator 容器 ({} bytes)", pkg_bytes.len());
        inject_support_package_to_evaluator(&docker, &evaluator_id, pkg_bytes)
            .await
            .context("注入支持包到 Evaluator 容器失败")?;
    } else {
        info!("无支持包，跳过注入");
    }

    // 4. 注入用户代码到 Solution 容器（入口文件名硬编码，见 SOLUTION_ENTRY_FILE）
    inject_file_to_container(
        &docker,
        &solution_id,
        SOLUTION_ENTRY_FILE,
        user_code.as_bytes(),
    )
    .await
    .context("注入用户代码到 Solution 容器失败")?;

    // 5. 构造 Evaluator 环境变量（LLM 任务注入 gateway 地址与 eval_token）
    let evaluator_env = task_llm.map(build_llm_env).unwrap_or_default();

    // 6. 启动 Evaluator exec
    let evaluator_exec = start_exec(&docker, &evaluator_id, evaluator_cmd, evaluator_env)
        .await
        .context("启动 Evaluator exec 失败")?;

    // 7. 启动 Solution exec（Solution 容器不注入任何 NOJ_LLM_* 环境变量）
    let solution_entry_path = format!("/workspace/{}", SOLUTION_ENTRY_FILE);
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

    // 7. 运行主循环
    let result = run_dual_loop(
        task_submission_id,
        evaluator_exec,
        solution_exec,
        runtime_config.evaluator.time_limit_ms,
        runtime_config.solution.call_timeout_ms,
        task_rejudge_seq,
    )
    .await;

    // 8. 显式销毁（不论成功失败）
    if let Err(e) = dual.destroy().await {
        warn!("DualContainer 销毁警告: {}", e);
    }

    // NOJ-162（部分）：回填真实总耗时；memory_kb 当前 Docker API 未暴露峰值，
    // 保持 None 并在文档中明确。
    let mut result = result?;
    if result.time_ms.is_none() {
        result.time_ms = Some(started.elapsed().as_millis() as u64);
    }
    Ok(result)
}

/// 超时种类：判定最终状态时区分启动期与正式评测期。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum TimeoutKind {
    /// 阶段 1：评测程序启动等待超时（容器创建 / 文件注入 / 运行时启动开销）
    Startup,
    /// 阶段 2：evaluator 整体执行超过 time_limit_ms
    Total,
}

/// 评测收尾判定：把「评测如何结束」映射为最终状态。
///
/// 仅在 evaluator 未正常输出 ---RESULT--- 时调用（有 RESULT 走 build_judge_result）。
/// 规则（顺序即优先级）：
/// 1. 总超时（Startup/Total）→ SystemError：评测流程未正常完成，做题人不可通过改代码解决；
/// 2. 曾向 evaluator 发送过 CallTimeout 错误帧 → TimeLimitExceeded：用户代码慢是根因；
/// 3. 否则 → SystemError：evaluator 自身异常。
fn finalize_outcome(timed_out: Option<TimeoutKind>, sent_call_timeout: bool) -> JudgeStatus {
    if timed_out.is_some() {
        return JudgeStatus::SystemError;
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
async fn expire_call_timeouts(
    tracker: &mut InFlightTracker,
    eval_input: &mut std::pin::Pin<Box<dyn tokio::io::AsyncWrite + Send + Unpin>>,
    sol_input: &mut std::pin::Pin<Box<dyn tokio::io::AsyncWrite + Send + Unpin>>,
    sent_call_timeout: &mut bool,
) -> Result<()> {
    for (id, side) in tracker.expire_now(Instant::now()) {
        match side {
            WaitingSide::Evaluator => {
                write_timeout_frame(eval_input, &id).await?;
                *sent_call_timeout = true;
            }
            WaitingSide::Solution => {
                write_timeout_frame(sol_input, &id).await?;
            }
        }
    }
    Ok(())
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
    rejudge_seq: Option<i64>,
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

    let mut result_payload: Option<String> = None;

    // 调用级超时追踪器（题目级 call_timeout_ms 作为缺省回退值）
    let mut tracker = InFlightTracker::new(default_call_timeout_ms);

    // 是否向 evaluator 发送过 CallTimeout 错误帧（solution 调用超时）。
    // 仅 WaitingSide::Evaluator（evaluator 等 solution 的 call）置位；
    // WaitingSide::Solution（capability 反向调用超时）不置位——其错误帧写给 solution，
    // 不构成「evaluator 未处理 CallTimeout」归因。
    let mut sent_call_timeout = false;

    // 评测程序启动等待上限：容器创建 / 文件注入 / Python 启动等开销
    // 不计入题目时限：秒过的代码不应因启动开销 TLE。
    const EVALUATOR_STARTUP_TIMEOUT_MS: u64 = 30_000;

    // 阶段 1：等待评测程序真正开始运行（收到首条输出，通常为 ready 帧）。
    // 启动阶段用独立宽松超时；评测程序开始运行后，总超时才按题目时限计时。
    let startup_deadline = tokio::time::sleep(Duration::from_millis(EVALUATOR_STARTUP_TIMEOUT_MS));
    tokio::pin!(startup_deadline);

    let mut evaluator_started = false;
    while !evaluator_started {
        tokio::select! {
            _ = &mut startup_deadline => {
                warn!("Evaluator 启动超时（{}ms）: {}", EVALUATOR_STARTUP_TIMEOUT_MS, submission_id);
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
                expire_call_timeouts(
                    &mut tracker,
                    &mut eval_input,
                    &mut sol_input,
                    &mut sent_call_timeout,
                )
                .await?;
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
                handle_eval_chunk(
                    &mut eval_parser,
                    &mut eval_stderr_buf,
                    &mut eval_stdout_full,
                    &mut sol_input,
                    &mut result_payload,
                    &mut tracker,
                    chunk,
                )
                .await?;
                if result_payload.as_ref().is_some_and(|p| !p.is_empty()) {
                    break;
                }
                evaluator_started = true;
            }
            else => break,
        }
    }

    // 阶段 2：正式评测——总超时从评测程序开始运行起算（题目 time_limit_ms）。
    if result_payload.is_none() {
        let deadline = tokio::time::sleep(Duration::from_millis(evaluator_timeout_ms));
        tokio::pin!(deadline);

        'outer: loop {
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
                    expire_call_timeouts(
                        &mut tracker,
                        &mut eval_input,
                        &mut sol_input,
                        &mut sent_call_timeout,
                    )
                    .await?;
                }

                // Evaluator stdout/stderr
                chunk = eval_output.next() => {
                    let chunk = match chunk {
                        Some(Ok(c)) => c,
                        Some(Err(e)) => {
                            error!("Evaluator exec 流错误: {}", e);
                            break 'outer;
                        }
                        None => break 'outer,  // EOF
                    };
                    handle_eval_chunk(
                        &mut eval_parser,
                        &mut eval_stderr_buf,
                        &mut eval_stdout_full,
                        &mut sol_input,
                        &mut result_payload,
                        &mut tracker,
                        chunk,
                    )
                    .await?;
                    if result_payload.as_ref().is_some_and(|p| !p.is_empty()) {
                        break 'outer;
                    }
                }

                // Solution stdout/stderr
                chunk = sol_output.next() => {
                    let chunk = match chunk {
                        Some(Ok(c)) => c,
                        Some(Err(e)) => {
                            error!("Solution exec 流错误: {}", e);
                            break 'outer;
                        }
                        None => break 'outer,
                    };
                    handle_sol_chunk(
                        &mut sol_parser,
                        &mut eval_input,
                        chunk,
                        &mut solution_ready,
                        &mut tracker,
                    )
                    .await?;
                }

                else => break 'outer,
            }
        }
    }

    // 解析最终结果
    match result_payload {
        Some(payload) if !payload.is_empty() => {
            // payload 是 `---RESULT---` 后第一行 JSON
            let parsed: serde_json::Value =
                serde_json::from_str(&payload).context("---RESULT--- JSON 解析失败")?;
            Ok(build_judge_result(
                submission_id,
                &parsed,
                &eval_stderr_buf,
                &eval_stdout_full,
                rejudge_seq,
            ))
        }
        _ => {
            // 未拿到 RESULT 标记
            warn!("Evaluator 未输出 ---RESULT--- 标记: {}", submission_id);
            // drain 残留
            let remaining = eval_parser.drain_remaining();
            for line in remaining {
                if let EvaluatorLine::Unknown(s) = line {
                    append_capped(&mut eval_stdout_full, &s);
                    append_capped(&mut eval_stdout_full, "\n");
                }
            }
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
    }
}

/// 处理 Evaluator exec 的一个 chunk：解析 + 转发 call 帧 + 检测 RESULT 标记。
#[allow(clippy::too_many_arguments)]
async fn handle_eval_chunk(
    parser: &mut LineParser,
    stderr_buf: &mut String,
    stdout_full: &mut String,
    sol_input: &mut std::pin::Pin<Box<dyn tokio::io::AsyncWrite + Send + Unpin>>,
    result_payload: &mut Option<String>,
    tracker: &mut InFlightTracker,
    chunk: LogOutput,
) -> Result<()> {
    let (data, is_err) = match chunk {
        LogOutput::StdOut { message } => (message, false),
        LogOutput::StdErr { message } => (message, true),
        _ => return Ok(()),
    };

    if is_err {
        let s = String::from_utf8_lossy(&data);
        append_capped(stderr_buf, &s);
        // Evaluator stderr 透传到日志（诊断用）
        debug!("[eval-stderr] {}", s);
        return Ok(());
    }

    // stdout: feed 到 LineParser
    let lines = parser.feed(&data);
    for line in lines {
        match line {
            EvaluatorLine::ResultMarker => {
                // NOJ-160：用 Some("") 作为「已见标记、等待下一非空行」的跨 chunk 状态。
                *result_payload = Some(String::new());
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
                        forward_frame(sol_input, &v).await?;
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
                                forward_frame(sol_input, &v).await?;
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
                if result_payload.as_ref() == Some(&String::new()) && !s.trim().is_empty() {
                    *result_payload = Some(s.trim().to_string());
                }
            }
        }
    }
    Ok(())
}

/// 处理 Solution exec 的一个 chunk：转发 NDJSON 帧到 evaluator stdin。
async fn handle_sol_chunk(
    parser: &mut LineParser,
    eval_input: &mut std::pin::Pin<Box<dyn tokio::io::AsyncWrite + Send + Unpin>>,
    chunk: LogOutput,
    solution_ready: &mut bool,
    tracker: &mut InFlightTracker,
) -> Result<()> {
    let data = match chunk {
        LogOutput::StdOut { message } => message,
        LogOutput::StdErr { message } => {
            // Solution stderr 透传到日志（诊断用）
            let s = String::from_utf8_lossy(&message);
            debug!("[sol-stderr] {}", s);
            return Ok(());
        }
        _ => return Ok(()),
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
                    forward_frame(eval_input, &v).await?;
                }
                Some(FRAME_RESULT) | Some(FRAME_ERROR) => {
                    // call 响应帧（evaluator 等待）：命中则转发，迟到/未知丢弃
                    if let Some(id) = v.get("id").and_then(Value::as_str) {
                        if tracker.resolve_response(id) {
                            forward_frame(eval_input, &v).await?;
                        } else {
                            warn!("丢弃迟到的 solution 响应帧（id={}）", id);
                        }
                    }
                }
                // log / shutdown 等合法帧：保持既有转发语义（solution → evaluator）
                Some(FRAME_LOG) | Some(FRAME_SHUTDOWN) => {
                    forward_frame(eval_input, &v).await?;
                }
                // 未知/非法 type：按协议记录 warn 并丢弃
                _ => {
                    warn!("丢弃未知 type 的 solution 帧: {}", v);
                }
            }
        }
    }
    Ok(())
}

/// 向等待方写调用级超时错误帧。
async fn write_timeout_frame(
    writer: &mut std::pin::Pin<Box<dyn tokio::io::AsyncWrite + Send + Unpin>>,
    id: &str,
) -> Result<()> {
    let frame = serde_json::json!({
        "type": "error",
        "id": id,
        "code": "CallTimeout",
        "message": "call timeout",
    });
    forward_frame(writer, &frame).await
}

async fn forward_frame(
    writer: &mut std::pin::Pin<Box<dyn tokio::io::AsyncWrite + Send + Unpin>>,
    frame: &Value,
) -> Result<()> {
    use tokio::io::AsyncWriteExt;
    let line = serde_json::to_string(frame)?;
    writer.write_all(line.as_bytes()).await?;
    writer.write_all(b"\n").await?;
    writer.flush().await?;
    Ok(())
}

fn build_judge_result(
    submission_id: &str,
    parsed: &serde_json::Value,
    stderr: &str,
    stdout: &str,
    rejudge_seq: Option<i64>,
) -> JudgeResult {
    let full_output = crate::merge_output(stdout, stderr);
    let raw_status = parsed
        .get("status")
        .and_then(Value::as_str)
        .unwrap_or(JudgeStatus::SystemError.as_str());
    let status = match raw_status {
        "Accepted"
        | "WrongAnswer"
        | "TimeLimitExceeded"
        | "MemoryLimitExceeded"
        | "RuntimeError"
        | "SystemError" => raw_status.to_string(),
        _ => JudgeStatus::SystemError.as_str().to_string(),
    };
    let score = parsed
        .get("score")
        .and_then(Value::as_i64)
        .unwrap_or(0)
        .clamp(0, 10_000) as i32;
    let details = parsed.get("details").cloned().unwrap_or(Value::Null);

    JudgeResult {
        submission_id: submission_id.to_string(),
        status,
        score,
        output: full_output,
        details,
        time_ms: None,
        memory_kb: None,
        // NOJ-161：成功路径必须透传任务 rejudge_seq。
        rejudge_seq,
    }
}

/// 集成测试辅助（tests/ 目录 E2E 使用，复用真实转发逻辑）。
///
/// 封装 [`handle_eval_chunk`] / [`handle_sol_chunk`]，跳过 stdout/stderr 收集，
/// 让 E2E 测试直接驱动 judge 转发语义。
#[allow(dead_code)] // 仅 tests/ 集成测试引用（lib 目标下必然未使用）
pub mod mod_test_helpers {
    use super::*;

    /// 等价 `handle_eval_chunk`，忽略 stderr/stdout 全文收集。
    pub async fn handle_eval_chunk_probe(
        parser: &mut LineParser,
        sol_input: &mut std::pin::Pin<Box<dyn tokio::io::AsyncWrite + Send + Unpin>>,
        result_payload: &mut Option<String>,
        tracker: &mut InFlightTracker,
        chunk: LogOutput,
    ) {
        let mut stderr_buf = String::new();
        let mut stdout_full = String::new();
        let _ = super::handle_eval_chunk(
            parser,
            &mut stderr_buf,
            &mut stdout_full,
            sol_input,
            result_payload,
            tracker,
            chunk,
        )
        .await;
    }

    /// 等价 `handle_sol_chunk`。
    pub async fn handle_sol_chunk_probe(
        parser: &mut LineParser,
        eval_input: &mut std::pin::Pin<Box<dyn tokio::io::AsyncWrite + Send + Unpin>>,
        chunk: LogOutput,
        solution_ready: &mut bool,
        tracker: &mut InFlightTracker,
    ) {
        let _ = super::handle_sol_chunk(parser, eval_input, chunk, solution_ready, tracker).await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_build_llm_env() {
        let llm = JudgeTaskLlm {
            gateway_url: "http://llm-gateway:8001".to_string(),
            eval_token: "token-abc".to_string(),
            provider_id: "prov-1".to_string(),
            allowed_models: vec!["qwen-plus".to_string(), "qwen-max".to_string()],
        };
        let env = build_llm_env(&llm);
        assert!(env.contains(&"NOJ_LLM_GATEWAY_URL=http://llm-gateway:8001".to_string()));
        assert!(env.contains(&"NOJ_LLM_TOKEN=token-abc".to_string()));
        assert!(env.contains(&"NOJ_LLM_PROVIDER_ID=prov-1".to_string()));
        assert!(env.contains(&"NOJ_LLM_ALLOWED_MODELS=qwen-plus,qwen-max".to_string()));
    }

    #[test]
    fn test_build_judge_result_accepted() {
        let parsed = serde_json::json!({
            "status": "Accepted",
            "score": 10000,
            "details": {"cases": []}
        });
        let r = build_judge_result("sid-1", &parsed, "", "", Some(7));
        assert_eq!(r.rejudge_seq, Some(7));
        assert_eq!(r.status, "Accepted");
        assert_eq!(r.score, 10000);
    }

    #[test]
    fn test_build_judge_result_wrong_answer() {
        let parsed = serde_json::json!({
            "status": "WrongAnswer",
            "score": 0,
            "details": {"message": "expected 3 got 4"}
        });
        let r = build_judge_result("sid-2", &parsed, "stderr", "stdout", None);
        assert_eq!(r.status, "WrongAnswer");
        assert!(r.output.contains("stderr"));
    }

    #[test]
    fn test_build_judge_result_missing_fields() {
        let parsed = serde_json::json!({});
        let r = build_judge_result("sid-3", &parsed, "", "", None);
        assert_eq!(r.status, "SystemError");
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
        use bollard::container::LogOutput;
        use tokio::io::AsyncReadExt;

        let (sink, mut source) = tokio::io::duplex(8192);
        let mut writer: std::pin::Pin<Box<dyn tokio::io::AsyncWrite + Send + Unpin>> =
            Box::pin(sink);

        let mut parser = LineParser::new();
        let mut stderr_buf = String::new();
        let mut stdout_full = String::new();
        let mut result_payload: Option<String> = None;
        let mut tracker = InFlightTracker::new(2000);
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
        use bollard::container::LogOutput;
        use tokio::io::AsyncReadExt;

        let (sink, mut source) = tokio::io::duplex(8192);
        let mut writer: std::pin::Pin<Box<dyn tokio::io::AsyncWrite + Send + Unpin>> =
            Box::pin(sink);

        let mut parser = LineParser::new();
        let mut stderr_buf = String::new();
        let mut stdout_full = String::new();
        let mut result_payload: Option<String> = None;
        let mut tracker = InFlightTracker::new(2000);

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
        use bollard::container::LogOutput;

        let (sink, _source) = tokio::io::duplex(8192);
        let mut writer: std::pin::Pin<Box<dyn tokio::io::AsyncWrite + Send + Unpin>> =
            Box::pin(sink);

        let mut parser = LineParser::new();
        let mut stderr_buf = String::new();
        let mut stdout_full = String::new();
        let mut result_payload: Option<String> = None;
        let mut tracker = InFlightTracker::new(2000);

        let chunk = LogOutput::StdOut {
            message: bytes::Bytes::from_static(
                b"---RESULT---\n{\"status\":\"Accepted\",\"score\":100}\n",
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

        assert_eq!(
            result_payload.as_deref(),
            Some("{\"status\":\"Accepted\",\"score\":100}")
        );
        assert!(stdout_full.contains("---RESULT---"));
    }

    #[tokio::test]
    async fn test_result_marker_and_payload_split_across_chunks() {
        use bollard::container::LogOutput;

        let (sink, _source) = tokio::io::duplex(8192);
        let mut writer: std::pin::Pin<Box<dyn tokio::io::AsyncWrite + Send + Unpin>> =
            Box::pin(sink);

        let mut parser = LineParser::new();
        let mut stderr_buf = String::new();
        let mut stdout_full = String::new();
        let mut result_payload: Option<String> = None;
        let mut tracker = InFlightTracker::new(2000);

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
                message: bytes::Bytes::from_static(b"{\"status\":\"Accepted\",\"score\":100}\n"),
            },
        )
        .await
        .unwrap();
        assert_eq!(
            result_payload.as_deref(),
            Some("{\"status\":\"Accepted\",\"score\":100}")
        );
    }

    #[tokio::test]
    async fn test_eval_call_frame_tracked_and_forwarded() {
        // call 帧：登记 in-flight 并原样转发（含 timeout_ms 字段）到 sol_input
        use bollard::container::LogOutput;
        use tokio::io::AsyncReadExt;

        let (sink, mut source) = tokio::io::duplex(8192);
        let mut writer: std::pin::Pin<Box<dyn tokio::io::AsyncWrite + Send + Unpin>> =
            Box::pin(sink);

        let mut parser = LineParser::new();
        let mut stderr_buf = String::new();
        let mut stdout_full = String::new();
        let mut result_payload: Option<String> = None;
        let mut tracker = InFlightTracker::new(2000);

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
        use bollard::container::LogOutput;
        use tokio::io::AsyncReadExt;

        let (sink, mut source) = tokio::io::duplex(8192);
        let mut writer: std::pin::Pin<Box<dyn tokio::io::AsyncWrite + Send + Unpin>> =
            Box::pin(sink);

        let mut parser = LineParser::new();
        let mut stderr_buf = String::new();
        let mut stdout_full = String::new();
        let mut result_payload: Option<String> = None;
        let mut tracker = InFlightTracker::new(2000);

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
        use bollard::container::LogOutput;
        use tokio::io::AsyncReadExt;

        let (sink, mut source) = tokio::io::duplex(8192);
        let mut writer: std::pin::Pin<Box<dyn tokio::io::AsyncWrite + Send + Unpin>> =
            Box::pin(sink);

        let mut parser = LineParser::new();
        let mut solution_ready = true;
        let mut tracker = InFlightTracker::new(2000);

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
        use bollard::container::LogOutput;
        use tokio::io::AsyncReadExt;

        let (sink, mut source) = tokio::io::duplex(8192);
        let mut writer: std::pin::Pin<Box<dyn tokio::io::AsyncWrite + Send + Unpin>> =
            Box::pin(sink);

        let mut parser = LineParser::new();
        let mut solution_ready = true;
        let mut tracker = InFlightTracker::new(2000);

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
}
