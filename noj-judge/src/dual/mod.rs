//! 双容器编排核心（设计稿 §1）。
//!
//! 关键路径：
//! 1. 创建 Evaluator + Solution 容器
//! 2. 注入用户代码到 Solution 容器
//! 3. 启动两个 exec（Evaluator 跑 evaluate.py；Solution 跑 host.py）
//! 4. 等待 Solution `ready` 帧（5s 超时）
//! 5. 双向消息转发（evaluator stdout ↔ solution stdin/stderr）
//! 6. 等待 Evaluator stdout 出现 `---RESULT---` 标记，解析结果
//! 7. 发 `shutdown` 到 Solution
//! 8. RAII 清理两个容器

pub mod container;
pub mod protocol;
pub mod tracker;

use std::io::Read;
use std::time::{Duration, Instant};

use anyhow::{Context, Result};
use bollard::container::LogOutput;
use futures_util::StreamExt;
use serde_json::Value;
use tokio::io::AsyncWriteExt;
use tracing::{debug, error, info, warn};

use crate::dual::container::{start_exec, DualContainer, ExecSession};
use crate::dual::protocol::{frame_type, EvaluatorLine, LineParser};
use crate::dual::tracker::{InFlightTracker, WaitingSide};
use crate::sandbox::container::{parse_command, MAX_FILE_SIZE, MAX_TOTAL_SIZE, MAX_ZIP_ENTRIES};
use crate::types::{JudgeResult, JudgeStatus, RuntimeConfig};

/// 评测输出全文/错误累积上限（1 MiB）。恶意提交可无限打印，
/// 若无限 append 会拖垮 judge 进程（容器内存限制不约束 judge）。
pub const MAX_OUTPUT_BYTES: usize = 1024 * 1024;

/// 追加到累积缓冲：超过上限时丢弃头部、只保留尾部（诊断信息优先）。
fn append_capped(buf: &mut String, s: &str) {
    if buf.len() + s.len() > MAX_OUTPUT_BYTES {
        let keep = MAX_OUTPUT_BYTES.saturating_sub(s.len());
        let start = buf.len().saturating_sub(keep);
        *buf = buf[start..].to_string();
    }
    buf.push_str(s);
}

/// 注入用户代码到指定容器的工作目录。
///
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
        move || -> Result<Vec<(String, Vec<u8>)>> {
            let cursor = std::io::Cursor::new(data);
            let mut archive = zip::ZipArchive::new(cursor).context("打开支持包 zip 文件失败")?;

            if archive.len() > MAX_ZIP_ENTRIES {
                anyhow::bail!("zip 条目数 {} 超过上限 {}", archive.len(), MAX_ZIP_ENTRIES);
            }

            let mut seen_paths = std::collections::HashSet::new();
            let mut entries = Vec::new();
            let mut total_size: u64 = 0;

            for i in 0..archive.len() {
                let mut file = archive.by_index(i).context("读取 zip 条目失败")?;
                let file_name = file.name().to_string();

                // 跳过目录项
                if file_name.ends_with('/') || file_name.ends_with('\\') {
                    continue;
                }

                // 路径穿越防护
                if file_name.split(['/', '\\']).any(|part| part == "..")
                    || file_name.starts_with('/')
                {
                    anyhow::bail!("zip 包含非法路径条目: {}", file_name);
                }

                // 拒绝 overlapping entries（同名路径出现两次）
                if !seen_paths.insert(file_name.clone()) {
                    anyhow::bail!("zip 包含重复条目: {}", file_name);
                }

                // 单文件大小限制
                if file.size() > MAX_FILE_SIZE {
                    anyhow::bail!(
                        "zip 条目 '{}' 大小 {} 超过单文件上限 {}",
                        file_name,
                        file.size(),
                        MAX_FILE_SIZE
                    );
                }

                let mut content = Vec::new();
                file.read_to_end(&mut content)
                    .context("读取 zip 条目内容失败")?;

                if content.len() > 64 * 1024 * 1024 {
                    anyhow::bail!(
                        "zip 单文件 {} ({} bytes) 超过上限 64MB",
                        file_name,
                        content.len()
                    );
                }

                total_size = total_size.saturating_add(content.len() as u64);

                if total_size > MAX_TOTAL_SIZE {
                    anyhow::bail!("zip 总解压大小 {} 超过上限 {}", total_size, MAX_TOTAL_SIZE);
                }

                entries.push((file_name, content));
            }

            info!("支持包提取完成 ({} 个文件)", entries.len());
            Ok(entries)
        }
    })
    .await
    .context("spawn_blocking 提取 zip 失败")??;

    // 异步逐个注入到容器
    for (file_name, content) in &entries {
        // 只传文件名（相对路径），因为 docker exec 的 tar 已 -C /workspace
        inject_file_to_container(docker, container_id, file_name, content)
            .await
            .context(format!("注入支持包文件 {} 失败", file_name))?;
        info!("  已注入支持包文件: {}", file_name);
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
    for _ in 0..50 {
        let inspect = docker.inspect_exec(&exec.id).await?;
        if inspect.exit_code.is_some() {
            return Ok(());
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    anyhow::bail!("注入文件超时")
}

/// 双容器评测主入口。
#[allow(clippy::too_many_arguments)]
pub async fn evaluate_dual(
    docker: bollard::Docker,
    task_submission_id: &str,
    runtime_config: &RuntimeConfig,
    user_code: &str,
    _file_name_from_submission: &str,
    support_pkg_bytes: Option<&[u8]>,
    _cache_dir: &str,
    _cache_max_items: usize,
    _cache_max_mb: u64,
    task_rejudge_seq: Option<i64>,
) -> Result<JudgeResult> {
    let evaluator_cmd = parse_command(&runtime_config.evaluator.command);

    // 1. 创建 Evaluator 容器
    let evaluator_network_enabled = runtime_config
        .evaluator
        .network
        .as_ref()
        .map(|n| n.enabled)
        .unwrap_or(false);
    let mut dual = DualContainer::create_evaluator(
        &docker,
        &runtime_config.evaluator.image,
        runtime_config.evaluator.memory_limit_mb,
        None,
        evaluator_network_enabled,
    )
    .await
    .context("创建 Evaluator 容器失败")?;

    // 2. 创建 Solution 容器
    dual.create_solution(
        &runtime_config.solution.image,
        runtime_config.solution.memory_limit_mb,
    )
    .await
    .context("创建 Solution 容器失败")?;

    let evaluator_id = dual.evaluator_id.clone().expect("刚创建");
    let solution_id = dual.solution_id.clone().expect("刚创建");

    // 3. 注入支持包到 Evaluator 容器（evaluate.py 等评测脚本）
    if let Some(pkg_bytes) = support_pkg_bytes {
        info!("注入支持包到 Evaluator 容器 ({} bytes)", pkg_bytes.len());
        inject_support_package_to_evaluator(&docker, &evaluator_id, pkg_bytes)
            .await
            .context("注入支持包到 Evaluator 容器失败")?;
    } else {
        info!("无支持包，跳过注入");
    }

    // 4. 注入用户代码到 Solution 容器（使用 runtime_config.solution.entry 作为文件名）
    inject_file_to_container(
        &docker,
        &solution_id,
        &runtime_config.solution.entry,
        user_code.as_bytes(),
    )
    .await
    .context("注入用户代码到 Solution 容器失败")?;

    // 5. 启动 Evaluator exec
    let evaluator_exec = start_exec(&docker, &evaluator_id, evaluator_cmd)
        .await
        .context("启动 Evaluator exec 失败")?;

    // 5. 启动 Solution exec
    let solution_entry_path = format!("/workspace/{}", runtime_config.solution.entry);
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
    )
    .await
    .context("启动 Solution exec 失败")?;

    // 6. 运行主循环
    let result = run_dual_loop(
        task_submission_id,
        evaluator_exec,
        solution_exec,
        runtime_config.evaluator.time_limit_ms,
        runtime_config.solution.call_timeout_ms,
        task_rejudge_seq,
    )
    .await;

    // 7. 显式销毁（不论成功失败）
    if let Err(e) = dual.destroy().await {
        warn!("DualContainer 销毁警告: {}", e);
    }

    result
}

/// 主循环：双向 NDJSON 转发 + 解析 Evaluator 输出。
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

    // 评测程序启动等待上限：容器创建 / 文件注入 / Python 启动等开销
    // 不计入题目时限（issue：秒过的代码不应因启动开销 TLE）。
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
                return Ok(JudgeResult::timeout(submission_id, "evaluator startup timeout", rejudge_seq));
            }
            // 调用级超时（in-flight 到期）
            _ = async {
                match tracker.next_deadline() {
                    Some(d) => tokio::time::sleep_until(d.into()).await,
                    None => std::future::pending::<()>().await,
                }
            } => {
                for (id, side) in tracker.expire_now(Instant::now()) {
                    match side {
                        WaitingSide::Evaluator => {
                            write_timeout_frame(&mut eval_input, &id).await?;
                        }
                        WaitingSide::Solution => {
                            write_timeout_frame(&mut sol_input, &id).await?;
                        }
                    }
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
                if result_payload.is_some() {
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
                    return Ok(JudgeResult::timeout(submission_id, "evaluator total timeout", rejudge_seq));
                }

                // 调用级超时（in-flight 到期）
                _ = async {
                    match tracker.next_deadline() {
                        Some(d) => tokio::time::sleep_until(d.into()).await,
                        None => std::future::pending::<()>().await,
                    }
                } => {
                    for (id, side) in tracker.expire_now(Instant::now()) {
                        match side {
                            WaitingSide::Evaluator => {
                                write_timeout_frame(&mut eval_input, &id).await?;
                            }
                            WaitingSide::Solution => {
                                write_timeout_frame(&mut sol_input, &id).await?;
                            }
                        }
                    }
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
                    if result_payload.is_some() {
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
        Some(payload) => {
            // payload 是 `---RESULT---` 后第一行 JSON
            let parsed: serde_json::Value =
                serde_json::from_str(&payload).context("---RESULT--- JSON 解析失败")?;
            Ok(build_judge_result(
                submission_id,
                &parsed,
                &eval_stderr_buf,
                &eval_stdout_full,
            ))
        }
        None => {
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
            Ok(JudgeResult::system_error(
                submission_id,
                &full_output,
                rejudge_seq,
            ))
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
        eprint!("[eval-stderr] {}", s);
        return Ok(());
    }

    // stdout: feed 到 LineParser
    let lines = parser.feed(&data);
    let mut awaiting_result_payload = false;
    for line in lines {
        match line {
            EvaluatorLine::ResultMarker => {
                awaiting_result_payload = true;
                append_capped(stdout_full, "---RESULT---\n");
            }
            EvaluatorLine::Frame(v) => {
                // 协议帧处理：
                // - call 帧：evaluator → solution 的函数调用，登记调用级超时后原样转发
                // - cap_reg 帧：judge 与 evaluator 的私有协议（capability 默认超时上报），不转发
                // - result/error 帧：capability 调用的响应（solution 等待），按 id 命中判定转发
                // 其他类型（log 等）记录但不转发
                let ft = frame_type(&v).map(|s| s.to_string());
                match ft.as_deref() {
                    Some("call") => {
                        // 登记调用级超时（缺省回退题目级默认），原样转发
                        tracker.on_call_frame(&v, Instant::now());
                        forward_frame(sol_input, &v).await?;
                    }
                    Some("cap_reg") => {
                        // judge 侧私有协议：更新 capability 超时映射，不转发给 solution
                        tracker.on_cap_reg_frame(&v);
                        debug!("cap_reg 帧已记录（不转发）: {}", v);
                    }
                    Some("result") | Some("error") => {
                        // capability 响应帧：命中则转发给 solution，迟到/未知丢弃
                        if let Some(id) = v.get("id").and_then(Value::as_str) {
                            if tracker.resolve_response(id) {
                                forward_frame(sol_input, &v).await?;
                            } else {
                                warn!("丢弃迟到的 evaluator 响应帧（id={}）", id);
                            }
                        }
                    }
                    _ => {}
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
                if awaiting_result_payload && !s.trim().is_empty() {
                    *result_payload = Some(s.trim().to_string());
                    awaiting_result_payload = false;
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
            // Solution stderr 写到本地 stderr 方便调试
            let s = String::from_utf8_lossy(&message);
            eprint!("[sol-stderr] {}", s);
            return Ok(());
        }
        _ => return Ok(()),
    };

    let lines = parser.feed(&data);
    for line in lines {
        if let EvaluatorLine::Frame(v) = line {
            let ft = frame_type(&v).map(|s| s.to_string());
            if !*solution_ready {
                if ft.as_deref() == Some("ready") {
                    *solution_ready = true;
                    continue;
                }
                // ready 之前的所有帧忽略（防御）
                continue;
            }
            match ft.as_deref() {
                Some("capability") => {
                    // solution 请求 capability：查注册超时登记后转发 evaluator
                    tracker.on_capability_frame(&v, Instant::now());
                    forward_frame(eval_input, &v).await?;
                }
                Some("result") | Some("error") => {
                    // call 响应帧（evaluator 等待）：命中则转发，迟到/未知丢弃
                    if let Some(id) = v.get("id").and_then(Value::as_str) {
                        if tracker.resolve_response(id) {
                            forward_frame(eval_input, &v).await?;
                        } else {
                            warn!("丢弃迟到的 solution 响应帧（id={}）", id);
                        }
                    }
                }
                // log / shutdown 等其他帧：保持既有转发语义（solution → evaluator）
                _ => {
                    forward_frame(eval_input, &v).await?;
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
        "code": "Timeout",
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
) -> JudgeResult {
    let full_output = crate::merge_output(stdout, stderr);
    let status = parsed
        .get("status")
        .and_then(Value::as_str)
        .unwrap_or(JudgeStatus::SystemError.as_str())
        .to_string();
    let score = parsed.get("score").and_then(Value::as_i64).unwrap_or(0) as i32;
    let details = parsed.get("details").cloned().unwrap_or(Value::Null);

    JudgeResult {
        submission_id: submission_id.to_string(),
        status,
        score,
        output: full_output,
        details,
        time_ms: None,
        memory_kb: None,
        rejudge_seq: None,
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
    fn test_build_judge_result_accepted() {
        let parsed = serde_json::json!({
            "status": "Accepted",
            "score": 10000,
            "details": {"cases": []}
        });
        let r = build_judge_result("sid-1", &parsed, "", "");
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
        let r = build_judge_result("sid-2", &parsed, "stderr", "stdout");
        assert_eq!(r.status, "WrongAnswer");
        assert!(r.output.contains("stderr"));
    }

    #[test]
    fn test_build_judge_result_missing_fields() {
        let parsed = serde_json::json!({});
        let r = build_judge_result("sid-3", &parsed, "", "");
        assert_eq!(r.status, "SystemError");
        assert_eq!(r.score, 0);
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
}
