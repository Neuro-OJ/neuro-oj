//! WASM Engine/Module 生命周期和独立 Store 的资源保护。
use super::*;

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

/// 在独立目录中运行受信 checker，并保留墙钟和输出保护。
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
    run_prepared_checker(
        module_bytes,
        input,
        expected,
        actual,
        memory_limit_mb,
        fuel_budget,
        profile,
        extra_files,
        wall_limit_ms,
        None,
        None,
    )
    .await
}

#[allow(clippy::too_many_arguments)]
pub(super) async fn run_prepared_checker(
    module_bytes: &[u8],
    input: &[u8],
    expected: &[u8],
    actual: &[u8],
    memory_limit_mb: u64,
    fuel_budget: u64,
    profile: &OiCostProfile,
    extra_files: &HashMap<String, Vec<u8>>,
    wall_limit_ms: u64,
    prepared: Option<&PreparedModule>,
    cancellation: Option<Arc<AtomicBool>>,
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
    run_prepared_module(
        module_bytes,
        &[],
        memory_limit_mb,
        fuel_budget,
        profile,
        &args,
        Some(directory.path()),
        FsPerms::ReadOnly,
        Some(wall_limit_ms),
        0,
        cancellation,
        prepared,
    )
    .await
}

#[allow(clippy::too_many_arguments)]
pub(super) async fn run_module_with_files(
    module_bytes: &[u8],
    input: &[u8],
    memory_limit_mb: u64,
    fuel_budget: u64,
    profile: &OiCostProfile,
    args: &[String],
    preopened_dir: Option<&Path>,
    preopened_perms: FsPerms,
    wall_limit_ms: Option<u64>,
    cancellation: Option<Arc<AtomicBool>>,
) -> Result<WasmRunResult> {
    run_observed_module_with_files(
        module_bytes,
        input,
        memory_limit_mb,
        fuel_budget,
        profile,
        args,
        preopened_dir,
        preopened_perms,
        wall_limit_ms,
        0,
        cancellation,
    )
    .await
}

pub(super) fn engine_config(profile: &OiCostProfile) -> Config {
    let mut config = Config::new();
    config.epoch_interruption(true);
    config.consume_fuel(true);
    config.wasm_threads(false);
    config.wasm_relaxed_simd(false);
    config.cranelift_nan_canonicalization(true);
    config.operator_cost(operator_cost_from_profile(profile));
    config.wasm_multi_memory(false);
    config.wasm_memory64(false);
    // 固定 guest 调用栈上限；线性内存上限不能约束深递归使用的 Wasmtime
    // 执行栈，因此单独保留保守的 512 KiB 限制。
    config.max_wasm_stack(512 * 1024);
    // 允许 Wasmtime 在 Tokio worker 之外运行，但不让 guest 通过 epoch
    // 或 host callback 改写平台计时；fuel 是唯一的 guest 预算。
    config
}

struct EpochDriver {
    stop: mpsc::Sender<()>,
    handle: Option<std::thread::JoinHandle<()>>,
}
impl Drop for EpochDriver {
    fn drop(&mut self) {
        let _ = self.stop.send(());
        if let Some(handle) = self.handle.take() {
            let _ = handle.join();
        }
    }
}
#[derive(Clone)]
pub(super) struct PreparedModule {
    engine: Engine,
    module: Module,
    _epoch: Arc<EpochDriver>,
}
impl PreparedModule {
    pub(super) fn new(bytes: &[u8], profile: &OiCostProfile) -> Result<Self> {
        let engine = Engine::new(&engine_config(profile))?;
        let module = Module::new(&engine, bytes)?;
        let (stop, receiver) = mpsc::channel();
        let timer_engine = engine.clone();
        let handle = std::thread::spawn(move || {
            while matches!(
                receiver.recv_timeout(std::time::Duration::from_millis(10)),
                Err(mpsc::RecvTimeoutError::Timeout)
            ) {
                timer_engine.increment_epoch();
            }
        });
        Ok(Self {
            engine,
            module,
            _epoch: Arc::new(EpochDriver {
                stop,
                handle: Some(handle),
            }),
        })
    }
    pub(super) fn checker(&self, bytes: &[u8]) -> Result<Self> {
        Ok(Self {
            engine: self.engine.clone(),
            module: Module::new(&self.engine, bytes)?,
            _epoch: self._epoch.clone(),
        })
    }
}

#[allow(clippy::too_many_arguments)]
pub(super) async fn run_observed_module_with_files(
    module_bytes: &[u8],
    input: &[u8],
    memory_limit_mb: u64,
    fuel_budget: u64,
    profile: &OiCostProfile,
    args: &[String],
    preopened_dir: Option<&Path>,
    preopened_perms: FsPerms,
    wall_limit_ms: Option<u64>,
    observe_count: usize,
    cancellation: Option<Arc<AtomicBool>>,
) -> Result<WasmRunResult> {
    run_prepared_module(
        module_bytes,
        input,
        memory_limit_mb,
        fuel_budget,
        profile,
        args,
        preopened_dir,
        preopened_perms,
        wall_limit_ms,
        observe_count,
        cancellation,
        None,
    )
    .await
}

#[allow(clippy::too_many_arguments)]
pub(super) async fn run_prepared_module(
    module_bytes: &[u8],
    input: &[u8],
    memory_limit_mb: u64,
    fuel_budget: u64,
    profile: &OiCostProfile,
    args: &[String],
    preopened_dir: Option<&Path>,
    preopened_perms: FsPerms,
    wall_limit_ms: Option<u64>,
    observe_count: usize,
    cancellation: Option<Arc<AtomicBool>>,
    prepared: Option<&PreparedModule>,
) -> Result<WasmRunResult> {
    profile.validate().map_err(anyhow::Error::msg)?;

    let (engine, module) = if let Some(prepared) = prepared {
        (prepared.engine.clone(), prepared.module.clone())
    } else {
        let engine = Engine::new(&engine_config(profile))?;
        let module = Module::new(&engine, module_bytes)?;
        (engine, module)
    };

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
        .insecure_random_seed(0)
        .secure_random(crate::oi::standard::GuestRandom::new())
        .insecure_random(crate::oi::standard::GuestRandom::new());
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
    // JIT 属于编译准备，不能混入 guest 的 CPU/墙钟资源记录。
    let cpu_started_ns = thread_cpu_time_ns();
    let started = Instant::now();
    // epoch 中断负责打断纯计算 guest；tokio timeout 负责取消可取消的 WASI
    // 异步调用。两者同时使用，避免 guest 在无限循环或 sleep 中绕过墙钟限制。
    let timer = wall_limit_ms.filter(|_| prepared.is_none()).map(|limit| {
        let (cancel_tx, cancel_rx) = mpsc::channel();
        let timer_engine = engine.clone();
        let timer_cancellation = cancellation.clone();
        let handle = std::thread::spawn(move || {
            if let Some(cancelled) = timer_cancellation {
                let deadline = Instant::now() + std::time::Duration::from_millis(limit);
                loop {
                    if cancelled.load(Ordering::Relaxed) || Instant::now() >= deadline {
                        timer_engine.increment_epoch();
                        break;
                    }
                    if cancel_rx
                        .recv_timeout(std::time::Duration::from_millis(20))
                        .is_ok()
                    {
                        break;
                    }
                }
            } else if cancel_rx
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
    if prepared.is_some() {
        let deadline = wall_limit_ms.map(|limit| started + std::time::Duration::from_millis(limit));
        let flag = cancellation.clone();
        let output_flag = output_limit_triggered.clone();
        store.epoch_deadline_callback(move |_| {
            if deadline.is_some_and(|value| Instant::now() >= value)
                || flag
                    .as_ref()
                    .is_some_and(|flag| flag.load(Ordering::Relaxed))
                || output_flag.load(Ordering::Relaxed)
            {
                return Err(wasmtime::Error::new(wasmtime::Trap::Interrupt));
            }
            Ok(wasmtime::UpdateDeadline::Continue(1))
        });
        store.set_epoch_deadline(1);
    }
    let mut observed_instance = None;
    let execute = async {
        let instance = linker.instantiate_async(&mut store, &module).await?;
        observed_instance = Some(instance);
        let start = instance.get_typed_func::<(), ()>(&mut store, "_start")?;
        start.call_async(&mut store, ()).await
    };
    let (call, wall_timed_out) = if let Some(limit) = wall_limit_ms {
        let timed = tokio::time::timeout(std::time::Duration::from_millis(limit), execute);
        tokio::select! {
            result=timed=>match result {Ok(result)=>(Some(result),false),Err(_)=>(None,true)},
            _=async {
                let Some(cancelled)=cancellation.as_ref() else {std::future::pending::<()>().await;return;};
                while !cancelled.load(Ordering::Relaxed) {tokio::time::sleep(std::time::Duration::from_millis(20)).await;}
            }=>(None,false),
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
    let mut analysis_counters = Vec::new();
    if let Some(instance) = observed_instance {
        for index in 0..observe_count {
            let global = instance
                .get_global(&mut store, &format!("__noj_analysis_{index}"))
                .context("插桩计数器缺失")?;
            let value = global.get(&mut store).i64().context("插桩计数器类型错误")?;
            analysis_counters.push(u64::try_from(value).context("插桩计数器溢出")?);
        }
    }

    let mut status = if output_limit_triggered.load(Ordering::Relaxed)
        || stdout.len().saturating_add(stderr.len()) >= MAX_OUTPUT_BYTES
    {
        WasmStatus::OutputLimitExceeded
    } else if wall_timed_out {
        WasmStatus::SystemError
    } else {
        match call.expect("WASM 调用结果必须存在") {
            Ok(()) if stdout.len() >= MAX_OUTPUT_BYTES || stderr.len() >= MAX_OUTPUT_BYTES => {
                WasmStatus::OutputLimitExceeded
            }
            Ok(()) => WasmStatus::Accepted,
            Err(_error) if exit_code == Some(0) => WasmStatus::Accepted,
            Err(error) => {
                let message = format!("{error:#}").to_ascii_lowercase();
                let trap_is_limit = error
                    .downcast_ref::<wasmtime::Trap>()
                    .is_some_and(|trap| matches!(trap, wasmtime::Trap::OutOfFuel));
                if trap_is_limit || message.contains("fuel") || message.contains("out of fuel") {
                    WasmStatus::TimeLimitExceeded
                } else if error.downcast_ref::<wasmtime::Trap>() == Some(&wasmtime::Trap::Interrupt)
                {
                    WasmStatus::SystemError
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
        analysis_counters,
    })
}

/// 读取当前 Wasmtime 执行线程的 CPU 时间。WASM 计量在 `spawn_blocking` 的
/// 固定执行线程内完成，避免把 Tokio 其它任务的时间混入用户结果；非 Unix
/// 平台没有可移植的线程 CPU 时钟时保留空值，等效 fuel 与墙钟仍然有效。
pub(super) fn thread_cpu_time_ns() -> Option<u64> {
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
