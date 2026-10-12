//! 独立调度基准：只使用指定测试 Redis 命名空间，不读写站点队列或成绩。
use anyhow::{Context, Result};
use noj_judge::oi::progress::ProgressReporter;
use noj_judge::oi::{OiCostProfile, OiRuntimeConfig};
use noj_judge::scheduling::{Pool, Scheduler, Settings};
use noj_judge::types::JudgeTask;
use serde_json::json;
use std::collections::HashMap;
use std::path::Path;
use std::sync::Arc;

fn percentile(values: &[u64], percent: usize) -> u64 {
    if values.is_empty() {
        return 0;
    }
    let mut sorted = values.to_vec();
    sorted.sort_unstable();
    sorted[(sorted.len() * percent)
        .div_ceil(100)
        .saturating_sub(1)
        .min(sorted.len() - 1)]
}

fn cpu_time_ms(who: libc::c_int) -> u64 {
    let mut usage = std::mem::MaybeUninit::<libc::rusage>::uninit();
    if unsafe { libc::getrusage(who, usage.as_mut_ptr()) } != 0 {
        return 0;
    }
    let usage = unsafe { usage.assume_init() };
    (usage.ru_utime.tv_sec.max(0) as u64 + usage.ru_stime.tv_sec.max(0) as u64) * 1000
        + (usage.ru_utime.tv_usec.max(0) as u64 + usage.ru_stime.tv_usec.max(0) as u64) / 1000
}

async fn run_submission(
    task: &JudgeTask,
    config: &OiRuntimeConfig,
    cases: &[(String, Vec<u8>, Vec<u8>)],
    profile: &OiCostProfile,
    scheduler: &Scheduler,
    slots: u64,
    index: usize,
) -> Result<serde_json::Value> {
    let data_bytes = cases
        .iter()
        .map(|(_, input, output)| input.len() + output.len())
        .sum::<usize>();
    let max_memory = config
        .subtasks
        .iter()
        .flat_map(|group| {
            group.cases.iter().map(move |case| {
                case.memory_limit_mb
                    .or(group.memory_limit_mb)
                    .unwrap_or(config.memory_limit_mb)
            })
        })
        .max()
        .unwrap_or(config.memory_limit_mb);
    let queued = std::time::Instant::now();
    let mut task = task.clone();
    task.submission_id = format!("benchmark-{index}");
    task.user_id = format!("benchmark-user-{index}");
    let parent = Arc::new(
        scheduler
            .try_task(
                Pool::Wasm,
                (data_bytes as u64).saturating_mul(2).div_ceil(1024 * 1024) + 128,
                512.max(max_memory + 128),
            )
            .await?
            .context("基准最低资源无法准入")?,
    );
    let progress =
        ProgressReporter::new(&task, None, config).with_scheduling(Some((scheduler, &parent)));
    let admission_wait_ms = queued.elapsed().as_millis();
    let started = std::time::Instant::now();
    let result = noj_judge::oi::wasm::evaluate_wasm_with_progress(
        &task,
        config,
        cases,
        profile,
        None,
        &HashMap::new(),
        &HashMap::new(),
        &HashMap::new(),
        Some(&progress),
    )
    .await?;
    let wall_ms = started.elapsed().as_millis();
    let waits = progress.wait_samples().await;
    let run_wait = waits
        .iter()
        .filter(|(kind, _)| kind == "run")
        .map(|(_, value)| *value)
        .collect::<Vec<_>>();
    let mut usage = std::mem::MaybeUninit::<libc::rusage>::uninit();
    let peak_kb = if unsafe { libc::getrusage(libc::RUSAGE_SELF, usage.as_mut_ptr()) } == 0 {
        unsafe { usage.assume_init() }.ru_maxrss
    } else {
        0
    };
    let report = json!({"slots":slots,"admission_wait_ms":admission_wait_ms,"case_count":cases.len(),"wall_ms":wall_ms,
        "cases_per_second":cases.len() as f64/(wall_ms.max(1) as f64/1000.0),
        "run_wait_p50_ms":percentile(&run_wait,50),"run_wait_p95_ms":percentile(&run_wait,95),
        "process_peak_rss_kb":peak_kb,"source_hash":noj_judge::oi::standard::hash(task.code.as_bytes()),
        "standard_hash":noj_judge::oi::standard::manifest()["hash"],"result":result.details});
    drop((progress, parent));
    Ok::<_, anyhow::Error>(report)
}

#[tokio::main]
async fn main() -> Result<()> {
    let args = std::env::args().skip(1).collect::<Vec<_>>();
    anyhow::ensure!(
        (4..=5).contains(&args.len()),
        "用法: oi_pool_benchmark <source.cpp> <runtime.json> <data-directory> <slots> [jobs:1..4]"
    );
    let source = std::fs::read_to_string(&args[0])?;
    let config: OiRuntimeConfig = serde_json::from_slice(&std::fs::read(&args[1])?)?;
    anyhow::ensure!(
        config.backend == noj_judge::oi::OiBackend::Wasm,
        "基准只支持 WASM 后端"
    );
    anyhow::ensure!(
        config.checker.kind != noj_judge::oi::OiCheckerType::Testlib,
        "此入口未提供 checker 源码，不能验收 testlib 题"
    );
    anyhow::ensure!(
        config.compile_extra_files.is_empty()
            && config.user_extra_files.is_empty()
            && config.checker_extra_files.is_empty(),
        "此入口未提供额外文件，不能省略题目依赖进行验收"
    );
    let slots = args[3].parse::<u64>()?;
    anyhow::ensure!((1..=1024).contains(&slots), "并发必须在 1..=1024");
    let jobs = args
        .get(4)
        .map(|value| value.parse::<usize>())
        .transpose()?
        .unwrap_or(1);
    anyhow::ensure!((1..=4).contains(&jobs), "提交数必须在 1..=4");
    let root = Path::new(&args[2]);
    let mut cases = Vec::new();
    for group in &config.subtasks {
        for case in &group.cases {
            cases.push((
                case.input.clone(),
                std::fs::read(
                    root.join(Path::new(&case.input).file_name().context("输入路径缺失")?),
                )?,
                std::fs::read(
                    root.join(
                        Path::new(&case.output)
                            .file_name()
                            .context("答案路径缺失")?,
                    ),
                )?,
            ));
        }
    }
    let profile: OiCostProfile = noj_judge::oi::standard::profile();
    let task: JudgeTask = serde_json::from_value(
        json!({"submission_id":"benchmark-local","problem_id":"local","user_id":"benchmark",
        "priority":"low","judge_type":"oi","scheduling_version":1,"resource_pool":"oi-wasm",
        "runtime_config":config,"language":"cc","code":source,"oi_cost_profile":profile}),
    )?;
    let token = uuid::Uuid::new_v4().to_string();
    let prefix = format!("noj:test:pool-benchmark:{token}");
    let mut settings = Settings::from_env(&token)?;
    settings.group = token;
    settings.capacities.wasm_run = slots;
    let client =
        redis::Client::open(std::env::var("REDIS_URL").context("必须显式配置专用测试 Redis")?)?;
    let scheduler = Scheduler::connect(client.clone(), settings, &prefix).await?;
    let process_cpu_before = cpu_time_ms(libc::RUSAGE_SELF);
    let compiler_cpu_before = cpu_time_ms(libc::RUSAGE_CHILDREN);
    let batch_started = std::time::Instant::now();
    let runs =
        futures_util::future::join_all((0..jobs).map(|index| {
            run_submission(&task, &config, &cases, &profile, &scheduler, slots, index)
        }))
        .await
        .into_iter()
        .collect::<Result<Vec<_>>>()?;
    let wall_ms = batch_started.elapsed().as_millis();
    let mut report = if jobs == 1 {
        runs.into_iter().next().unwrap()
    } else {
        json!({"jobs":jobs,"slots":slots,"batch_wall_ms":wall_ms,
            "submissions_per_second":jobs as f64/(wall_ms.max(1) as f64/1000.0),"runs":runs})
    };
    report["process_cpu_ms"] =
        json!(cpu_time_ms(libc::RUSAGE_SELF).saturating_sub(process_cpu_before));
    report["compiler_cpu_ms"] =
        json!(cpu_time_ms(libc::RUSAGE_CHILDREN).saturating_sub(compiler_cpu_before));
    println!("{}", serde_json::to_string(&report)?);
    tokio::time::sleep(std::time::Duration::from_millis(100)).await;
    let mut conn = client.get_multiplexed_async_connection().await?;
    use redis::AsyncCommands;
    let keys: Vec<String> = conn.keys(format!("{prefix}:*")).await?;
    if !keys.is_empty() {
        let _: usize = conn.del(keys).await?;
    }
    Ok(())
}
