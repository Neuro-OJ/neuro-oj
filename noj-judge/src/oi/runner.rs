//! 传统 OI 题的原生 C/C++ 执行器。
//!
//! OI 任务使用固定的受信编译镜像；题包中的输入/输出文件只在 judge 进程中
//! 读取，用户代码不会获得题包目录。每个测试点使用一次性容器，因此一个测试点
//! 不能通过文件、环境变量或进程状态影响后续测试点。

use std::collections::{HashMap, HashSet};
use std::path::Path;
use std::pin::Pin;
use std::time::{Duration, Instant};

use anyhow::{bail, Context, Result};
use bollard::container::LogOutput;
use bollard::exec::StartExecResults;
use bollard::models::{ContainerCreateBody, ExecConfig};
use bollard::Docker;
use futures_util::future::join_all;
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
const MAX_OUTPUT_BYTES: usize = 32 * 1024 * 1024;
/// 用户源码上限。题包和 MQ 已有大小限制，judge 侧仍保留最后一道边界。
const MAX_SOURCE_BYTES: usize = 4 * 1024 * 1024;
/// 编译不计入题目运行时限，但必须有独立上限，避免编译器被卡死。
const COMPILE_TIMEOUT: Duration = Duration::from_secs(10);
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
    NeedsChecker {
        result: OiCaseResult,
        output: Vec<u8>,
    },
    CompileError,
    SystemError,
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
    resource_lease_client: Option<&redis::Client>,
) -> Result<JudgeResult> {
    let runtime_config = task
        .runtime_config
        .as_oi()
        .context("OI runner 收到非 OI runtime_config")?;
    if task.judge_type != "oi" {
        bail!("OI runner 收到不匹配的 judge_type: {}", task.judge_type);
    }
    if task.code.len() > MAX_SOURCE_BYTES {
        return Ok(system_error_result(task, "提交源码超过 OI runner 限制"));
    }
    if !runtime_config.languages.iter().any(|language| {
        matches!(
            (language, task.language.as_str()),
            (crate::oi::OiLanguage::C, "c") | (crate::oi::OiLanguage::Cpp, "cc")
        )
    }) {
        return Ok(system_error_result(
            task,
            "提交语言不在题目允许的语言列表中",
        ));
    }
    let entries = extract_zip_entries_from_file(support_package).context("读取 OI 支持包失败")?;
    let files = index_files(entries)?;
    validate_references(runtime_config, &files)?;
    let checker_source = if runtime_config.checker.kind == OiCheckerType::Testlib {
        Some(
            files
                .get(runtime_config.checker.path.as_deref().unwrap_or_default())
                .context("testlib checker 文件索引丢失")?,
        )
    } else {
        None
    };

    // 生产节点配置 go-judge 时，编译和运行统一交给专用评测服务；未配置时
    // 保留本地 Docker 路径供开发和离线测试使用。两条路径都使用同一份 OI
    // scorer，避免服务端状态码与本地状态码分叉。
    if runtime_config.backend == OiBackend::Native {
        if let Some(client) = crate::oi::go_judge::GoJudgeClient::from_env()? {
            let lease_config = resource_lease_client
                .map(|client| {
                    crate::oi::resource_lease::ResourceLeaseConfig::from_client(client.clone())
                })
                .transpose()?;
            return match evaluate_native_go_judge(
                &client,
                task,
                runtime_config,
                &files,
                lease_config.as_ref(),
            )
            .await
            {
                Ok(result) => Ok(result),
                Err(error) => {
                    warn!(
                        submission_id = %task.submission_id,
                        error = %error,
                        "go-judge OI 任务失败，归因为 SE"
                    );
                    Ok(system_error_result(task, "go-judge OI 评测失败"))
                }
            };
        }
    }

    if runtime_config.backend == OiBackend::Wasm {
        let profile = task
            .oi_cost_profile
            .as_ref()
            .ok_or_else(|| anyhow::anyhow!("WASM 任务缺少可信成本表"))?;
        let cases = runtime_config
            .subtasks
            .iter()
            .flat_map(|subtask| subtask.cases.iter())
            .map(|case| {
                Ok::<_, anyhow::Error>((
                    case.input.clone(),
                    files
                        .get(&case.input)
                        .context("WASM 输入文件索引丢失")?
                        .clone(),
                    files
                        .get(&case.output)
                        .context("WASM 输出文件索引丢失")?
                        .clone(),
                ))
            })
            .collect::<Result<Vec<_>>>()?;
        return crate::oi::wasm::evaluate_wasm(
            task,
            runtime_config,
            &cases,
            profile,
            checker_source.map(|source| source.as_slice()),
            &selected_user_runtime_files(runtime_config, &files),
            &selected_checker_compile_files(runtime_config, &files),
            &selected_user_compile_files(runtime_config, &files),
        )
        .await;
    }

    let started = Instant::now();
    let mut case_results = Vec::new();
    let order = crate::oi::subtask_execution_order(runtime_config)
        .map_err(|error| anyhow::anyhow!("OI 子任务依赖无效: {error}"))?;
    let mut passed = HashSet::new();
    let mut failed = HashSet::new();
    for subtask_index in order {
        let subtask = &runtime_config.subtasks[subtask_index];
        if subtask
            .depends_on
            .iter()
            .any(|dependency| failed.contains(dependency.as_str()))
        {
            // 依赖失败的子任务不启动任何测试点；scorer 会将其记录为 IGN，
            // 同时避免把被跳过测试点的资源消耗计入总评测时间。
            failed.insert(subtask.id.as_str());
            continue;
        }
        let mut subtask_passed = true;
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
                &files,
                checker_source.map(|source| source.as_slice()),
                trusted_image,
                cpu_limit_millicores,
                instance_id,
            )
            .await?;
            match outcome {
                CaseOutcome::Result(result) => {
                    let case_failed = result.status != OiStatus::Accepted;
                    case_results.push(result);
                    if case_failed {
                        subtask_passed = false;
                        break;
                    }
                }
                CaseOutcome::CompileError => {
                    // 编译错误与测试点无关，补齐所有测试点以便 scorer 返回 CE，
                    // 而不是因缺少 case result 变成 SE。
                    case_results = runtime_config
                        .subtasks
                        .iter()
                        .flat_map(|item| item.cases.iter())
                        .map(|item| OiCaseResult {
                            case_id: Some(item.input.clone()),
                            input: item.input.clone(),
                            status: OiStatus::CompileError,
                            time_ms: Some(started.elapsed().as_millis() as u64),
                            memory_kb: None,
                            cpu_time_ms: None,
                            wall_time_ms: None,
                            equivalent_time_ms: None,
                        })
                        .collect();
                    break;
                }
                CaseOutcome::SystemError => {
                    return Ok(system_error_result(task, "OI checker 执行失败"))
                }
                CaseOutcome::NeedsChecker { .. } => {
                    return Ok(system_error_result(task, "testlib checker 未完成隔离执行"))
                }
            }
        }
        if subtask_passed {
            passed.insert(subtask.id.as_str());
        } else {
            failed.insert(subtask.id.as_str());
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

async fn evaluate_native_go_judge(
    client: &crate::oi::go_judge::GoJudgeClient,
    task: &JudgeTask,
    config: &OiRuntimeConfig,
    files: &HashMap<String, Vec<u8>>,
    lease_config: Option<&crate::oi::resource_lease::ResourceLeaseConfig>,
) -> Result<JudgeResult> {
    let started = Instant::now();
    let user_compile_files = selected_user_compile_files(config, files);
    let user_runtime_files = selected_user_runtime_files(config, files);
    let checker_compile_files = selected_checker_compile_files(config, files);
    let compile_response = client
        .run(crate::oi::go_judge::command_for_compile(
            &task.language,
            &task.code,
            &user_compile_files,
        )?)
        .await?;
    let Some(executable_file_id) = crate::oi::go_judge::cached_file_id(&compile_response, "main")
    else {
        if compile_response_is_infrastructure_error(&compile_response) {
            return Ok(system_error_result(task, "go-judge 编译沙箱失败"));
        }
        return uniform_oi_status_result(task, config, OiStatus::CompileError);
    };
    let checker_source = if config.checker.kind == OiCheckerType::Testlib {
        Some(
            files
                .get(config.checker.path.as_deref().unwrap_or_default())
                .context("go-judge testlib checker 文件索引丢失")?,
        )
    } else {
        None
    };
    let checker_file_id: Option<String> = if let Some(source) = checker_source {
        let checker_response = client
            .run(crate::oi::go_judge::command_for_checker_compile(
                source,
                &checker_compile_files,
            ))
            .await?;
        Some(
            crate::oi::go_judge::cached_file_id(&checker_response, "checker")
                .map(str::to_owned)
                .ok_or_else(|| anyhow::anyhow!("go-judge testlib checker 编译失败"))?,
        )
    } else {
        None
    };
    let mut case_results = Vec::new();
    let mut pending: HashSet<usize> = (0..config.subtasks.len()).collect();
    let mut passed = HashSet::new();
    let mut failed = HashSet::new();
    while !pending.is_empty() {
        let mut runnable = Vec::new();
        let mut skipped = Vec::new();
        for &index in &pending {
            let subtask = &config.subtasks[index];
            if subtask
                .depends_on
                .iter()
                .any(|dependency| failed.contains(dependency.as_str()))
            {
                skipped.push(index);
            } else if subtask
                .depends_on
                .iter()
                .all(|dependency| passed.contains(dependency.as_str()))
            {
                runnable.push(index);
            }
        }
        for index in skipped {
            pending.remove(&index);
            failed.insert(config.subtasks[index].id.as_str());
        }
        if runnable.is_empty() {
            if pending.is_empty() {
                break;
            }
            return Err(anyhow::anyhow!("OI 子任务依赖无法调度"));
        }
        runnable.sort_unstable();
        let batch = runnable.into_iter().take(2).collect::<Vec<_>>();
        for index in &batch {
            pending.remove(index);
        }
        let runs = join_all(batch.iter().map(|&index| {
            run_go_judge_subtask(
                client,
                config,
                index,
                executable_file_id,
                checker_file_id.as_deref(),
                files,
                &user_runtime_files,
                &checker_compile_files,
                lease_config,
                &task.submission_id,
            )
        }))
        .await;
        for (index, run) in batch.into_iter().zip(runs) {
            let (subtask_passed, results) = run?;
            case_results.extend(results);
            if subtask_passed {
                passed.insert(config.subtasks[index].id.as_str());
            } else {
                failed.insert(config.subtasks[index].id.as_str());
            }
        }
    }
    let evaluation = score_submission(config, &case_results)
        .map_err(|error| anyhow::anyhow!("OI 结果计分失败: {error}"))?;
    Ok(evaluation.to_judge_result(
        &task.submission_id,
        task.rejudge_seq,
        Some(started.elapsed().as_millis() as u64),
        case_results.iter().filter_map(|case| case.memory_kb).max(),
    ))
}

#[allow(clippy::too_many_arguments)]
async fn run_go_judge_subtask(
    client: &crate::oi::go_judge::GoJudgeClient,
    config: &OiRuntimeConfig,
    subtask_index: usize,
    executable_file_id: &str,
    checker_file_id: Option<&str>,
    files: &HashMap<String, Vec<u8>>,
    user_runtime_files: &HashMap<String, Vec<u8>>,
    checker_extra_files: &HashMap<String, Vec<u8>>,
    lease_config: Option<&crate::oi::resource_lease::ResourceLeaseConfig>,
    owner: &str,
) -> Result<(bool, Vec<OiCaseResult>)> {
    let lease = match lease_config {
        Some(config) => {
            Some(crate::oi::resource_lease::ResourceLease::acquire(config, owner).await?)
        }
        None => None,
    };
    let result = run_go_judge_subtask_inner(
        client,
        config,
        subtask_index,
        executable_file_id,
        checker_file_id,
        files,
        user_runtime_files,
        checker_extra_files,
    )
    .await;
    if let Some(lease) = lease {
        lease.release().await;
    }
    result
}

#[allow(clippy::too_many_arguments)]
async fn run_go_judge_subtask_inner(
    client: &crate::oi::go_judge::GoJudgeClient,
    config: &OiRuntimeConfig,
    subtask_index: usize,
    executable_file_id: &str,
    checker_file_id: Option<&str>,
    files: &HashMap<String, Vec<u8>>,
    user_runtime_files: &HashMap<String, Vec<u8>>,
    checker_extra_files: &HashMap<String, Vec<u8>>,
) -> Result<(bool, Vec<OiCaseResult>)> {
    let subtask = &config.subtasks[subtask_index];
    let mut passed = true;
    let mut results = Vec::with_capacity(subtask.cases.len());
    for case in &subtask.cases {
        let time_limit_ms = case
            .time_limit_ms
            .or(subtask.time_limit_ms)
            .unwrap_or(config.time_limit_ms)
            .max(1);
        let memory_limit_mb = case
            .memory_limit_mb
            .or(subtask.memory_limit_mb)
            .unwrap_or(config.memory_limit_mb)
            .clamp(1, 512);
        let input = files
            .get(&case.input)
            .context("go-judge 输入文件索引丢失")?;
        let expected = files
            .get(&case.output)
            .context("go-judge 输出文件索引丢失")?;
        let command = crate::oi::go_judge::command_for_compiled_case(
            executable_file_id,
            input,
            time_limit_ms,
            memory_limit_mb,
            user_runtime_files,
            config.filename.as_deref(),
        )?;
        let response = client.run(command).await?;
        let stdout = response
            .files
            .get("stdout")
            .map(|file| file.content().as_bytes())
            .unwrap_or_default();
        let (actual, missing_file_output) = if let Some(filename) = config.filename.as_deref() {
            let name = format!("{filename}.out");
            match response.files.get(&name) {
                Some(file) => (file.content().as_bytes(), false),
                None => (&[][..], true),
            }
        } else {
            (stdout, false)
        };
        let mut status = if config.checker.kind == OiCheckerType::Testlib {
            crate::oi::go_judge::map_status(&response, expected, actual, |_, _| true)
        } else {
            crate::oi::go_judge::map_status(&response, expected, actual, |expected, actual| {
                check_output(config.checker.kind, expected, actual)
            })
        };
        // 资源/运行状态优先；只有程序正常结束且没有生成约定文件时才是 FE。
        if missing_file_output && status == OiStatus::Accepted {
            status = OiStatus::FormatError;
        }
        if config.checker.kind == OiCheckerType::Testlib && status == OiStatus::Accepted {
            let checker_file_id =
                checker_file_id.context("go-judge testlib checker 文件索引丢失")?;
            let checker = crate::oi::go_judge::command_for_compiled_checker(
                checker_file_id,
                input,
                expected,
                actual,
                time_limit_ms,
                memory_limit_mb,
                checker_extra_files,
            );
            let checker_response = client.run(checker).await?;
            status = crate::oi::go_judge::map_testlib_status(&checker_response);
        }
        let wall_time_ms = response.clock_time.map(|ns| ns / 1_000_000);
        let cpu_time_ms = response.time.map(|ns| ns / 1_000_000);
        results.push(OiCaseResult {
            case_id: Some(case.input.clone()),
            input: case.input.clone(),
            status,
            time_ms: cpu_time_ms.or(wall_time_ms),
            memory_kb: response.memory.map(|bytes| bytes / 1024),
            cpu_time_ms,
            wall_time_ms,
            equivalent_time_ms: cpu_time_ms,
        });
        if status != OiStatus::Accepted {
            passed = false;
            break;
        }
    }
    Ok((passed, results))
}

fn compile_response_is_infrastructure_error(
    response: &crate::oi::go_judge::GoJudgeResponse,
) -> bool {
    let status = response
        .status
        .as_deref()
        .unwrap_or_default()
        .to_ascii_lowercase();
    if status.is_empty() {
        return true;
    }
    if status == "accepted"
        && response.exit_status.unwrap_or_default() == 0
        && !response.file_ids.contains_key("main")
    {
        return true;
    }
    matches!(
        status.as_str(),
        "file error"
            | "file_error"
            | "internal error"
            | "internal_error"
            | "system error"
            | "system_error"
    )
}

fn uniform_oi_status_result(
    task: &JudgeTask,
    config: &OiRuntimeConfig,
    status: OiStatus,
) -> Result<JudgeResult> {
    let case_results = config
        .subtasks
        .iter()
        .flat_map(|subtask| subtask.cases.iter())
        .map(|case| OiCaseResult {
            case_id: Some(case.input.clone()),
            input: case.input.clone(),
            status,
            time_ms: None,
            memory_kb: None,
            cpu_time_ms: None,
            wall_time_ms: None,
            equivalent_time_ms: None,
        })
        .collect::<Vec<_>>();
    let evaluation = score_submission(config, &case_results)
        .map_err(|error| anyhow::anyhow!("OI 结果计分失败: {error}"))?;
    Ok(evaluation.to_judge_result(&task.submission_id, task.rejudge_seq, None, None))
}

pub(crate) fn system_error_result(task: &JudgeTask, reason: &str) -> JudgeResult {
    // 详细原因只写 worker 日志；结果消息不把镜像、路径或内部错误泄露给用户。
    warn!(submission_id = %task.submission_id, reason, "OI 任务无法执行");
    if let Some(config) = task.runtime_config.as_oi() {
        let case_results = config
            .subtasks
            .iter()
            .flat_map(|subtask| subtask.cases.iter())
            .map(|case| OiCaseResult {
                case_id: Some(case.input.clone()),
                input: case.input.clone(),
                status: OiStatus::SystemError,
                time_ms: None,
                memory_kb: None,
                cpu_time_ms: None,
                wall_time_ms: None,
                equivalent_time_ms: None,
            })
            .collect::<Vec<_>>();
        if let Ok(evaluation) = score_submission(config, &case_results) {
            return evaluation.to_judge_result(&task.submission_id, task.rejudge_seq, None, None);
        }
    }
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
    if config.checker.kind == OiCheckerType::Testlib {
        let path = config
            .checker
            .path
            .as_deref()
            .context("testlib checker 缺少路径")?;
        if !files.contains_key(path) {
            bail!("OI testlib checker 文件不存在: {path}");
        }
    }
    for path in config
        .compile_extra_files
        .iter()
        .chain(config.checker_extra_files.iter())
        .chain(config.user_extra_files.iter())
    {
        if !files.contains_key(path) {
            bail!("OI extra file 不存在: {path}");
        }
    }
    Ok(())
}

fn user_compile_file_paths(config: &OiRuntimeConfig) -> Vec<&str> {
    let mut seen = HashSet::new();
    config
        .compile_extra_files
        .iter()
        .chain(config.user_extra_files.iter())
        .filter_map(|path| seen.insert(path.as_str()).then_some(path.as_str()))
        .collect()
}

fn selected_user_compile_files(
    config: &OiRuntimeConfig,
    files: &HashMap<String, Vec<u8>>,
) -> HashMap<String, Vec<u8>> {
    let paths = user_compile_file_paths(config);
    selected_extra_files_from_paths(paths, files)
}

fn selected_user_runtime_files(
    config: &OiRuntimeConfig,
    files: &HashMap<String, Vec<u8>>,
) -> HashMap<String, Vec<u8>> {
    selected_extra_files_from_paths(config.user_extra_files.iter().map(String::as_str), files)
}

fn selected_checker_compile_files(
    config: &OiRuntimeConfig,
    files: &HashMap<String, Vec<u8>>,
) -> HashMap<String, Vec<u8>> {
    let mut seen = HashSet::new();
    let paths = config
        .compile_extra_files
        .iter()
        .chain(config.checker_extra_files.iter())
        .filter_map(|path| seen.insert(path.as_str()).then_some(path.as_str()))
        .collect::<Vec<_>>();
    selected_extra_files_from_paths(paths, files)
}

fn selected_extra_files_from_paths<'a>(
    paths: impl IntoIterator<Item = &'a str>,
    files: &HashMap<String, Vec<u8>>,
) -> HashMap<String, Vec<u8>> {
    let mut selected = HashMap::new();
    // 保留题包原路径，便于题目显式 include `testdata/foo.h`；Hydro 同时把
    // checker_extra_files/user_extra_files 按 basename 注入工作目录，兼容常见
    // `#include "foo.h"` 写法。先写完整路径，再补 basename，避免一个真实的
    // 根级文件被嵌套文件的别名覆盖。
    let paths = paths.into_iter().collect::<Vec<_>>();
    for path in &paths {
        if let Some(data) = files.get(*path) {
            selected.insert((*path).to_string(), data.clone());
        }
    }
    for path in paths {
        let Some(name) = path.rsplit('/').next() else {
            continue;
        };
        if name != path && !selected.contains_key(name) {
            if let Some(data) = files.get(path) {
                selected.insert(name.to_string(), data.clone());
            }
        }
    }
    selected
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
    files: &HashMap<String, Vec<u8>>,
    checker_source: Option<&[u8]>,
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
        .clamp(1, 512);

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
        files,
        time_limit_ms,
    )
    .await;
    if !remove_container_force(docker, &container_id).await {
        warn!(container_id = %container_id, "OI 测试点容器清理失败");
    }
    match result? {
        CaseOutcome::NeedsChecker { mut result, output } => {
            let Some(checker_source) = checker_source else {
                return Ok(CaseOutcome::SystemError);
            };
            result.status = run_checker(
                docker,
                trusted_image,
                memory_limit_mb,
                cpu_limit_millicores,
                instance_id,
                config,
                checker_source,
                input,
                expected,
                &output,
                files,
                time_limit_ms,
            )
            .await
            .unwrap_or_else(|error| {
                warn!(error = %error, "testlib checker 容器执行失败");
                OiStatus::SystemError
            });
            Ok(CaseOutcome::Result(result))
        }
        other => Ok(other),
    }
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
    files: &HashMap<String, Vec<u8>>,
    time_limit_ms: u64,
) -> Result<CaseOutcome> {
    let source_name = match task.language.as_str() {
        "c" => "main.c",
        "cc" => "main.cpp",
        other => bail!("不支持的 OI 语言: {other}"),
    };
    let file_io = file_io_names(config.filename.as_deref())?;
    // `compile_extra_files` 只在用户编译阶段可见；`user_extra_files` 同时
    // 在编译和运行阶段可见。先注入编译集合，编译成功后删除编译专用文件，
    // 避免本地 Docker 回退路径与 go-judge/WASM 的文件范围不一致。
    let user_compile_files = selected_user_compile_files(config, files);
    let user_runtime_files = selected_user_runtime_files(config, files);
    for (path, data) in &user_compile_files {
        inject_file_to_container(docker, container_id, path, data)
            .await
            .context("注入 OI extra file 失败")?;
    }
    if let Some((input_name, _)) = &file_io {
        inject_file_to_container(docker, container_id, input_name, input)
            .await
            .context("注入 OI 文件输入失败")?;
    }
    inject_file_to_container(docker, container_id, source_name, task.code.as_bytes())
        .await
        .context("注入 OI 源码失败")?;

    let compiler = if task.language == "c" { "gcc" } else { "g++" };
    let standard = if task.language == "c" { "c99" } else { "c++11" };
    let compile = match exec_without_stdin(
        docker,
        container_id,
        vec![
            compiler.to_string(),
            format!("-std={standard}"),
            "-O2".to_string(),
            "-Wall".to_string(),
            "-pipe".to_string(),
            format!("/workspace/{source_name}"),
            "-o".to_string(),
            "/workspace/main".to_string(),
        ],
        COMPILE_TIMEOUT,
    )
    .await
    {
        Ok(result) => result,
        Err(error) if error.to_string().contains("超时") => {
            return Ok(CaseOutcome::CompileError);
        }
        Err(error) => return Err(error),
    };
    if compile.output.output_limited || compile.exit_code != 0 {
        return Ok(CaseOutcome::CompileError);
    }
    for path in user_compile_files.keys() {
        if user_runtime_files.contains_key(path) {
            continue;
        }
        let removed = exec_without_stdin(
            docker,
            container_id,
            vec![
                "rm".to_string(),
                "-f".to_string(),
                "--".to_string(),
                format!("/workspace/{path}"),
            ],
            Duration::from_secs(5),
        )
        .await
        .context("清理 OI 编译专用 extra file 失败")?;
        if removed.exit_code != 0 {
            bail!("清理 OI 编译专用 extra file 失败: {path}");
        }
    }

    let started = Instant::now();
    let execution = exec_with_stdin(
        docker,
        container_id,
        vec!["/workspace/main".to_string()],
        if file_io.is_some() { &[] } else { input },
        Duration::from_millis(time_limit_ms),
    )
    .await?;
    let elapsed_ms = started.elapsed().as_millis() as u64;
    let mut file_output_limited = false;
    let mut file_output_error = false;
    let actual_output = if let Some((_, output_name)) = &file_io {
        if execution.output.output_limited || execution.timed_out || execution.oom_killed {
            Vec::new()
        } else {
            let output = exec_without_stdin(
                docker,
                container_id,
                vec!["cat".to_string(), format!("/workspace/{output_name}")],
                Duration::from_secs(10),
            )
            .await?;
            file_output_limited = output.output.output_limited;
            file_output_error = output.exit_code != 0;
            output.output.stdout
        }
    } else {
        execution.output.stdout.clone()
    };
    let status = if execution.output.output_limited || file_output_limited {
        OiStatus::OutputLimitExceeded
    } else if execution.timed_out {
        OiStatus::TimeLimitExceeded
    } else if execution.oom_killed {
        OiStatus::MemoryLimitExceeded
    } else if file_output_error {
        // 文件输入题未生成约定的 `<filename>.out`，属于传统 OI 的格式错误；
        // 用户程序本身以非零码退出才归为运行时错误。
        OiStatus::FormatError
    } else if execution.exit_code != 0 {
        OiStatus::RuntimeError
    } else if config.checker.kind != OiCheckerType::Testlib
        && !check_output(config.checker.kind, expected, &actual_output)
    {
        OiStatus::WrongAnswer
    } else {
        OiStatus::Accepted
    };
    let result = OiCaseResult {
        case_id: Some(case.input.clone()),
        input: case.input.clone(),
        status,
        time_ms: Some(elapsed_ms),
        memory_kb: None,
        cpu_time_ms: None,
        wall_time_ms: Some(elapsed_ms),
        equivalent_time_ms: Some(elapsed_ms),
    };
    if config.checker.kind == OiCheckerType::Testlib && result.status == OiStatus::Accepted {
        Ok(CaseOutcome::NeedsChecker {
            result,
            output: actual_output,
        })
    } else {
        Ok(CaseOutcome::Result(result))
    }
}

fn file_io_names(filename: Option<&str>) -> Result<Option<(String, String)>> {
    let Some(filename) = filename else {
        return Ok(None);
    };
    if filename.is_empty()
        || filename.len() > 64
        || !filename
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_' || byte == b'-')
    {
        bail!("OI filename 含非法字符");
    }
    Ok(Some((format!("{filename}.in"), format!("{filename}.out"))))
}

#[allow(clippy::too_many_arguments)]
async fn run_checker(
    docker: &Docker,
    trusted_image: &str,
    memory_limit_mb: u64,
    cpu_limit_millicores: u64,
    instance_id: &str,
    config: &OiRuntimeConfig,
    checker_source: &[u8],
    input: &[u8],
    expected: &[u8],
    actual: &[u8],
    files: &HashMap<String, Vec<u8>>,
    time_limit_ms: u64,
) -> Result<OiStatus> {
    // checker 在与用户程序完全不同的一次性容器中运行。即使用户程序创建了
    // 后台进程，也无法修改 checker 的源码、答案或用户输出文件。
    let container_id = create_container(
        docker,
        trusted_image,
        memory_limit_mb,
        cpu_limit_millicores,
        instance_id,
    )
    .await?;
    let result = async {
        for (path, data) in selected_checker_compile_files(config, files) {
            inject_file_to_container(docker, &container_id, &path, &data)
                .await
                .context("注入 checker extra file 失败")?;
        }
        inject_file_to_container(docker, &container_id, "checker.cpp", checker_source)
            .await
            .context("注入 testlib checker 失败")?;
        inject_file_to_container(docker, &container_id, "checker.in", input)
            .await
            .context("注入 testlib 输入失败")?;
        inject_file_to_container(docker, &container_id, "checker.ans", expected)
            .await
            .context("注入 testlib 标准答案失败")?;
        inject_file_to_container(docker, &container_id, "checker.out", actual)
            .await
            .context("注入 testlib 用户输出失败")?;
        let checker_compile = exec_without_stdin(
            docker,
            &container_id,
            vec![
                "g++".to_string(),
                "-std=c++11".to_string(),
                "-O2".to_string(),
                "-Wall".to_string(),
                "-pipe".to_string(),
                "-I".to_string(),
                "/workspace".to_string(),
                "/workspace/checker.cpp".to_string(),
                "-o".to_string(),
                "/workspace/checker".to_string(),
            ],
            COMPILE_TIMEOUT,
        )
        .await?;
        if checker_compile.output.output_limited || checker_compile.exit_code != 0 {
            return Ok(OiStatus::SystemError);
        }
        let checker = exec_without_stdin(
            docker,
            &container_id,
            vec![
                "/workspace/checker".to_string(),
                "/workspace/checker.in".to_string(),
                "/workspace/checker.out".to_string(),
                "/workspace/checker.ans".to_string(),
            ],
            Duration::from_millis(time_limit_ms.max(1)),
        )
        .await?;
        if checker.output.output_limited {
            Ok(OiStatus::SystemError)
        } else if checker.exit_code == 0 {
            Ok(OiStatus::Accepted)
        } else if checker.exit_code < 0 {
            Ok(OiStatus::SystemError)
        } else {
            Ok(OiStatus::WrongAnswer)
        }
    }
    .await;
    if !remove_container_force(docker, &container_id).await {
        warn!(container_id = %container_id, "testlib checker 容器清理失败");
    }
    result
}

pub(crate) fn check_output(checker: OiCheckerType, expected: &[u8], actual: &[u8]) -> bool {
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
    let memory_bytes = (memory_limit_mb.clamp(1, 512) * 1024 * 1024) as i64;
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
    use serde_json::json;

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

    #[test]
    fn checker_extra_files_are_not_injected_into_user_compile() {
        let config: OiRuntimeConfig = serde_json::from_value(json!({
            "backend": "native",
            "languages": ["cc"],
            "time_limit_ms": 1000,
            "memory_limit_mb": 256,
            "checker": { "type": "testlib", "path": "checker.cpp" },
            "compile_extra_files": ["common.h"],
            "checker_extra_files": ["judge.h"],
            "user_extra_files": ["user.h"],
            "subtasks": [{
                "id": "all",
                "score": 100,
                "cases": [{ "input": "1.in", "output": "1.out" }]
            }]
        }))
        .unwrap();
        let files = HashMap::from([
            ("common.h".to_string(), b"common".to_vec()),
            ("judge.h".to_string(), b"judge".to_vec()),
            ("user.h".to_string(), b"user".to_vec()),
        ]);
        let user = selected_user_compile_files(&config, &files);
        let checker = selected_checker_compile_files(&config, &files);
        assert!(user.contains_key("common.h"));
        assert!(user.contains_key("user.h"));
        assert!(!user.contains_key("judge.h"));
        assert!(checker.contains_key("common.h"));
        assert!(checker.contains_key("judge.h"));
        assert!(!checker.contains_key("user.h"));
    }

    #[test]
    fn incomplete_compile_response_is_infrastructure_error() {
        let response = crate::oi::go_judge::GoJudgeResponse {
            status: Some("Accepted".to_string()),
            exit_status: Some(0),
            time: None,
            clock_time: None,
            memory: None,
            files: HashMap::new(),
            file_ids: HashMap::new(),
        };
        assert!(compile_response_is_infrastructure_error(&response));

        let response = crate::oi::go_judge::GoJudgeResponse {
            status: None,
            exit_status: Some(1),
            time: None,
            clock_time: None,
            memory: None,
            files: HashMap::new(),
            file_ids: HashMap::new(),
        };
        assert!(compile_response_is_infrastructure_error(&response));
    }
}
