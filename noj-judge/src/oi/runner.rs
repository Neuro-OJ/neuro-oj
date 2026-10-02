//! 传统 OI 题的原生 C/C++ 执行器。
//!
//! OI 任务使用固定的受信编译镜像；题包中的输入/输出文件只在 judge 进程中
//! 读取，用户代码不会获得题包目录。每个测试点使用一次性容器，因此一个测试点
//! 不能通过文件、环境变量或进程状态影响后续测试点。

use std::collections::HashMap;
use std::path::Path;
use std::pin::Pin;
use std::time::{Duration, Instant};

use anyhow::{bail, Context, Result};
use bollard::container::LogOutput;
use bollard::exec::StartExecResults;
use bollard::models::{ContainerCreateBody, ExecConfig};
use bollard::Docker;
use futures_util::Stream;
use futures_util::StreamExt;
use tokio::io::AsyncWriteExt;
use tokio::time::timeout;
use tracing::{info, warn};

use crate::dual::container::{container_labels, SANDBOX_USER};
use crate::oi::{
    score_submission, OiBackend, OiCase, OiCaseResult, OiCheckerType, OiRuntimeConfig, OiStatus,
};
use crate::sandbox::cleanup::remove_container_force;
use crate::sandbox::container::{
    extract_zip_entries_from_file, inject_file_to_container, ZipEntry,
};
use crate::sandbox::host_config::build_host_config_with_cpu;
use crate::types::{JudgeResult, JudgeTask};

/// 传统 OI 输出上限。超过上限立即停止容器并归因 OLE，避免 judge 进程本身
/// 因恶意无限输出而耗尽内存。
const MAX_OUTPUT_BYTES: usize = 64 * 1024 * 1024;
/// 用户源码上限。题包和 MQ 已有大小限制，judge 侧仍保留最后一道边界。
const MAX_SOURCE_BYTES: usize = 4 * 1024 * 1024;
/// 编译不计入题目运行时限，但必须有独立上限，避免编译器被卡死。
const COMPILE_TIMEOUT: Duration = Duration::from_secs(120);
const EXEC_CREATE_TIMEOUT: Duration = Duration::from_secs(10);
const EXEC_START_TIMEOUT: Duration = Duration::from_secs(10);
const EXEC_INSPECT_TIMEOUT: Duration = Duration::from_secs(5);
const EXEC_INSPECT_ATTEMPTS: usize = 50;
const INPUT_WRITE_TIMEOUT: Duration = Duration::from_secs(10);

type OutputStream = Pin<Box<dyn Stream<Item = Result<LogOutput, bollard::errors::Error>> + Send>>;

#[derive(Debug)]
struct CapturedOutput {
    stdout: Vec<u8>,
    stderr: Vec<u8>,
    output_limited: bool,
}

#[derive(Debug)]
struct ExecOutcome {
    output: CapturedOutput,
    exit_code: i64,
}

enum CaseOutcome {
    Result(OiCaseResult),
    CompileError,
}

/// 执行一个 OI 任务。`trusted_image` 只能来自 Worker 配置，绝不从题目或 MQ
/// 消息中读取。
pub async fn evaluate_native(
    docker: &Docker,
    task: &JudgeTask,
    support_package: &Path,
    trusted_image: &str,
    cpu_limit_millicores: u64,
    instance_id: &str,
) -> Result<JudgeResult> {
    let runtime_config = task
        .runtime_config
        .as_oi()
        .context("OI runner 收到非 OI runtime_config")?;
    if task.judge_type != "oi" {
        bail!("OI runner 收到不匹配的 judge_type: {}", task.judge_type);
    }
    if runtime_config.backend != OiBackend::Native {
        return Ok(system_error_result(task, "WASM 后端尚未在当前 Worker 启用"));
    }
    if task.code.len() > MAX_SOURCE_BYTES {
        return Ok(system_error_result(task, "提交源码超过 OI runner 限制"));
    }
    if !runtime_config.languages.iter().any(|language| {
        matches!(
            (language, task.language.as_str()),
            (crate::oi::OiLanguage::C, "c") | (crate::oi::OiLanguage::Cpp, "cpp")
        )
    }) {
        return Ok(system_error_result(
            task,
            "提交语言不在题目允许的语言列表中",
        ));
    }
    if runtime_config.checker.kind == OiCheckerType::Testlib {
        // testlib checker 必须在受信的 checker runner 中执行，不能把题包中的
        // 可执行文件直接交给与用户代码相同的容器。
        return Ok(system_error_result(
            task,
            "testlib checker 尚未接入受信执行器",
        ));
    }

    let entries = extract_zip_entries_from_file(support_package).context("读取 OI 支持包失败")?;
    let files = index_files(entries)?;
    validate_references(runtime_config, &files)?;

    let started = Instant::now();
    let mut case_results = Vec::new();
    let mut compiled_once = false;
    for subtask in &runtime_config.subtasks {
        for case in &subtask.cases {
            let outcome = run_case(
                docker,
                task,
                runtime_config,
                subtask.time_limit_ms,
                subtask.memory_limit_mb,
                case,
                files.get(&case.input).context("OI 输入文件索引丢失")?,
                files.get(&case.output).context("OI 输出文件索引丢失")?,
                trusted_image,
                cpu_limit_millicores,
                instance_id,
            )
            .await?;
            match outcome {
                CaseOutcome::Result(result) => {
                    compiled_once = true;
                    case_results.push(result);
                }
                CaseOutcome::CompileError => {
                    if compiled_once {
                        return Ok(system_error_result(task, "同一提交的编译结果不稳定"));
                    }
                    // 编译错误与测试点无关，补齐所有测试点以便 scorer 返回 CE，
                    // 而不是因缺少 case result 变成 SE。
                    case_results = runtime_config
                        .subtasks
                        .iter()
                        .flat_map(|item| item.cases.iter())
                        .map(|item| OiCaseResult {
                            input: item.input.clone(),
                            status: OiStatus::CompileError,
                            time_ms: Some(started.elapsed().as_millis() as u64),
                            memory_kb: None,
                        })
                        .collect();
                    break;
                }
            }
        }
        if case_results
            .iter()
            .any(|result| result.status == OiStatus::CompileError)
        {
            break;
        }
    }

    let evaluation = score_submission(runtime_config, &case_results)
        .map_err(|error| anyhow::anyhow!("OI 结果计分失败: {error}"))?;
    Ok(evaluation.to_judge_result(
        &task.submission_id,
        task.rejudge_seq,
        Some(started.elapsed().as_millis() as u64),
        None,
    ))
}

fn system_error_result(task: &JudgeTask, reason: &str) -> JudgeResult {
    // 详细原因只写 worker 日志；结果消息不把镜像、路径或内部错误泄露给用户。
    warn!(submission_id = %task.submission_id, reason, "OI 任务无法执行");
    crate::oi::OiEvaluation {
        status: OiStatus::SystemError,
        score: 0,
        subtasks: Vec::new(),
    }
    .to_judge_result(&task.submission_id, task.rejudge_seq, None, None)
}

fn index_files(entries: Vec<ZipEntry>) -> Result<HashMap<String, Vec<u8>>> {
    let mut files = HashMap::with_capacity(entries.len());
    for entry in entries {
        if entry.is_dir {
            continue;
        }
        if files.insert(entry.file_name.clone(), entry.data).is_some() {
            bail!("OI 支持包包含重复文件: {}", entry.file_name);
        }
    }
    Ok(files)
}

fn validate_references(config: &OiRuntimeConfig, files: &HashMap<String, Vec<u8>>) -> Result<()> {
    for subtask in &config.subtasks {
        for case in &subtask.cases {
            if !files.contains_key(&case.input) {
                bail!("OI 输入文件不存在: {}", case.input);
            }
            if !files.contains_key(&case.output) {
                bail!("OI 输出文件不存在: {}", case.output);
            }
        }
    }
    Ok(())
}

#[allow(clippy::too_many_arguments)]
async fn run_case(
    docker: &Docker,
    task: &JudgeTask,
    config: &OiRuntimeConfig,
    subtask_time_limit_ms: Option<u64>,
    subtask_memory_limit_mb: Option<u64>,
    case: &OiCase,
    input: &[u8],
    expected: &[u8],
    trusted_image: &str,
    cpu_limit_millicores: u64,
    instance_id: &str,
) -> Result<CaseOutcome> {
    let time_limit_ms = case
        .time_limit_ms
        .or(subtask_time_limit_ms)
        .unwrap_or(config.time_limit_ms)
        .max(1);
    let memory_limit_mb = case
        .memory_limit_mb
        .or(subtask_memory_limit_mb)
        .unwrap_or(config.memory_limit_mb)
        .clamp(1, 4096);

    let container_id = create_container(
        docker,
        trusted_image,
        memory_limit_mb,
        cpu_limit_millicores,
        instance_id,
    )
    .await?;
    let result = run_case_in_container(
        docker,
        &container_id,
        task,
        config,
        case,
        input,
        expected,
        time_limit_ms,
    )
    .await;
    if !remove_container_force(docker, &container_id).await {
        warn!(container_id = %container_id, "OI 测试点容器清理失败");
    }
    result
}

#[allow(clippy::too_many_arguments)]
async fn run_case_in_container(
    docker: &Docker,
    container_id: &str,
    task: &JudgeTask,
    config: &OiRuntimeConfig,
    case: &OiCase,
    input: &[u8],
    expected: &[u8],
    time_limit_ms: u64,
) -> Result<CaseOutcome> {
    let source_name = match task.language.as_str() {
        "c" => "main.c",
        "cpp" => "main.cpp",
        other => bail!("不支持的 OI 语言: {other}"),
    };
    inject_file_to_container(docker, container_id, source_name, task.code.as_bytes())
        .await
        .context("注入 OI 源码失败")?;

    let compiler = if task.language == "c" { "gcc" } else { "g++" };
    let standard = if task.language == "c" { "c17" } else { "c++20" };
    let compile = exec_without_stdin(
        docker,
        container_id,
        vec![
            compiler.to_string(),
            format!("-std={standard}"),
            "-O2".to_string(),
            "-pipe".to_string(),
            format!("/workspace/{source_name}"),
            "-o".to_string(),
            "/workspace/main".to_string(),
        ],
        COMPILE_TIMEOUT,
    )
    .await?;
    if compile.output.output_limited || compile.exit_code != 0 {
        return Ok(CaseOutcome::CompileError);
    }

    let started = Instant::now();
    let execution = exec_with_stdin(
        docker,
        container_id,
        vec!["/workspace/main".to_string()],
        input,
        Duration::from_millis(time_limit_ms),
    )
    .await?;
    let elapsed_ms = started.elapsed().as_millis() as u64;
    let status = if execution.output.output_limited {
        OiStatus::OutputLimitExceeded
    } else if execution.timed_out {
        OiStatus::TimeLimitExceeded
    } else if execution.oom_killed {
        OiStatus::MemoryLimitExceeded
    } else if execution.exit_code != 0 {
        OiStatus::RuntimeError
    } else if !check_output(config.checker.kind, expected, &execution.output.stdout) {
        OiStatus::WrongAnswer
    } else {
        OiStatus::Accepted
    };
    Ok(CaseOutcome::Result(OiCaseResult {
        input: case.input.clone(),
        status,
        time_ms: Some(elapsed_ms),
        memory_kb: None,
    }))
}

fn check_output(checker: OiCheckerType, expected: &[u8], actual: &[u8]) -> bool {
    match checker {
        OiCheckerType::Strict => expected == actual,
        // default 与常见 wcmp 语义一致：忽略空白的具体形式与末尾空白，保留 token
        // 的字节内容，避免 UTF-8 转换带来的替换字符误判。
        OiCheckerType::Default => tokens(expected).eq(tokens(actual)),
        OiCheckerType::Testlib => false,
    }
}

fn tokens(bytes: &[u8]) -> impl Iterator<Item = &[u8]> {
    bytes
        .split(|byte| byte.is_ascii_whitespace())
        .filter(|token| !token.is_empty())
}

async fn create_container(
    docker: &Docker,
    image: &str,
    memory_limit_mb: u64,
    cpu_limit_millicores: u64,
    instance_id: &str,
) -> Result<String> {
    let mut tmpfs = std::collections::HashMap::new();
    // /workspace 必须可执行，否则 gcc 生成的程序会被 noexec 挂载拒绝执行；
    // rootfs 仍为只读，/tmp 继续 noexec/nosuid/nodev。
    tmpfs.insert("/workspace", "size=512M,mode=1777,nosuid,nodev");
    tmpfs.insert("/tmp", "size=256M,mode=1777,noexec,nosuid,nodev");
    let memory_bytes = (memory_limit_mb.clamp(1, 4096) * 1024 * 1024) as i64;
    let host_config =
        build_host_config_with_cpu(memory_bytes, tmpfs, true, "none", cpu_limit_millicores);
    let body = ContainerCreateBody {
        image: Some(image.to_string()),
        cmd: Some(vec!["sleep".to_string(), "infinity".to_string()]),
        labels: Some(container_labels("oi", instance_id)),
        host_config: Some(host_config),
        working_dir: Some("/workspace".to_string()),
        user: Some(SANDBOX_USER.to_string()),
        ..Default::default()
    };
    let created = timeout(Duration::from_secs(30), docker.create_container(None, body))
        .await
        .context("创建 OI 容器超时")?
        .context("创建 OI 容器失败")?;
    if let Err(error) = timeout(
        Duration::from_secs(5),
        docker.start_container(&created.id, None),
    )
    .await
    .context("启动 OI 容器超时")
    .and_then(|result| result.context("启动 OI 容器失败"))
    {
        let _ = remove_container_force(docker, &created.id).await;
        return Err(error);
    }
    info!(container_id = %created.id, "OI 测试点容器已启动");
    Ok(created.id)
}

async fn exec_without_stdin(
    docker: &Docker,
    container_id: &str,
    cmd: Vec<String>,
    limit: Duration,
) -> Result<ExecOutcome> {
    let exec = timeout(
        EXEC_CREATE_TIMEOUT,
        docker.create_exec(
            container_id,
            ExecConfig {
                cmd: Some(cmd),
                attach_stdout: Some(true),
                attach_stderr: Some(true),
                user: Some(SANDBOX_USER.to_string()),
                working_dir: Some("/workspace".to_string()),
                ..Default::default()
            },
        ),
    )
    .await
    .context("创建 OI exec 超时")?
    .context("创建 OI exec 失败")?;
    let started = timeout(EXEC_START_TIMEOUT, docker.start_exec(&exec.id, None))
        .await
        .context("启动 OI exec 超时")?
        .context("启动 OI exec 失败")?;
    let output = match started {
        StartExecResults::Attached { output, .. } => output,
        StartExecResults::Detached => bail!("OI exec 意外进入 detached 模式"),
    };
    let captured = timeout(limit, collect_output(output))
        .await
        .map_err(|_| anyhow::anyhow!("OI exec 超时"))??;
    let exit_code = inspect_exec_exit(docker, &exec.id).await?;
    Ok(ExecOutcome {
        output: captured,
        exit_code,
    })
}

struct RunOutcome {
    output: CapturedOutput,
    exit_code: i64,
    oom_killed: bool,
    timed_out: bool,
}

async fn exec_with_stdin(
    docker: &Docker,
    container_id: &str,
    cmd: Vec<String>,
    input: &[u8],
    limit: Duration,
) -> Result<RunOutcome> {
    let exec = timeout(
        EXEC_CREATE_TIMEOUT,
        docker.create_exec(
            container_id,
            ExecConfig {
                cmd: Some(cmd),
                attach_stdin: Some(true),
                attach_stdout: Some(true),
                attach_stderr: Some(true),
                user: Some(SANDBOX_USER.to_string()),
                working_dir: Some("/workspace".to_string()),
                ..Default::default()
            },
        ),
    )
    .await
    .context("创建 OI 运行 exec 超时")?
    .context("创建 OI 运行 exec 失败")?;
    let started = timeout(EXEC_START_TIMEOUT, docker.start_exec(&exec.id, None))
        .await
        .context("启动 OI 运行 exec 超时")?
        .context("启动 OI 运行 exec 失败")?;
    let (output, mut input_writer) = match started {
        StartExecResults::Attached { output, input } => (output, input),
        StartExecResults::Detached => bail!("OI 运行 exec 意外进入 detached 模式"),
    };
    let output_task = tokio::spawn(collect_output(output));
    let write_result = timeout(INPUT_WRITE_TIMEOUT, async {
        input_writer
            .write_all(input)
            .await
            .context("写入 OI 测试输入失败")?;
        input_writer
            .shutdown()
            .await
            .context("关闭 OI 测试输入失败")?;
        Ok::<(), anyhow::Error>(())
    })
    .await;
    if let Ok(Err(error)) = write_result {
        let _ = docker.kill_container(container_id, None).await;
        output_task.abort();
        return Err(error);
    }
    if write_result.is_err() {
        let _ = docker.kill_container(container_id, None).await;
        output_task.abort();
        return Ok(RunOutcome {
            output: CapturedOutput {
                stdout: Vec::new(),
                stderr: Vec::new(),
                output_limited: false,
            },
            exit_code: -1,
            oom_killed: false,
            timed_out: true,
        });
    }

    let mut output_task = output_task;
    let captured = match timeout(limit, &mut output_task).await {
        Ok(joined) => joined.context("读取 OI 程序输出任务失败")??,
        Err(_) => {
            let _ = docker.kill_container(container_id, None).await;
            output_task.abort();
            return Ok(RunOutcome {
                output: CapturedOutput {
                    stdout: Vec::new(),
                    stderr: Vec::new(),
                    output_limited: false,
                },
                exit_code: -1,
                oom_killed: inspect_oom(docker, container_id).await,
                timed_out: true,
            });
        }
    };
    if captured.output_limited {
        let _ = docker.kill_container(container_id, None).await;
        return Ok(RunOutcome {
            output: captured,
            exit_code: -1,
            oom_killed: inspect_oom(docker, container_id).await,
            timed_out: false,
        });
    }
    let exit_code = inspect_exec_exit(docker, &exec.id).await?;
    let oom_killed = inspect_oom(docker, container_id).await;
    Ok(RunOutcome {
        output: captured,
        exit_code,
        oom_killed,
        timed_out: false,
    })
}

async fn collect_output(mut output: OutputStream) -> Result<CapturedOutput> {
    let mut captured = CapturedOutput {
        stdout: Vec::new(),
        stderr: Vec::new(),
        output_limited: false,
    };
    let mut total_output = 0usize;
    while let Some(chunk) = output.next().await {
        let chunk = chunk.context("读取 OI exec 输出失败")?;
        let (target, message) = match chunk {
            LogOutput::StdOut { message } | LogOutput::Console { message } => {
                (&mut captured.stdout, message)
            }
            LogOutput::StdErr { message } => (&mut captured.stderr, message),
            LogOutput::StdIn { message } => (&mut captured.stderr, message),
        };
        if total_output.saturating_add(message.len()) > MAX_OUTPUT_BYTES {
            captured.output_limited = true;
            return Ok(captured);
        }
        total_output += message.len();
        target.extend_from_slice(&message);
    }
    Ok(captured)
}

async fn inspect_exec_exit(docker: &Docker, exec_id: &str) -> Result<i64> {
    for _ in 0..EXEC_INSPECT_ATTEMPTS {
        let inspection = timeout(EXEC_INSPECT_TIMEOUT, docker.inspect_exec(exec_id))
            .await
            .context("查询 OI exec 状态超时")?
            .context("查询 OI exec 状态失败")?;
        if inspection.running == Some(false) {
            return Ok(inspection.exit_code.unwrap_or(-1));
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    bail!("OI exec 未在状态查询窗口内退出")
}

async fn inspect_oom(docker: &Docker, container_id: &str) -> bool {
    docker
        .inspect_container(container_id, None)
        .await
        .ok()
        .and_then(|info| info.state)
        .and_then(|state| state.oom_killed)
        .unwrap_or(false)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_checker_ignores_whitespace() {
        assert!(check_output(
            OiCheckerType::Default,
            b"1  2\n3\n",
            b"1\t2 3 \n"
        ));
        assert!(!check_output(OiCheckerType::Default, b"1 2", b"1 3"));
    }

    #[test]
    fn strict_checker_compares_bytes() {
        assert!(check_output(OiCheckerType::Strict, b"ok\n", b"ok\n"));
        assert!(!check_output(OiCheckerType::Strict, b"ok\n", b"ok"));
    }
}
