//! 传统 OI 的 WASI/Wasm 执行器。
//!
//! 该模块只接受 worker 注入的已编译 Wasm 字节和受信成本表。它不读取题目
//! 传入的命令，也不把题目目录暴露给 guest；标准输入输出使用内存管道，
//! 网络与宿主环境变量均关闭；文件题仅预打开一次性工作目录。

use std::collections::{HashMap, HashSet};
use std::path::{Component, Path};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{mpsc, Arc};
use std::time::Instant;

use anyhow::{Context, Result};
use futures_util::future::join_all;
use futures_util::StreamExt;
use wasmtime::{Config, Engine, Linker, Module, OperatorCost, Store, StoreLimitsBuilder};
use wasmtime_wasi::{
    clocks::{HostMonotonicClock, HostWallClock},
    p1,
    p2::pipe::{MemoryInputPipe, MemoryOutputPipe},
    FsPerms, WasiCtxBuilder,
};

#[path = "wasm_execution.rs"]
mod execution;
pub use execution::run_checker_module;
use execution::{
    run_module_with_files, run_observed_module_with_files, run_prepared_checker,
    run_prepared_module, PreparedModule,
};

#[path = "wasm_analysis_runtime.rs"]
mod analysis_runtime;
pub(super) use analysis_runtime::run_analysis_module;

use super::wasm_compile::{compile_cancellable, CompilerInfrastructureError};
use crate::types::{JudgeResult, JudgeTask};

use super::{
    score_submission, OiBackend, OiCase, OiCaseResult, OiCheckerType, OiCostProfile, OiEvaluation,
    OiRuntimeConfig, OiStatus,
};

pub const MAX_OUTPUT_BYTES: usize = 32 * 1024 * 1024;

#[allow(dead_code)]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WasmStatus {
    Accepted,
    TimeLimitExceeded,
    MemoryLimitExceeded,
    RuntimeError,
    FormatError,
    OutputLimitExceeded,
    SystemError,
}

#[derive(Debug)]
pub struct WasmRunResult {
    pub status: WasmStatus,
    pub stdout: Vec<u8>,
    #[allow(dead_code)]
    pub stderr: Vec<u8>,
    pub fuel_consumed: Option<u64>,
    pub cpu_time_ms: Option<u64>,
    pub wall_time_ms: u64,
    pub exit_code: Option<i32>,
    /// 仅独立分析运行读取；正式评测始终为空，不进入 MQ 结果。
    pub analysis_counters: Vec<u64>,
}

#[allow(dead_code)]
/// 运行单个 Wasm 测试点；异步调用允许取消 guest 和 WASI 宿主等待。
pub async fn run_module(
    module_bytes: &[u8],
    input: &[u8],
    memory_limit_mb: u64,
    fuel_budget: u64,
    profile: &OiCostProfile,
) -> Result<WasmRunResult> {
    run_module_with_files(
        module_bytes,
        input,
        memory_limit_mb,
        fuel_budget,
        profile,
        &[],
        None,
        FsPerms::ReadOnly,
        None,
        None,
    )
    .await
}

pub(super) fn write_extra_files(root: &Path, files: &HashMap<String, Vec<u8>>) -> Result<()> {
    let mut basenames = std::collections::BTreeMap::new();
    // 文件注入与同名头文件别名必须按固定顺序选择，不能依赖 HashMap 随机迭代。
    let mut ordered: Vec<_> = files.iter().collect();
    ordered.sort_by_key(|(path, _)| *path);
    for (name, content) in ordered {
        let relative = Path::new(name);
        if relative.is_absolute()
            || relative.components().any(|component| {
                matches!(
                    component,
                    Component::CurDir
                        | Component::ParentDir
                        | Component::RootDir
                        | Component::Prefix(_)
                )
            })
        {
            anyhow::bail!("WASM extra file 路径不安全: {name}");
        }
        let path = root.join(relative);
        if !path.starts_with(root) {
            anyhow::bail!("WASM extra file 路径逃逸工作目录: {name}");
        }
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).context("创建 WASM extra file 目录失败")?;
        }
        std::fs::write(path, content).context("写入 WASM extra file 失败")?;
        if let Some(basename) = relative.file_name().and_then(|value| value.to_str()) {
            basenames.entry(basename.to_string()).or_insert(content);
        }
    }
    // Hydro 的额外文件在工作目录中按 basename 提供；保留上面的完整路径，
    // 再补不冲突的 basename，确保 `#include "helper.h"` 与显式路径都可用。
    for (basename, content) in basenames {
        let path = root.join(&basename);
        if !path.exists() {
            std::fs::write(path, content).context("写入 WASM extra file basename 失败")?;
        }
    }
    Ok(())
}

/// 运行受信 testlib checker。checker 只能读取由 worker 创建的只读目录，
/// 不能访问用户 WASM 的内存、宿主其它路径或网络。
/// 执行一个 OI WASM 任务。成本表和 WASI 编译器均来自 worker 配置/服务端，
/// 用户消息不能替换它们。
#[allow(dead_code, clippy::too_many_arguments)]
pub async fn evaluate_wasm(
    task: &JudgeTask,
    config: &OiRuntimeConfig,
    cases: &[(String, Vec<u8>, Vec<u8>)],
    profile: &OiCostProfile,
    checker_source: Option<&[u8]>,
    extra_files: &HashMap<String, Vec<u8>>,
    checker_compile_files: &HashMap<String, Vec<u8>>,
    user_compile_files: &HashMap<String, Vec<u8>>,
) -> Result<JudgeResult> {
    evaluate_wasm_with_progress(
        task,
        config,
        cases,
        profile,
        checker_source,
        extra_files,
        checker_compile_files,
        user_compile_files,
        None,
    )
    .await
}

#[allow(clippy::too_many_arguments)]
pub async fn evaluate_wasm_with_progress(
    task: &JudgeTask,
    config: &OiRuntimeConfig,
    cases: &[(String, Vec<u8>, Vec<u8>)],
    profile: &OiCostProfile,
    checker_source: Option<&[u8]>,
    extra_files: &HashMap<String, Vec<u8>>,
    checker_compile_files: &HashMap<String, Vec<u8>>,
    user_compile_files: &HashMap<String, Vec<u8>>,
    progress: Option<&super::progress::ProgressReporter>,
) -> Result<JudgeResult> {
    let matches = super::standard::validate_profile(profile);
    let mut result = if let Err(error) = &matches {
        let mut result = uniform_status_result(task, config, OiStatus::SystemError)?;
        result.output = error.to_string();
        result
    } else {
        evaluate_wasm_inner(
            task,
            config,
            cases,
            profile,
            checker_source,
            extra_files,
            checker_compile_files,
            user_compile_files,
            progress,
        )
        .await?
    };
    if let Some(reporter) = progress {
        reporter.ensure_resource_valid()?;
    }
    let mut files = std::collections::BTreeMap::new();
    for subtask in &config.subtasks {
        for case in &subtask.cases {
            if let Some((_, input, output)) = cases.iter().find(|(path, _, _)| path == &case.input)
            {
                files.insert(case.input.clone(), super::standard::hash(input));
                files.insert(case.output.clone(), super::standard::hash(output));
            }
        }
    }
    for path in config
        .compile_extra_files
        .iter()
        .chain(&config.user_extra_files)
        .chain(&config.checker_extra_files)
    {
        if let Some(bytes) = extra_files
            .get(path)
            .or_else(|| user_compile_files.get(path))
            .or_else(|| checker_compile_files.get(path))
        {
            files.insert(path.clone(), super::standard::hash(bytes));
        }
    }
    if let (Some(path), Some(bytes)) = (&config.checker.path, checker_source) {
        files.insert(path.clone(), super::standard::hash(bytes));
    }
    // 未升级评分协议的存量配置保持原来的序列化摘要；新协议完整绑定新字段。
    // 不能仅因反序列化补出的 null/default 字段破坏已发布的 v3 基准身份。
    let mut metering_config = serde_json::to_value(config)?;
    if config.scoring_version.is_none()
        && config.subtasks.iter().all(|subtask| {
            subtask.scoring == super::OiScoring::Min
                && subtask
                    .cases
                    .iter()
                    .all(|case| case.id.is_none() && case.score.is_none())
        })
    {
        metering_config
            .as_object_mut()
            .unwrap()
            .remove("scoring_version");
        for subtask in metering_config["subtasks"].as_array_mut().unwrap() {
            subtask.as_object_mut().unwrap().remove("scoring");
            for case in subtask["cases"].as_array_mut().unwrap() {
                case.as_object_mut().unwrap().remove("id");
                case.as_object_mut().unwrap().remove("score");
            }
        }
    }
    let payload = serde_json::json!({"runtime_config":metering_config,"files":files});
    let evaluation_hash =
        super::standard::hash(super::standard::canonical_json(&payload).as_bytes());
    let source_hash = super::standard::hash(task.code.as_bytes());
    let module_hash = result
        .details
        .as_object_mut()
        .and_then(|map| map.remove("wasm_module_hash"));
    let checker_module_hash = result
        .details
        .as_object_mut()
        .and_then(|map| map.remove("wasm_checker_module_hash"));
    let mut identity = serde_json::json!({"standard_hash":super::standard::profile().hash,"evaluation_hash":evaluation_hash,"source_hash":source_hash,"language":task.language,"module_hash":module_hash});
    if let Some(hash) = &checker_module_hash {
        identity["checker_module_hash"] = hash.clone();
    }
    result.details["oi"]["backend"] = serde_json::json!("wasm");
    let comparable = matches.is_ok() && result.details["oi"]["verdict"] != "SE";
    result.details["metering"] = serde_json::json!({"standard_version":super::standard::manifest()["id"],"standard_hash":super::standard::profile().hash,
        "source_hash":source_hash,"evaluation_hash":evaluation_hash,"module_hash":module_hash,
        "comparison_hash":super::standard::hash(super::standard::canonical_json(&identity).as_bytes()),"comparable":comparable,"termination_reason":if matches.is_err() {Some("standard_mismatch")} else {None}});
    if let Some(hash) = checker_module_hash {
        result.details["metering"]["checker_module_hash"] = hash;
    }
    if result.details["oi"]["subtasks"]
        .as_array()
        .is_some_and(|subtasks| {
            subtasks.iter().any(|s| {
                s["cases"].as_array().is_some_and(|cases| {
                    cases
                        .iter()
                        .any(|c| c["termination_reason"] == "host_watchdog")
                })
            })
        })
    {
        result.output = "WASM 运行保护超时；请降低负载后重测".to_string();
        result.details["metering"]["termination_reason"] = serde_json::json!("host_watchdog");
    }
    Ok(result)
}

#[allow(clippy::too_many_arguments)]
async fn evaluate_wasm_inner(
    task: &JudgeTask,
    config: &OiRuntimeConfig,
    cases: &[(String, Vec<u8>, Vec<u8>)],
    profile: &OiCostProfile,
    checker_source: Option<&[u8]>,
    extra_files: &HashMap<String, Vec<u8>>,
    checker_compile_files: &HashMap<String, Vec<u8>>,
    user_compile_files: &HashMap<String, Vec<u8>>,
    progress: Option<&super::progress::ProgressReporter>,
) -> Result<JudgeResult> {
    if config.backend != OiBackend::Wasm {
        anyhow::bail!("WASM runner 收到非 WASM 配置");
    }
    profile.validate().map_err(anyhow::Error::msg)?;
    let compile_lease = if let Some(progress) = progress {
        progress.stage("compile", 512).await?
    } else {
        None
    };
    if let Some(progress) = progress {
        progress.phase("compiling").await;
    }
    let language = task.language.clone();
    let source = task.code.clone();
    let compile_files = user_compile_files.clone();
    let source_compile_lease = compile_lease.clone();
    let compile_cancellation = progress.map(|reporter| reporter.cancel_flag());
    let wasm = match tokio::task::spawn_blocking(move || {
        let _lease = source_compile_lease;
        compile_cancellable(
            &language,
            &source,
            &compile_files,
            compile_cancellation.as_deref(),
        )
    })
    .await
    {
        Ok(Ok(wasm)) => wasm,
        Ok(Err(error))
            if error
                .downcast_ref::<CompilerInfrastructureError>()
                .is_some() =>
        {
            tracing::error!(error = %format!("{error:#}"), "WASI 编译基础设施不可用");
            return uniform_status_result(task, config, OiStatus::SystemError);
        }
        Ok(Err(error)) => {
            tracing::warn!(error = %error, "WASI 用户程序编译失败");
            let mut result = uniform_status_result(task, config, OiStatus::CompileError)?;
            result.details["oi"]["compile_error"] = serde_json::json!(error.to_string());
            return Ok(result);
        }
        Err(error) => {
            tracing::error!(error = %error, "WASI 用户程序编译线程异常");
            return uniform_status_result(task, config, OiStatus::SystemError);
        }
    };
    let checker_compile_files_for_compile = checker_compile_files.clone();
    let checker_module = if let Some(source) = checker_source {
        let source = match String::from_utf8(source.to_vec()) {
            Ok(source) => source,
            Err(error) => {
                tracing::error!(error = %error, "WASM testlib checker 不是 UTF-8 C++ 源码");
                return uniform_status_result(task, config, OiStatus::SystemError);
            }
        };
        let checker_compile_lease = compile_lease.clone();
        let checker_cancellation = progress.map(|reporter| reporter.cancel_flag());
        match tokio::task::spawn_blocking(move || {
            let _lease = checker_compile_lease;
            compile_cancellable(
                "cc",
                &source,
                &checker_compile_files_for_compile,
                checker_cancellation.as_deref(),
            )
        })
        .await
        {
            Ok(Ok(module)) => Some(module),
            Ok(Err(error)) => {
                tracing::error!(error = %error, "WASI testlib checker 编译失败");
                return uniform_status_result(task, config, OiStatus::SystemError);
            }
            Err(error) => {
                tracing::error!(error = %error, "WASI testlib checker 编译线程异常");
                return uniform_status_result(task, config, OiStatus::SystemError);
            }
        }
    } else {
        None
    };
    let user_bytes = wasm.clone();
    let checker_bytes = checker_module.clone();
    let compiled_profile = profile.clone();
    let module_compile_lease = compile_lease.clone();
    let prepared = tokio::task::spawn_blocking(move || -> Result<_> {
        let _lease = module_compile_lease;
        let user = PreparedModule::new(&user_bytes, &compiled_profile)?;
        let checker = checker_bytes
            .as_deref()
            .map(|bytes| user.checker(bytes))
            .transpose()?;
        Ok((user, checker))
    })
    .await
    .context("创建提交级 WASM 模块失败")??;
    drop(compile_lease);
    let mut results = Vec::with_capacity(cases.len());
    let user_extra_files = config
        .user_extra_files
        .iter()
        .filter_map(|path| {
            extra_files
                .get(path)
                .cloned()
                .map(|data| (path.clone(), data))
        })
        .collect::<HashMap<_, _>>();
    // checker 只能看到 checker 编译辅助文件；user_extra_files 属于选手沙箱，
    // 不应因为 WASM 的共享宿主目录而泄露到 checker。
    let checker_extra_files = checker_compile_files.clone();
    let case_data = cases
        .iter()
        .map(|(case_id, input, expected)| {
            (case_id.as_str(), (input.as_slice(), expected.as_slice()))
        })
        .collect::<HashMap<_, _>>();
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
            return Err(anyhow::anyhow!("WASM 子任务依赖无法调度"));
        }
        runnable.sort_unstable();
        let batch = runnable;
        for index in &batch {
            pending.remove(index);
        }
        let runs = join_all(batch.iter().map(|&index| {
            run_wasm_subtask(
                &wasm,
                checker_module.as_deref(),
                config,
                index,
                &case_data,
                &prepared,
                profile,
                &user_extra_files,
                &checker_extra_files,
                progress,
            )
        }))
        .await;
        for (index, run) in batch.into_iter().zip(runs) {
            let (subtask_passed, subtask_results) = match run {
                Ok(result) => result,
                Err(error) => {
                    tracing::error!(error = %error, "WASM 测试点执行失败");
                    return uniform_status_result(task, config, OiStatus::SystemError);
                }
            };
            results.extend(subtask_results);
            if subtask_passed {
                passed.insert(config.subtasks[index].id.as_str());
            } else {
                failed.insert(config.subtasks[index].id.as_str());
            }
        }
    }
    let evaluation = score_submission(config, &results).map_err(anyhow::Error::msg)?;
    let equivalent_time = results
        .iter()
        .filter_map(|case| case.equivalent_time_ms)
        .max();
    let mut result =
        evaluation.to_judge_result(&task.submission_id, task.rejudge_seq, equivalent_time, None);
    result.details["wasm_module_hash"] = serde_json::json!(super::standard::hash(&wasm));
    if let Some(module) = &checker_module {
        result.details["wasm_checker_module_hash"] =
            serde_json::json!(super::standard::hash(module));
    }
    Ok(result)
}

/// sum 的用例共享节点槽位；min/max 保留声明顺序与短路。
#[allow(clippy::too_many_arguments)]
async fn run_wasm_subtask(
    wasm: &[u8],
    checker_module: Option<&[u8]>,
    config: &OiRuntimeConfig,
    subtask_index: usize,
    case_data: &HashMap<&str, (&[u8], &[u8])>,
    prepared: &(PreparedModule, Option<PreparedModule>),
    profile: &OiCostProfile,
    user_extra_files: &HashMap<String, Vec<u8>>,
    checker_extra_files: &HashMap<String, Vec<u8>>,
    progress: Option<&super::progress::ProgressReporter>,
) -> Result<(bool, Vec<OiCaseResult>)> {
    let subtask = &config.subtasks[subtask_index];
    let maximums = subtask.case_max_scores();
    let maximums = maximums.as_slice();
    let run = |(index, _): (usize, &OiCase)| {
        let case = &subtask.cases[index];
        async move {
            let id = case
                .id
                .clone()
                .unwrap_or_else(|| format!("{}_{}", subtask.id, index + 1));
            if progress.is_some_and(|reporter| reporter.is_cancelled()) {
                return Ok::<_, anyhow::Error>((index, super::cancelled_case(case)));
            }
            let memory = case
                .memory_limit_mb
                .or(subtask.memory_limit_mb)
                .unwrap_or(config.memory_limit_mb);
            let _run_lease = if let Some(reporter) = progress {
                reporter.stage("run", memory.saturating_add(128)).await?
            } else {
                None
            };
            if let Some(reporter) = progress {
                reporter.start_case(&subtask.id, &id).await;
            }
            let (input, expected) = case_data
                .get(case.input.as_str())
                .context("WASM 测试点数据数量或路径不一致")?;
            let result = run_wasm_case(
                wasm,
                checker_module,
                config.checker.kind,
                config.filename.as_deref(),
                case,
                subtask.time_limit_ms,
                subtask.memory_limit_mb,
                config.time_limit_ms,
                config.memory_limit_mb,
                input,
                expected,
                profile,
                user_extra_files,
                checker_extra_files,
                maximums[index],
                config
                    .self_test
                    .as_ref()
                    .map(|mode| !mode.no_compare_inputs.contains(&case.input)),
                progress.map(|reporter| reporter.cancel_flag()),
                Some(prepared),
                _run_lease.clone(),
            )
            .await?;
            if let Some(reporter) = progress {
                reporter
                    .finish_case(&subtask.id, &id, &result, maximums[index])
                    .await;
            }
            Ok((index, result))
        }
    };
    let mut ordered = if subtask.scoring == super::OiScoring::Sum {
        let window = progress
            .map(|reporter| reporter.case_window())
            .unwrap_or(16);
        futures_util::stream::iter(subtask.cases.iter().enumerate().map(run))
            .buffer_unordered(window)
            .collect::<Vec<_>>()
            .await
            .into_iter()
            .collect::<Result<Vec<_>>>()?
    } else {
        let mut results = Vec::new();
        let mut scores = Vec::new();
        for item in subtask.cases.iter().enumerate() {
            let (index, result) = run(item).await?;
            scores.push(result.clone());
            results.push((index, result));
            if subtask.should_stop(&scores) {
                break;
            }
        }
        results
    };
    ordered.sort_by_key(|(index, _)| *index);
    let results = ordered
        .into_iter()
        .map(|(_, result)| result)
        .collect::<Vec<_>>();
    Ok((
        results
            .iter()
            .all(|result| result.status == OiStatus::Accepted),
        results,
    ))
}

#[allow(clippy::too_many_arguments)]
async fn run_wasm_case(
    wasm: &[u8],
    checker_module: Option<&[u8]>,
    checker_kind: OiCheckerType,
    filename: Option<&str>,
    case: &OiCase,
    subtask_time_limit_ms: Option<u64>,
    subtask_memory_limit_mb: Option<u64>,
    default_time_limit_ms: u64,
    default_memory_limit_mb: u64,
    input: &[u8],
    expected: &[u8],
    profile: &OiCostProfile,
    user_extra_files: &HashMap<String, Vec<u8>>,
    checker_extra_files: &HashMap<String, Vec<u8>>,
    maximum: f64,
    self_test_compare: Option<bool>,
    cancellation: Option<Arc<AtomicBool>>,
    prepared: Option<&(PreparedModule, Option<PreparedModule>)>,
    stage_lease: Option<Arc<super::progress::StageLease>>,
) -> Result<OiCaseResult> {
    let expected_for_run = expected.to_vec();
    let memory = case
        .memory_limit_mb
        .or(subtask_memory_limit_mb)
        .unwrap_or(default_memory_limit_mb);
    let limit = case
        .time_limit_ms
        .or(subtask_time_limit_ms)
        .unwrap_or(default_time_limit_ms);
    let fuel_per_ms = profile.fuel_per_ms;
    // 输入大小不能奖励额外 CPU 预算，预算严格由参考时间换算。
    let fuel = super::standard::fuel_budget(limit)?;
    let file_io = file_io_names(filename)?;
    let user_directory = if user_extra_files.is_empty() && file_io.is_none() {
        None
    } else {
        let directory = tempfile::tempdir().context("创建 WASM 用户文件目录失败")?;
        write_extra_files(directory.path(), user_extra_files)?;
        if let Some((input_name, _)) = &file_io {
            std::fs::write(directory.path().join(input_name), input)
                .context("写入 WASM 文件输入失败")?;
        }
        Some(directory)
    };
    let user_directory = user_directory.map(Arc::new);
    let baseline_directory_bytes = user_directory
        .as_ref()
        .map(|directory| directory_size(directory.path()))
        .transpose()?;
    let user_bytes = wasm.to_vec();
    let user_input = if file_io.is_some() {
        Vec::new()
    } else {
        input.to_vec()
    };
    let user_profile = profile.clone();
    let uses_file_io = file_io.is_some();
    let user_directory_path = user_directory
        .as_ref()
        .map(|directory| directory.path().to_path_buf());
    let user_cancellation = cancellation.clone();
    let user_prepared = prepared.map(|modules| modules.0.clone());
    let user_stage_lease = stage_lease.clone();
    let user_directory_guard = user_directory.clone();
    let user = tokio::task::spawn_blocking(move || {
        let _lease = user_stage_lease;
        let _directory = user_directory_guard;
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .context("创建 WASM 测试点运行时失败")?;
        runtime.block_on(run_prepared_module(
            &user_bytes,
            &user_input,
            memory,
            fuel.max(1),
            &user_profile,
            &[],
            user_directory_path.as_deref(),
            if uses_file_io {
                FsPerms::ReadWrite
            } else {
                FsPerms::ReadOnly
            },
            Some(wall_budget_ms(limit)),
            0,
            user_cancellation,
            user_prepared.as_ref(),
        ))
    })
    .await
    .context("WASM 测试点执行线程异常")?;
    let mut user = match user {
        Ok(result) => result,
        Err(error) if is_memory_limit_error(&error) => WasmRunResult {
            status: WasmStatus::MemoryLimitExceeded,
            stdout: Vec::new(),
            stderr: Vec::new(),
            fuel_consumed: None,
            cpu_time_ms: None,
            wall_time_ms: 0,
            exit_code: None,
            analysis_counters: Vec::new(),
        },
        Err(error) => return Err(error),
    };
    if user.status == WasmStatus::Accepted {
        if let (Some(before), Some(directory)) = (baseline_directory_bytes, user_directory.as_ref())
        {
            let after = directory_size(directory.path())?;
            if after.saturating_sub(before) > MAX_OUTPUT_BYTES as u64 {
                user.status = WasmStatus::OutputLimitExceeded;
                user.stdout.clear();
            }
        }
    }
    if let Some((_, output_name)) = &file_io {
        if user.status == WasmStatus::Accepted {
            let output_path = user_directory
                .as_ref()
                .context("WASM 文件输出目录缺失")?
                .path()
                .join(output_name);
            let (output, limited) = read_limited_file(&output_path)?;
            if limited {
                user.status = WasmStatus::OutputLimitExceeded;
                user.stdout.clear();
            } else if let Some(output) = output {
                user.stdout = output;
            } else {
                user.stdout.clear();
                user.status = WasmStatus::FormatError;
            }
        }
    }
    let checker = if checker_kind == OiCheckerType::Testlib && user.status == WasmStatus::Accepted {
        let module = checker_module.context("WASM testlib checker 模块缺失")?;
        let checker_fuel = super::standard::fuel_budget(limit)?;
        let checker_module = module.to_vec();
        let checker_input = input.to_vec();
        let checker_expected = expected_for_run.clone();
        let checker_actual = user.stdout.clone();
        let checker_profile = profile.clone();
        let checker_extra_files = checker_extra_files.clone();
        let checker_prepared = prepared.and_then(|modules| modules.1.clone());
        let checker_cancellation = cancellation.clone();
        let checker_stage_lease = stage_lease.clone();
        Some(
            tokio::task::spawn_blocking(move || {
                let _lease = checker_stage_lease;
                let runtime = tokio::runtime::Builder::new_current_thread()
                    .enable_all()
                    .build()
                    .context("创建 WASM checker 运行时失败")?;
                runtime.block_on(run_prepared_checker(
                    &checker_module,
                    &checker_input,
                    &checker_expected,
                    &checker_actual,
                    memory,
                    checker_fuel.max(1),
                    &checker_profile,
                    &checker_extra_files,
                    wall_budget_ms(limit),
                    checker_prepared.as_ref(),
                    checker_cancellation,
                ))
            })
            .await
            .context("WASM checker 执行线程异常")??,
        )
    } else {
        None
    };
    let (run, checker) = (user, checker);
    let partial = checker
        .as_ref()
        .filter(|checker| {
            checker.status == WasmStatus::Accepted || checker.status == WasmStatus::RuntimeError
        })
        .map(|checker| {
            super::testlib_points(
                checker.exit_code.map(i64::from).or(Some(0)),
                &checker.stderr,
                maximum,
            )
        });
    let status = if cancellation
        .as_ref()
        .is_some_and(|flag| flag.load(Ordering::Relaxed))
    {
        OiStatus::Ignored
    } else {
        match run.status {
            WasmStatus::Accepted if partial.is_some() => partial.unwrap().0,
            WasmStatus::Accepted if self_test_compare.is_some() => {
                if self_test_compare == Some(false)
                    || crate::oi::runner::check_self_test_output(expected, &run.stdout)
                {
                    OiStatus::Accepted
                } else {
                    OiStatus::WrongAnswer
                }
            }
            WasmStatus::Accepted if checker_kind == OiCheckerType::Testlib => match checker {
                // 新版 wasi-libc 在 main 返回 0 时直接从 _start 返回，不调用 proc_exit。
                Some(checker) if checker.status == WasmStatus::Accepted => OiStatus::Accepted,
                Some(checker)
                    if checker.status == WasmStatus::RuntimeError
                        && checker.exit_code.is_some() =>
                {
                    super::testlib_verdict_from_exit(checker.exit_code.map(i64::from))
                }
                Some(_) | None => OiStatus::SystemError,
            },
            WasmStatus::Accepted
                if crate::oi::runner::check_output(checker_kind, expected, &run.stdout) =>
            {
                OiStatus::Accepted
            }
            WasmStatus::Accepted => OiStatus::WrongAnswer,
            WasmStatus::TimeLimitExceeded => OiStatus::TimeLimitExceeded,
            WasmStatus::MemoryLimitExceeded => OiStatus::MemoryLimitExceeded,
            WasmStatus::OutputLimitExceeded => OiStatus::OutputLimitExceeded,
            WasmStatus::RuntimeError => OiStatus::RuntimeError,
            WasmStatus::FormatError => OiStatus::FormatError,
            WasmStatus::SystemError => OiStatus::SystemError,
        }
    };
    let equivalent = run
        .fuel_consumed
        .map(|fuel| fuel.div_ceil(fuel_per_ms as u64).max(1));
    Ok(OiCaseResult {
        stdout: self_test_compare.map(|_| crate::oi::runner::limited_output(&run.stdout).0),
        stderr: self_test_compare.map(|_| crate::oi::runner::limited_output(&run.stderr).0),
        stdout_truncated: self_test_compare
            .map(|_| crate::oi::runner::limited_output(&run.stdout).1),
        stderr_truncated: self_test_compare
            .map(|_| crate::oi::runner::limited_output(&run.stderr).1),
        score: partial.and_then(|item| item.1),
        max_score: None,
        case_id: Some(case.input.clone()),
        input: case.input.clone(),
        status,
        time_ms: equivalent,
        memory_kb: None,
        cpu_time_ms: run.cpu_time_ms,
        wall_time_ms: Some(run.wall_time_ms),
        equivalent_time_ms: equivalent,
        fuel_consumed: run.fuel_consumed,
        fuel_budget: Some(fuel),
        termination_reason: (run.status == WasmStatus::SystemError)
            .then(|| "host_watchdog".to_string()),
    })
}

fn is_memory_limit_error(error: &anyhow::Error) -> bool {
    // 越界访问是 RE；只有分配/增长超过平台限额才是 MLE。
    error
        .chain()
        .any(|cause| is_memory_limit_message(&cause.to_string()))
}

fn is_memory_limit_message(message: &str) -> bool {
    let message = message.to_ascii_lowercase();
    message.contains("memory limit")
        || message.contains("resource limit")
        || message.contains("memory minimum size")
        || message.contains("failed to grow memory")
        || message.contains("forcing trap when growing memory")
        || message.contains("memory growth failure")
}

/// 文件输入题的 guest 工作目录使用独立临时目录。记录 guest 运行前后的
/// 字节数，只把运行期间新增的数据计入输出配额，并拒绝跟随符号链接，避免
/// 题目程序借助链接把宿主其它路径计入或写入。
fn directory_size(path: &Path) -> Result<u64> {
    // 有界迭代扫描，避免大量空文件或深目录使监控线程堆栈/内存耗尽。
    let mut pending = vec![(path.to_path_buf(), 0usize)];
    let mut entries = 0usize;
    let mut total = 0u64;
    while let Some((path, depth)) = pending.pop() {
        entries += 1;
        if entries > 4096 || depth > 64 {
            anyhow::bail!("WASM 工作目录条目/深度超过限制");
        }
        let metadata = match std::fs::symlink_metadata(&path) {
            Ok(value) => value,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
            Err(error) => return Err(error).context("读取 WASM 工作目录元数据失败"),
        };
        if metadata.is_file() {
            total = total
                .checked_add(metadata.len())
                .context("WASM 工作目录大小溢出")?;
        } else if metadata.is_dir() {
            for entry in std::fs::read_dir(&path).context("读取 WASM 工作目录失败")? {
                let entry = entry.context("读取 WASM 工作目录条目失败")?;
                if entries + pending.len() >= 4096 {
                    anyhow::bail!("WASM 工作目录条目超过限制");
                }
                pending.push((entry.path(), depth + 1));
            }
        }
    }
    Ok(total)
}

/// 墙钟只保护宿主可用性，触发后为 SE，不改变固定 fuel 算法判据。
fn wall_budget_ms(limit_ms: u64) -> u64 {
    limit_ms.saturating_mul(10).max(30_000)
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
        anyhow::bail!("OI filename 含非法字符");
    }
    Ok(Some((format!("{filename}.in"), format!("{filename}.out"))))
}

fn read_limited_file(path: &Path) -> Result<(Option<Vec<u8>>, bool)> {
    let metadata = match std::fs::metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok((None, false)),
        Err(error) => return Err(error).context("读取 WASM 文件输出元数据失败"),
    };
    if metadata.len() > MAX_OUTPUT_BYTES as u64 {
        return Ok((None, true));
    }
    Ok((
        Some(std::fs::read(path).context("读取 WASM 文件输出失败")?),
        false,
    ))
}

/// 编译失败没有执行任何测试点，不生成虚假的逐点 CE/SE。
fn uniform_status_result(
    task: &JudgeTask,
    _config: &OiRuntimeConfig,
    status: OiStatus,
) -> Result<JudgeResult> {
    Ok(OiEvaluation {
        status,
        score: 0,
        subtasks: vec![],
    }
    .to_judge_result(&task.submission_id, task.rejudge_seq, None, None))
}

/// 使用发布标准冻结的完整算子表；任务标准不匹配时在执行前拒绝。
pub fn operator_cost_from_profile(_profile: &OiCostProfile) -> OperatorCost {
    serde_json::from_value(super::standard::manifest()["operator_costs"].clone())
        .expect("冻结算子表必须合法")
}

#[cfg(test)]
#[path = "wasm_tests.rs"]
mod tests;
