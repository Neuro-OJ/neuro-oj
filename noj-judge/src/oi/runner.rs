//! 传统 OI 题的原生 C/C++ 执行器。
//!
//! OI 任务使用固定的受信编译镜像；题包中的输入/输出文件只在 judge 进程中
//! 读取，用户代码不会获得题包目录。每个测试点使用一次性容器，因此一个测试点
//! 不能通过文件、环境变量或进程状态影响后续测试点。

use std::collections::{HashMap, HashSet};
use std::path::Path;
use std::time::{Duration, Instant};

use anyhow::{bail, Context, Result};
use bollard::Docker;
use futures_util::future::join_all;
use tracing::warn;

use super::docker_exec::{
    create_container, exec_with_stdin, exec_without_stdin, exec_without_stdin_with_output_limit,
};
use crate::oi::{
    score_submission, OiBackend, OiCase, OiCaseResult, OiCheckerType, OiRuntimeConfig, OiStatus,
};
use crate::sandbox::cleanup::remove_container_force;
use crate::sandbox::container::{
    extract_zip_entries_from_file, inject_file_to_container, ZipEntry,
};
use crate::types::{JudgeResult, JudgeTask};

#[path = "native_go_judge_runner.rs"]
mod go_judge_runner;
#[cfg(test)]
use go_judge_runner::compile_response_is_infrastructure_error;
use go_judge_runner::evaluate_native_go_judge;

/// 用户源码上限。题包和 MQ 已有大小限制，judge 侧仍保留最后一道边界。
const MAX_SOURCE_BYTES: usize = 4 * 1024 * 1024;
/// 编译不计入题目运行时限，但必须有独立上限，避免编译器被卡死。
const COMPILE_TIMEOUT: Duration = Duration::from_secs(10);

/// 自测文本比较只忽略行末空白与末尾空行；行内空格仍参与比较。
pub(crate) fn check_self_test_output(expected: &[u8], actual: &[u8]) -> bool {
    fn normalized(bytes: &[u8]) -> Vec<Vec<u8>> {
        let mut lines: Vec<Vec<u8>> = bytes
            .split(|byte| *byte == b'\n')
            .map(|line| {
                let mut end = line.len();
                while end > 0 && matches!(line[end - 1], b' ' | b'\t' | b'\r') {
                    end -= 1;
                }
                line[..end].to_vec()
            })
            .collect();
        while lines.last().is_some_and(Vec::is_empty) {
            lines.pop();
        }
        lines
    }
    normalized(expected) == normalized(actual)
}

/// 分开截断 stdout/stderr；字节边界使用 UTF-8 lossy，避免切片 panic。
pub(crate) fn limited_output(bytes: &[u8]) -> (String, bool) {
    const LIMIT: usize = 8 * 1024;
    (
        String::from_utf8_lossy(&bytes[..bytes.len().min(LIMIT)]).into_owned(),
        bytes.len() > LIMIT,
    )
}
enum CaseOutcome {
    Result(OiCaseResult),
    NeedsChecker {
        result: OiCaseResult,
        output: Vec<u8>,
    },
    SystemError,
}

/// 执行一个 OI 任务。`trusted_image` 只能来自 Worker 配置，绝不从题目或 MQ
/// 消息中读取。
// 独立验收程序仍使用此入口，不连接共享调度资源。
#[allow(dead_code)]
pub async fn evaluate_native(
    docker: &Docker,
    task: &JudgeTask,
    support_package: &Path,
    trusted_image: &str,
    cpu_limit_millicores: u64,
    instance_id: &str,
    resource_lease_client: Option<&redis::Client>,
) -> Result<JudgeResult> {
    evaluate_scheduled(
        docker,
        task,
        support_package,
        trusted_image,
        cpu_limit_millicores,
        instance_id,
        resource_lease_client,
        None,
    )
    .await
}

#[allow(clippy::too_many_arguments)]
pub async fn evaluate_scheduled(
    docker: &Docker,
    task: &JudgeTask,
    support_package: &Path,
    trusted_image: &str,
    cpu_limit_millicores: u64,
    instance_id: &str,
    resource_lease_client: Option<&redis::Client>,
    scheduling: Option<(
        &crate::scheduling::Scheduler,
        &std::sync::Arc<crate::scheduling::Lease>,
    )>,
) -> Result<JudgeResult> {
    let runtime_config = task
        .runtime_config
        .as_oi()
        .context("OI runner 收到非 OI runtime_config")?;
    if task.judge_type != "oi" {
        bail!("OI runner 收到不匹配的 judge_type: {}", task.judge_type);
    }
    if runtime_config
        .scoring_version
        .is_some_and(|version| version != 2)
    {
        return Ok(system_error_result(task, "OI 评分协议不匹配，请重测"));
    }
    if runtime_config.self_test.is_some() && !task.submission_id.starts_with("st_") {
        return Ok(system_error_result(task, "正式评测禁止自测模式"));
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
    let progress =
        super::progress::ProgressReporter::new(task, resource_lease_client, runtime_config)
            .with_scheduling(scheduling);
    progress
        .phase(if runtime_config.backend == OiBackend::Wasm {
            "queued"
        } else {
            "compiling"
        })
        .await;
    let entries = extract_zip_entries_from_file(support_package).context("读取 OI 支持包失败")?;
    let files = index_files(entries)?;
    progress
        .adjust_data_memory(files.values().map(Vec::len).sum())
        .await?;
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
                &progress,
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
        let Some(profile) = task.oi_cost_profile.as_ref() else {
            let mut result = system_error_result(task, "WASM 任务缺少统一标准，请重测");
            result.output = "WASM 任务缺少统一标准，请重测".to_string();
            result.details["oi"]["backend"] = serde_json::json!("wasm");
            result.details["metering"] = serde_json::json!({"comparable":false,"legacy":true,"termination_reason":"standard_mismatch"});
            return Ok(result);
        };
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
        return crate::oi::wasm::evaluate_wasm_with_progress(
            task,
            runtime_config,
            &cases,
            profile,
            checker_source.map(|source| source.as_slice()),
            &selected_user_runtime_files(runtime_config, &files),
            &selected_checker_compile_files(runtime_config, &files),
            &selected_user_compile_files(runtime_config, &files),
            Some(&progress),
        )
        .await;
    }

    let started = Instant::now();
    let executable = match compile_native_program(
        docker,
        task,
        runtime_config,
        &files,
        trusted_image,
        cpu_limit_millicores,
        instance_id,
        &progress,
    )
    .await?
    {
        Ok(bytes) => bytes,
        Err(diagnostics) => {
            let mut result = super::OiEvaluation {
                status: OiStatus::CompileError,
                score: 0,
                subtasks: vec![],
            }
            .to_judge_result(&task.submission_id, task.rejudge_seq, None, None);
            result.details["oi"]["compile_error"] = serde_json::json!(diagnostics);
            return Ok(result);
        }
    };
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
        let maximums = subtask.case_max_scores();
        for (case_index, case) in subtask.cases.iter().enumerate() {
            let case_id = case
                .id
                .clone()
                .unwrap_or_else(|| format!("{}_{}", subtask.id, case_index + 1));
            if progress.is_cancelled() {
                let result = super::cancelled_case(case);
                progress
                    .finish_case(&subtask.id, &case_id, &result, maximums[case_index])
                    .await;
                case_results.push(result);
                subtask_passed = false;
                continue;
            }
            progress.start_case(&subtask.id, &case_id).await;
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
                &executable,
                &progress,
                maximums[case_index],
            )
            .await?;
            match outcome {
                CaseOutcome::Result(result) => {
                    progress
                        .finish_case(&subtask.id, &case_id, &result, maximums[case_index])
                        .await;
                    let case_failed = result.status != OiStatus::Accepted;
                    case_results.push(result);
                    if case_failed {
                        subtask_passed = false;
                    }
                    if subtask.should_stop(&case_results) {
                        break;
                    }
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

pub(crate) fn system_error_result(task: &JudgeTask, reason: &str) -> JudgeResult {
    // 详细原因只写 worker 日志；结果消息不把镜像、路径或内部错误泄露给用户。
    warn!(submission_id = %task.submission_id, reason, "OI 任务无法执行");
    if let Some(config) = task.runtime_config.as_oi() {
        let case_results = config
            .subtasks
            .iter()
            .flat_map(|subtask| subtask.cases.iter())
            .map(|case| OiCaseResult {
                stdout: None,
                stderr: None,
                stdout_truncated: None,
                stderr_truncated: None,
                score: None,
                max_score: None,
                case_id: Some(case.input.clone()),
                input: case.input.clone(),
                status: OiStatus::SystemError,
                time_ms: None,
                memory_kb: None,
                cpu_time_ms: None,
                wall_time_ms: None,
                equivalent_time_ms: None,
                fuel_consumed: None,
                fuel_budget: None,
                termination_reason: None,
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

pub(super) fn index_files(entries: Vec<ZipEntry>) -> Result<HashMap<String, Vec<u8>>> {
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

pub(super) fn validate_references(
    config: &OiRuntimeConfig,
    files: &HashMap<String, Vec<u8>>,
) -> Result<()> {
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

/// 独立编译一次，再把产物注入各测试点的一次性运行容器。
#[allow(clippy::too_many_arguments)]
async fn compile_native_program(
    docker: &Docker,
    task: &JudgeTask,
    config: &OiRuntimeConfig,
    files: &HashMap<String, Vec<u8>>,
    image: &str,
    cpu_limit: u64,
    instance: &str,
    progress: &super::progress::ProgressReporter,
) -> Result<Result<Vec<u8>, String>> {
    let container = create_container(docker, image, 512, cpu_limit, instance).await?;
    let compile = async {
        for (path, bytes) in selected_user_compile_files(config, files) {
            inject_file_to_container(docker, &container, &path, &bytes).await?;
        }
        let (compiler, standard, source) = if task.language == "c" {
            ("gcc", "c99", "main.c")
        } else {
            ("g++", "c++11", "main.cpp")
        };
        inject_file_to_container(docker, &container, source, task.code.as_bytes()).await?;
        let response = exec_without_stdin(
            docker,
            &container,
            vec![
                compiler.into(),
                format!("-std={standard}"),
                "-O2".into(),
                "-Wall".into(),
                "-pipe".into(),
                format!("/workspace/{source}"),
                "-o".into(),
                "/workspace/main".into(),
            ],
            COMPILE_TIMEOUT,
        )
        .await?;
        if response.exit_code != 0 || response.output.output_limited {
            let mut diagnostics = response.output.stderr;
            diagnostics.extend(response.output.stdout);
            return Ok(Err(limited_output(&diagnostics).0));
        }
        // Docker archive API 不读取运行时 tmpfs；通过容器自己的挂载命名空间取回。
        let artifact = exec_without_stdin_with_output_limit(
            docker,
            &container,
            vec!["cat".into(), "/workspace/main".into()],
            COMPILE_TIMEOUT,
            64 * 1024 * 1024,
        )
        .await?;
        anyhow::ensure!(!artifact.output.output_limited, "编译产物超过 64 MiB");
        anyhow::ensure!(
            artifact.exit_code == 0 && !artifact.output.stdout.is_empty(),
            "编译成功但无法读取可执行产物"
        );
        Ok(Ok(artifact.output.stdout))
    };
    let result = tokio::select! {result=compile=>result,_=progress.wait_cancelled()=>Ok(Err("编译已取消".to_string()))};
    if !remove_container_force(docker, &container).await {
        warn!(container_id=%container,"OI 编译容器清理失败");
    }
    result
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
    executable: &[u8],
    progress: &super::progress::ProgressReporter,
    maximum: f64,
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
    let execution = run_case_in_container(
        docker,
        &container_id,
        task,
        config,
        case,
        input,
        expected,
        files,
        time_limit_ms,
        executable,
    );
    let result = tokio::select! {
        result=execution=>result,
        _=progress.wait_cancelled()=>Ok(CaseOutcome::Result(super::cancelled_case(case))),
    };
    if !remove_container_force(docker, &container_id).await {
        warn!(container_id = %container_id, "OI 测试点容器清理失败");
    }
    match result? {
        CaseOutcome::NeedsChecker { mut result, output } => {
            let Some(checker_source) = checker_source else {
                return Ok(CaseOutcome::SystemError);
            };
            let (status, points) = run_checker(
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
                maximum,
            )
            .await
            .unwrap_or_else(|error| {
                warn!(error = %error, "testlib checker 容器执行失败");
                (OiStatus::SystemError, None)
            });
            result.status = status;
            result.score = points;
            Ok(CaseOutcome::Result(result))
        }
        other => Ok(other),
    }
}

#[allow(clippy::too_many_arguments)]
async fn run_case_in_container(
    docker: &Docker,
    container_id: &str,
    _task: &JudgeTask,
    config: &OiRuntimeConfig,
    case: &OiCase,
    input: &[u8],
    expected: &[u8],
    files: &HashMap<String, Vec<u8>>,
    time_limit_ms: u64,
    executable: &[u8],
) -> Result<CaseOutcome> {
    let file_io = file_io_names(config.filename.as_deref())?;
    for (path, data) in selected_user_runtime_files(config, files) {
        inject_file_to_container(docker, container_id, &path, &data).await?;
    }
    if let Some((input_name, _)) = &file_io {
        inject_file_to_container(docker, container_id, input_name, input)
            .await
            .context("注入 OI 文件输入失败")?;
    }
    inject_file_to_container(docker, container_id, "main", executable).await?;
    let chmod = exec_without_stdin(
        docker,
        container_id,
        vec!["chmod".into(), "700".into(), "/workspace/main".into()],
        Duration::from_secs(5),
    )
    .await?;
    if chmod.exit_code != 0 {
        bail!("设置 OI 编译产物执行权限失败");
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
    } else if if let Some(mode) = config.self_test.as_ref() {
        !mode.no_compare_inputs.contains(&case.input)
            && !check_self_test_output(expected, &actual_output)
    } else {
        config.checker.kind != OiCheckerType::Testlib
            && !check_output(config.checker.kind, expected, &actual_output)
    } {
        OiStatus::WrongAnswer
    } else {
        OiStatus::Accepted
    };
    let result = OiCaseResult {
        stdout: config
            .self_test
            .as_ref()
            .map(|_| limited_output(&actual_output).0),
        stderr: config
            .self_test
            .as_ref()
            .map(|_| limited_output(&execution.output.stderr).0),
        stdout_truncated: config
            .self_test
            .as_ref()
            .map(|_| limited_output(&actual_output).1),
        stderr_truncated: config
            .self_test
            .as_ref()
            .map(|_| limited_output(&execution.output.stderr).1),
        score: None,
        max_score: None,
        case_id: Some(case.input.clone()),
        input: case.input.clone(),
        status,
        time_ms: Some(elapsed_ms),
        memory_kb: None,
        cpu_time_ms: None,
        wall_time_ms: Some(elapsed_ms),
        equivalent_time_ms: Some(elapsed_ms),
        fuel_consumed: None,
        fuel_budget: None,
        termination_reason: None,
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
    maximum: f64,
) -> Result<(OiStatus, Option<f64>)> {
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
            return Ok((OiStatus::SystemError, None));
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
            Ok((OiStatus::SystemError, None))
        } else {
            Ok(super::testlib_points(
                Some(checker.exit_code),
                &checker.output.stderr,
                maximum,
            ))
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

#[cfg(test)]
mod self_test_text_tests {
    use super::*;
    #[test]
    fn text_comparison_keeps_internal_spaces_and_normalizes_line_endings() {
        assert!(check_self_test_output(b"1 2\r\n3\r\n", b"1 2  \n3\t\n\n"));
        assert!(!check_self_test_output(b"1 2\n", b"1  2\n"));
        assert!(!check_self_test_output(b"1\n2\n", b"1 2\n"));
        assert!(check_self_test_output(b"", b" \t\r\n\n"));
    }
    #[test]
    fn truncation_uses_byte_limit_without_utf8_panics() {
        let bytes = "中".repeat(30000).into_bytes();
        let (text, truncated) = limited_output(&bytes);
        assert!(truncated);
        assert!(text.len() <= 64 * 1024 + 3);
    }
}
