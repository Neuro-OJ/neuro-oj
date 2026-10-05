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
use wasmtime::{Config, Engine, Linker, Module, OperatorCost, Store, StoreLimitsBuilder};
use wasmtime_wasi::{
    clocks::{HostMonotonicClock, HostWallClock},
    p1,
    p2::pipe::{MemoryInputPipe, MemoryOutputPipe},
    FsPerms, WasiCtxBuilder,
};

use super::wasm_compile::{compile_source, compile_source_with_files, CompilerInfrastructureError};
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
}

struct WasiState {
    wasi: p1::WasiP1Ctx,
    limits: wasmtime::StoreLimits,
}

/// OI 程序读取 WASI 时钟时看到固定值；真正的资源计量只由 fuel 和宿主 watchdog
/// 提供，避免把宿主时间抖动暴露给用户程序。睡眠仍由 WASI poll 的宿主实现负责，
/// 不会改变 fuel 预算。
#[derive(Debug, Clone, Copy)]
struct DeterministicWallClock;

impl HostWallClock for DeterministicWallClock {
    fn resolution(&self) -> std::time::Duration {
        std::time::Duration::from_nanos(1)
    }

    fn now(&self) -> std::time::Duration {
        std::time::Duration::ZERO
    }
}

#[derive(Debug, Clone, Copy)]
struct DeterministicMonotonicClock;

impl HostMonotonicClock for DeterministicMonotonicClock {
    fn resolution(&self) -> u64 {
        1
    }

    fn now(&self) -> u64 {
        0
    }
}

/// 运行单个 Wasm 测试点。该函数使用 Wasmtime 的异步调用，以便墙钟超时
/// 能够取消 guest 和 WASI 宿主调用。
#[allow(dead_code)]
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
    )
    .await
}

pub(super) fn write_extra_files(root: &Path, files: &HashMap<String, Vec<u8>>) -> Result<()> {
    let mut basenames = HashMap::new();
    for (name, content) in files {
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
#[allow(clippy::too_many_arguments)]
pub async fn run_checker_module(
    module_bytes: &[u8],
    input: &[u8],
    expected: &[u8],
    actual: &[u8],
    memory_limit_mb: u64,
    fuel_budget: u64,
    profile: &OiCostProfile,
    extra_files: &HashMap<String, Vec<u8>>,
    wall_limit_ms: u64,
) -> Result<WasmRunResult> {
    let directory = tempfile::tempdir().context("创建 WASM checker 临时目录失败")?;
    // 先放入题包声明的辅助文件，再写入 worker 生成的三份 checker 输入。
    // 这样即使题包中出现同名 extra，也不能覆盖真实的输入、标准答案或选手输出。
    write_extra_files(directory.path(), extra_files)?;
    std::fs::write(directory.path().join("checker.in"), input)
        .context("写入 WASM checker 输入失败")?;
    std::fs::write(directory.path().join("checker.ans"), expected)
        .context("写入 WASM checker 答案失败")?;
    std::fs::write(directory.path().join("checker.out"), actual)
        .context("写入 WASM checker 输出失败")?;
    let args = vec![
        "checker".to_string(),
        "checker.in".to_string(),
        "checker.out".to_string(),
        "checker.ans".to_string(),
    ];
    run_module_with_files(
        module_bytes,
        &[],
        memory_limit_mb,
        fuel_budget,
        profile,
        &args,
        Some(directory.path()),
        FsPerms::ReadOnly,
        Some(wall_limit_ms),
    )
    .await
}

#[allow(clippy::too_many_arguments)]
async fn run_module_with_files(
    module_bytes: &[u8],
    input: &[u8],
    memory_limit_mb: u64,
    fuel_budget: u64,
    profile: &OiCostProfile,
    args: &[String],
    preopened_dir: Option<&Path>,
    preopened_perms: FsPerms,
    wall_limit_ms: Option<u64>,
) -> Result<WasmRunResult> {
    profile.validate().map_err(anyhow::Error::msg)?;
    let cpu_started_ns = thread_cpu_time_ns();
    let started = Instant::now();

    let mut config = Config::new();
    config.epoch_interruption(true);
    config.consume_fuel(true);
    config.operator_cost(operator_cost_from_profile(profile));
    config.wasm_multi_memory(false);
    config.wasm_memory64(false);
    // 固定 guest 调用栈上限；线性内存上限不能约束深递归使用的 Wasmtime
    // 执行栈，因此单独保留保守的 512 KiB 限制。
    config.max_wasm_stack(512 * 1024);
    // 允许 Wasmtime 在 Tokio worker 之外运行，但不让 guest 通过 epoch
    // 或 host callback 改写平台计时；fuel 是唯一的 guest 预算。
    let engine = Engine::new(&config)
        .map_err(|error| anyhow::anyhow!("创建 Wasmtime engine 失败: {error}"))?;
    let module = Module::new(&engine, module_bytes)
        .map_err(|error| anyhow::anyhow!("解析 Wasm 模块失败: {error}"))?;

    let stdin = MemoryInputPipe::new(input.to_vec());
    let stdout = MemoryOutputPipe::new(MAX_OUTPUT_BYTES);
    let stderr = MemoryOutputPipe::new(MAX_OUTPUT_BYTES);
    let stdout_view = stdout.clone();
    let stderr_view = stderr.clone();
    let mut builder = WasiCtxBuilder::new();
    builder
        .stdin(stdin)
        .stdout(stdout)
        .stderr(stderr)
        .wall_clock(DeterministicWallClock)
        .monotonic_clock(DeterministicMonotonicClock)
        .insecure_random_seed(0);
    builder.args(args);
    if let Some(directory) = preopened_dir {
        // 传统文件输入代码通常以相对路径打开 `foo.in`；同时保留绝对
        // `/workspace/...` 兼容路径，两个 guest 别名都指向同一个一次性目录。
        builder
            .preopened_dir(directory, ".", preopened_perms)
            .map_err(|error| anyhow::anyhow!("预打开 WASM checker 目录失败: {error}"))?;
        builder
            .preopened_dir(directory, "/workspace", preopened_perms)
            .map_err(|error| anyhow::anyhow!("预打开 WASM 兼容工作目录失败: {error}"))?;
    }
    let state = WasiState {
        wasi: builder.build_p1(),
        limits: StoreLimitsBuilder::new()
            .memory_size((memory_limit_mb.clamp(1, 512) * 1024 * 1024) as usize)
            .table_elements(16_384)
            .instances(64)
            .tables(64)
            .memories(16)
            .trap_on_grow_failure(true)
            .build(),
    };
    let mut store = Store::new(&engine, state);
    store.limiter(|state| &mut state.limits);
    store
        .set_fuel(fuel_budget)
        .map_err(|error| anyhow::anyhow!("设置 Wasm fuel 预算失败: {error}"))?;

    let mut linker = Linker::new(&engine);
    p1::add_to_linker_async(&mut linker, |state: &mut WasiState| &mut state.wasi)
        .map_err(|error| anyhow::anyhow!("注册 WASI 导入失败: {error}"))?;
    // 必须在实例化前设置 deadline：Wasm start 段也能执行用户代码。
    store.set_epoch_deadline(if wall_limit_ms.is_some() { 1 } else { u64::MAX });
    // epoch 中断负责打断纯计算 guest；tokio timeout 负责取消可取消的 WASI
    // 异步调用。两者同时使用，避免 guest 在无限循环或 sleep 中绕过墙钟限制。
    let timer = wall_limit_ms.map(|limit| {
        let (cancel_tx, cancel_rx) = mpsc::channel();
        let timer_engine = engine.clone();
        let handle = std::thread::spawn(move || {
            if cancel_rx
                .recv_timeout(std::time::Duration::from_millis(limit))
                .is_err()
            {
                timer_engine.increment_epoch();
            }
        });
        (cancel_tx, handle)
    });
    let output_limit_triggered = Arc::new(AtomicBool::new(false));
    let output_monitor_stop = Arc::new(AtomicBool::new(false));
    let output_monitor = if let Some(directory) = preopened_dir {
        if matches!(preopened_perms, FsPerms::ReadWrite) {
            let baseline = directory_size(directory)?;
            let directory = directory.to_path_buf();
            let triggered = output_limit_triggered.clone();
            let stop = output_monitor_stop.clone();
            let monitor_engine = engine.clone();
            Some(std::thread::spawn(move || {
                while !stop.load(Ordering::Relaxed) {
                    if directory_size(&directory)
                        .map(|current| current.saturating_sub(baseline) > MAX_OUTPUT_BYTES as u64)
                        // 无法继续观测目录时停止执行，不能静默取消配额保护。
                        .unwrap_or(true)
                    {
                        triggered.store(true, Ordering::Relaxed);
                        monitor_engine.increment_epoch();
                        break;
                    }
                    std::thread::sleep(std::time::Duration::from_millis(5));
                }
            }))
        } else {
            None
        }
    } else {
        None
    };
    let execute = async {
        let instance = linker.instantiate_async(&mut store, &module).await?;
        let start = instance.get_typed_func::<(), ()>(&mut store, "_start")?;
        start.call_async(&mut store, ()).await
    };
    let (call, wall_timed_out) = if let Some(limit) = wall_limit_ms {
        match tokio::time::timeout(std::time::Duration::from_millis(limit), execute).await {
            Ok(result) => (Some(result), false),
            Err(_) => (None, true),
        }
    } else {
        (Some(execute.await), false)
    };
    if let Some((cancel_tx, handle)) = timer {
        let _ = cancel_tx.send(());
        let _ = handle.join();
    }
    output_monitor_stop.store(true, Ordering::Relaxed);
    if let Some(handle) = output_monitor {
        let _ = handle.join();
    }
    let exit_code = call
        .as_ref()
        .and_then(|result| result.as_ref().err())
        .and_then(|error| {
            error
                .downcast_ref::<wasmtime_wasi::I32Exit>()
                .map(|exit| exit.0)
        });
    let cpu_time_ms = match (cpu_started_ns, thread_cpu_time_ns()) {
        (Some(start), Some(end)) if end >= start => Some((end - start) / 1_000_000),
        _ => None,
    };
    let wall_time_ms = started.elapsed().as_millis() as u64;
    let stdout = stdout_view.contents().to_vec();
    let stderr = stderr_view.contents().to_vec();
    let fuel_consumed = store
        .get_fuel()
        .ok()
        .map(|remaining| fuel_budget.saturating_sub(remaining));

    let mut status = if output_limit_triggered.load(Ordering::Relaxed)
        || stdout.len().saturating_add(stderr.len()) >= MAX_OUTPUT_BYTES
    {
        WasmStatus::OutputLimitExceeded
    } else if wall_timed_out {
        WasmStatus::TimeLimitExceeded
    } else {
        match call.expect("WASM 调用结果必须存在") {
            Ok(()) if stdout.len() >= MAX_OUTPUT_BYTES || stderr.len() >= MAX_OUTPUT_BYTES => {
                WasmStatus::OutputLimitExceeded
            }
            Ok(()) => WasmStatus::Accepted,
            Err(_error) if exit_code == Some(0) => WasmStatus::Accepted,
            Err(error) => {
                let message = format!("{error:#}").to_ascii_lowercase();
                let trap_is_limit = error.downcast_ref::<wasmtime::Trap>().is_some_and(|trap| {
                    matches!(trap, wasmtime::Trap::OutOfFuel | wasmtime::Trap::Interrupt)
                });
                if trap_is_limit
                    || message.contains("fuel")
                    || message.contains("out of fuel")
                    || message.contains("epoch")
                    || message.contains("deadline")
                {
                    WasmStatus::TimeLimitExceeded
                } else if message.contains("beyond capacity") || message.contains("output") {
                    WasmStatus::OutputLimitExceeded
                } else if is_memory_limit_message(&format!("{error:#}")) {
                    WasmStatus::MemoryLimitExceeded
                } else {
                    WasmStatus::RuntimeError
                }
            }
        }
    };
    if status == WasmStatus::RuntimeError && fuel_consumed == Some(fuel_budget) {
        status = WasmStatus::TimeLimitExceeded;
    }
    // proc_exit(0) 也是正常退出；不能绕过 stdout/stderr 的合计输出限制。
    if status == WasmStatus::Accepted
        && stdout.len().saturating_add(stderr.len()) >= MAX_OUTPUT_BYTES
    {
        status = WasmStatus::OutputLimitExceeded;
    }
    Ok(WasmRunResult {
        status,
        stdout,
        stderr,
        fuel_consumed,
        cpu_time_ms,
        wall_time_ms,
        exit_code,
    })
}

/// 读取当前 Wasmtime 执行线程的 CPU 时间。WASM 计量在 `spawn_blocking` 的
/// 固定执行线程内完成，避免把 Tokio 其它任务的时间混入用户结果；非 Unix
/// 平台没有可移植的线程 CPU 时钟时保留空值，等效 fuel 与墙钟仍然有效。
fn thread_cpu_time_ns() -> Option<u64> {
    #[cfg(unix)]
    {
        let mut timespec = libc::timespec {
            tv_sec: 0,
            tv_nsec: 0,
        };
        // SAFETY: `timespec` 是有效的可写指针，clock id 为当前线程时钟。
        let result = unsafe { libc::clock_gettime(libc::CLOCK_THREAD_CPUTIME_ID, &mut timespec) };
        if result != 0 || timespec.tv_sec < 0 || timespec.tv_nsec < 0 {
            return None;
        }
        let seconds = u64::try_from(timespec.tv_sec).ok()?;
        let nanos = u64::try_from(timespec.tv_nsec).ok()?;
        seconds.checked_mul(1_000_000_000)?.checked_add(nanos)
    }
    #[cfg(not(unix))]
    {
        None
    }
}

/// 执行一个 OI WASM 任务。成本表和 WASI 编译器均来自 worker 配置/服务端，
/// 用户消息不能替换它们。
#[allow(clippy::too_many_arguments)]
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
    if config.backend != OiBackend::Wasm {
        anyhow::bail!("WASM runner 收到非 WASM 配置");
    }
    profile.validate().map_err(anyhow::Error::msg)?;
    let language = task.language.clone();
    let source = task.code.clone();
    let compile_files = user_compile_files.clone();
    let wasm = match tokio::task::spawn_blocking(move || {
        if compile_files.is_empty() {
            compile_source(&language, &source)
        } else {
            compile_source_with_files(&language, &source, &compile_files)
        }
    })
    .await
    {
        Ok(Ok(wasm)) => wasm,
        Ok(Err(error))
            if error
                .downcast_ref::<CompilerInfrastructureError>()
                .is_some() =>
        {
            tracing::error!(error = %error, "WASI 编译基础设施不可用");
            return uniform_status_result(task, config, OiStatus::SystemError);
        }
        Ok(Err(error)) => {
            tracing::warn!(error = %error, "WASI 用户程序编译失败");
            return uniform_status_result(task, config, OiStatus::CompileError);
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
        match tokio::task::spawn_blocking(move || {
            compile_source_with_files("cc", &source, &checker_compile_files_for_compile)
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
        .map(|(case_id, input, expected)| (case_id.clone(), (input.clone(), expected.clone())))
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
        let batch = runnable.into_iter().take(2).collect::<Vec<_>>();
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
                profile,
                &user_extra_files,
                &checker_extra_files,
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
    Ok(evaluation.to_judge_result(&task.submission_id, task.rejudge_seq, None, None))
}

/// 子任务内部仍按题目声明顺序运行测试点；不同的就绪子任务最多并发两个。
#[allow(clippy::too_many_arguments)]
async fn run_wasm_subtask(
    wasm: &[u8],
    checker_module: Option<&[u8]>,
    config: &OiRuntimeConfig,
    subtask_index: usize,
    case_data: &HashMap<String, (Vec<u8>, Vec<u8>)>,
    profile: &OiCostProfile,
    user_extra_files: &HashMap<String, Vec<u8>>,
    checker_extra_files: &HashMap<String, Vec<u8>>,
) -> Result<(bool, Vec<OiCaseResult>)> {
    let subtask = &config.subtasks[subtask_index];
    let mut results = Vec::with_capacity(subtask.cases.len());
    for case in &subtask.cases {
        let (input, expected) = case_data
            .get(&case.input)
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
        )
        .await?;
        let passed = result.status == OiStatus::Accepted;
        results.push(result);
        if !passed {
            return Ok((false, results));
        }
    }
    Ok((true, results))
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
    // 输入大小不能奖励额外 CPU 预算，预算严格由等效时间换算。
    let fuel = (limit as f64 * fuel_per_ms).floor() as u64;
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
    let user = tokio::task::spawn_blocking(move || {
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .context("创建 WASM 测试点运行时失败")?;
        runtime.block_on(run_module_with_files(
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
        let checker_fuel = (limit as f64 * profile.fuel_per_ms).floor() as u64;
        let checker_module = module.to_vec();
        let checker_input = input.to_vec();
        let checker_expected = expected_for_run.clone();
        let checker_actual = user.stdout.clone();
        let checker_profile = profile.clone();
        let checker_extra_files = checker_extra_files.clone();
        Some(
            tokio::task::spawn_blocking(move || {
                let runtime = tokio::runtime::Builder::new_current_thread()
                    .enable_all()
                    .build()
                    .context("创建 WASM checker 运行时失败")?;
                runtime.block_on(run_checker_module(
                    &checker_module,
                    &checker_input,
                    &checker_expected,
                    &checker_actual,
                    memory,
                    checker_fuel.max(1),
                    &checker_profile,
                    &checker_extra_files,
                    wall_budget_ms(limit),
                ))
            })
            .await
            .context("WASM checker 执行线程异常")??,
        )
    } else {
        None
    };
    let (run, checker) = (user, checker);
    let status = match run.status {
        WasmStatus::Accepted if checker_kind == OiCheckerType::Testlib => match checker {
            // 新版 wasi-libc 在 main 返回 0 时直接从 _start 返回，不调用 proc_exit。
            Some(checker) if checker.status == WasmStatus::Accepted => OiStatus::Accepted,
            Some(checker)
                if checker.status == WasmStatus::RuntimeError && checker.exit_code.is_some() =>
            {
                OiStatus::WrongAnswer
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
    };
    let equivalent = run
        .fuel_consumed
        .map(|fuel| ((fuel as f64 / fuel_per_ms).ceil() as u64).max(1));
    Ok(OiCaseResult {
        case_id: Some(case.input.clone()),
        input: case.input.clone(),
        status,
        time_ms: equivalent,
        memory_kb: None,
        cpu_time_ms: run.cpu_time_ms,
        wall_time_ms: Some(run.wall_time_ms),
        equivalent_time_ms: equivalent,
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

/// native OI 使用题目时限作为 CPU 预算；WASM 还需要给真实宿主调用留出
/// 余量，因此墙钟上限固定为等效时限的三倍，并仍受外层任务看门狗约束。
fn wall_budget_ms(limit_ms: u64) -> u64 {
    limit_ms.saturating_mul(3).max(1)
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

/// 编译阶段没有测试点执行结果时，仍按 OI scorer 的依赖语义补齐结果：首个
/// 失败子任务得到 CE/SE，依赖它的子任务得到 IGN，而不会把用户错误提升成
/// worker 未分类异常。
fn uniform_status_result(
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
    let evaluation: OiEvaluation =
        score_submission(config, &case_results).map_err(anyhow::Error::msg)?;
    Ok(evaluation.to_judge_result(&task.submission_id, task.rejudge_seq, None, None))
}

/// 建立与 Wasmtime 默认算子成本兼容的表。校准表的摘要仍绑定任务，
/// 版本必须与当前 Wasmtime 一致；未知字段在执行前拒绝。
pub fn operator_cost_from_profile(profile: &OiCostProfile) -> OperatorCost {
    let mut cost = OperatorCost::default();
    // 这些变量成本直接对应 Wasmtime 49 的公开字段；其余算子保留运行时默认值。
    if let Some(value) = profile.variable_costs.get("memory_copy_per_byte") {
        cost.variable.memory_copy_per_byte = *value;
    }
    if let Some(value) = profile.variable_costs.get("memory_fill_per_byte") {
        cost.variable.memory_fill_per_byte = *value;
    }
    if let Some(value) = profile.variable_costs.get("memory_init_per_byte") {
        cost.variable.memory_init_per_byte = *value;
    }
    if let Some(value) = profile.variable_costs.get("memory_grow_per_page") {
        cost.variable.memory_grow_per_page = *value;
    }
    if let Some(value) = profile.variable_costs.get("table_copy_per_element") {
        cost.variable.table_copy_per_element = *value;
    }
    if let Some(value) = profile.variable_costs.get("table_fill_per_element") {
        cost.variable.table_fill_per_element = *value;
    }
    if let Some(value) = profile.variable_costs.get("table_init_per_element") {
        cost.variable.table_init_per_element = *value;
    }
    if let Some(value) = profile.variable_costs.get("table_grow_per_element") {
        cost.variable.table_grow_per_element = *value;
    }
    if let Some(value) = profile.variable_costs.get("array_copy_per_element") {
        cost.variable.array_copy_per_element = *value;
    }
    if let Some(value) = profile.variable_costs.get("array_fill_per_element") {
        cost.variable.array_fill_per_element = *value;
    }
    if let Some(value) = profile.variable_costs.get("array_new_data_per_element") {
        cost.variable.array_new_data_per_element = *value;
    }
    if let Some(value) = profile.variable_costs.get("array_init_data_per_element") {
        cost.variable.array_init_data_per_element = *value;
    }
    if let Some(value) = profile.variable_costs.get("array_new_elem_per_element") {
        cost.variable.array_new_elem_per_element = *value;
    }
    if let Some(value) = profile.variable_costs.get("array_init_elem_per_element") {
        cost.variable.array_init_elem_per_element = *value;
    }
    if let Some(value) = profile.variable_costs.get("array_new_default_per_element") {
        cost.variable.array_new_default_per_element = *value;
    }
    if let Some(value) = profile.variable_costs.get("array_new_per_element") {
        cost.variable.array_new_per_element = *value;
    }
    cost
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    fn profile() -> OiCostProfile {
        OiCostProfile {
            schema_version: 1,
            runtime_version: "wasmtime-49".to_string(),
            costs: HashMap::from([(String::from("default"), 1)]),
            variable_costs: HashMap::new(),
            io_fuel_per_byte: 1,
            fuel_per_ms: 1000.0,
            hash: "a".repeat(64),
            toolchain: None,
            benchmark: None,
            hardware: None,
        }
    }

    #[tokio::test]
    async fn fuel_exhaustion_is_tle() {
        let wat = r#"(module (func (export "_start") (loop br 0)))"#;
        let result = run_module(wat.as_bytes(), b"", 16, 100, &profile())
            .await
            .unwrap();
        assert_eq!(result.status, WasmStatus::TimeLimitExceeded);
        assert_eq!(result.fuel_consumed, Some(100));
    }

    #[tokio::test]
    async fn wall_deadline_interrupts_guest() {
        let wat = r#"(module (func (export "_start") (loop br 0)))"#;
        let result = run_module_with_files(
            wat.as_bytes(),
            b"",
            16,
            u64::MAX / 4,
            &profile(),
            &[],
            None,
            FsPerms::ReadOnly,
            Some(20),
        )
        .await
        .unwrap();
        assert_eq!(result.status, WasmStatus::TimeLimitExceeded);
        assert!(result.wall_time_ms < 1_000);
    }
    #[tokio::test]
    async fn instantiation_start_is_subject_to_wall_deadline() {
        let wat = r#"(module (func $init (loop br 0)) (start $init) (func (export "_start")))"#;
        let result = run_module_with_files(
            wat.as_bytes(),
            b"",
            16,
            u64::MAX / 4,
            &profile(),
            &[],
            None,
            FsPerms::ReadOnly,
            Some(20),
        )
        .await
        .unwrap();
        assert_eq!(result.status, WasmStatus::TimeLimitExceeded);
        assert!(result.wall_time_ms < 1000);
    }

    #[tokio::test]
    async fn returning_guest_without_wall_deadline_is_accepted() {
        let result = run_module(
            b"(module (func (export \"_start\")))",
            b"",
            16,
            100,
            &profile(),
        )
        .await
        .unwrap();
        assert_eq!(result.status, WasmStatus::Accepted);
    }
    #[tokio::test]
    async fn out_of_bounds_load_is_re_not_mle() {
        let result = run_module(
            br#"(module (memory 1) (func (export "_start") i32.const 65536 i32.load drop))"#,
            b"",
            16,
            100,
            &profile(),
        )
        .await
        .unwrap();
        assert_eq!(result.status, WasmStatus::RuntimeError);
    }

    #[tokio::test]
    async fn memory_grow_beyond_limit_is_mle() {
        let result = run_module(
            br#"(module (memory 1) (func (export "_start") i32.const 1024 memory.grow drop))"#,
            b"",
            1,
            u64::MAX / 4,
            &profile(),
        )
        .await
        .unwrap();
        assert_eq!(result.status, WasmStatus::MemoryLimitExceeded);
    }
    #[tokio::test]
    async fn wasi_stdout_limit_is_ole_even_when_guest_tries_to_exit_successfully() {
        let wat = br#"(module
            (import "wasi_snapshot_preview1" "fd_write" (func $write (param i32 i32 i32 i32) (result i32)))
            (import "wasi_snapshot_preview1" "proc_exit" (func $exit (param i32)))
            (memory (export "memory") 514)
            (func (export "_start")
                i32.const 0 i32.const 1024 i32.store
                i32.const 4 i32.const 33554433 i32.store
                i32.const 1 i32.const 0 i32.const 1 i32.const 8 call $write drop
                i32.const 0 call $exit))"#;
        let result = run_module(wat, b"", 64, 10000, &profile()).await.unwrap();
        assert_eq!(result.status, WasmStatus::OutputLimitExceeded);
    }
}
