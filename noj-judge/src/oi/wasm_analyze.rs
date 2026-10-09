//! 独立、只读的 WASM 分类分析；不参与正式 MQ 判题。
mod instrument;
mod native;
mod provenance;

use super::{standard, wasm, wasm_compile, OiCheckerType, OiRuntimeConfig, OiStatus};
use anyhow::{Context, Result};
use provenance::{Category, Origin};
use serde::Serialize;
use serde_json::{json, Value};
use std::{
    collections::{BTreeMap, HashMap},
    path::PathBuf,
};

pub const RULE_VERSION: &str = "noj-wasm-analysis-v1";
#[derive(Debug)]
pub struct Options {
    pub source: PathBuf,
    pub language: String,
    pub config: PathBuf,
    pub package: PathBuf,
    pub output: PathBuf,
    pub artifacts: PathBuf,
    pub repeat: usize,
    pub case: Option<String>,
    pub native_image: Option<String>,
}
#[derive(Serialize)]
struct RunReport {
    verdict: OiStatus,
    fuel: Option<u64>,
    cpu_time_ms: Option<u64>,
    wall_time_ms: u64,
    output_sha256: String,
    equivalent_time_ms: Option<u64>,
}
#[derive(Serialize)]
struct Hotspot {
    origin: Origin,
    cost: u64,
}
#[derive(Serialize)]
struct AnalysisRun {
    complete: bool,
    analysis_output_verdict: Option<OiStatus>,
    termination: String,
    raw_fuel: Option<u64>,
    raw_budget: u64,
    cpu_time_ms: Option<u64>,
    wall_time_ms: u64,
    output_sha256: String,
    categories: BTreeMap<Category, u64>,
    hotspots: Vec<Hotspot>,
    /// 仅分类工作量的假设换算，不是新判题结果。
    hypothetical_without_io_candidate_ms: Option<u64>,
}
#[derive(Serialize)]
struct CaseReport {
    input: String,
    input_sha256: String,
    expected_sha256: String,
    time_limit_ms: u64,
    memory_limit_mb: u64,
    fuel_budget: u64,
    baseline: Vec<RunReport>,
    analysis: Vec<AnalysisRun>,
    classification_reproducible: Option<bool>,
    completed_outputs_match: Option<bool>,
    native: Option<Value>,
}

fn select<'a>(
    paths: impl IntoIterator<Item = &'a String>,
    files: &HashMap<String, Vec<u8>>,
) -> HashMap<String, Vec<u8>> {
    paths
        .into_iter()
        .map(|p| (p.clone(), files[p].clone()))
        .collect()
}
fn status(run: &wasm::WasmRunResult) -> OiStatus {
    use wasm::WasmStatus as W;
    match run.status {
        W::Accepted => OiStatus::Accepted,
        W::TimeLimitExceeded => OiStatus::TimeLimitExceeded,
        W::MemoryLimitExceeded => OiStatus::MemoryLimitExceeded,
        W::OutputLimitExceeded => OiStatus::OutputLimitExceeded,
        W::RuntimeError => OiStatus::RuntimeError,
        W::FormatError => OiStatus::FormatError,
        W::SystemError => OiStatus::SystemError,
    }
}
#[allow(clippy::too_many_arguments)]
async fn verdict(
    run: &wasm::WasmRunResult,
    config: &OiRuntimeConfig,
    checker: Option<&[u8]>,
    input: &[u8],
    expected: &[u8],
    checker_files: &HashMap<String, Vec<u8>>,
    time_limit_ms: u64,
    memory_limit_mb: u64,
) -> Result<OiStatus> {
    if run.status != wasm::WasmStatus::Accepted {
        return Ok(status(run));
    }
    if config.checker.kind == OiCheckerType::Testlib {
        let checked = wasm::run_checker_module(
            checker.context("checker 缺失")?,
            input,
            expected,
            &run.stdout,
            memory_limit_mb,
            standard::fuel_budget(time_limit_ms)?,
            &standard::profile(),
            checker_files,
            time_limit_ms.saturating_mul(10).max(30_000),
        )
        .await?;
        return Ok(if checked.status == wasm::WasmStatus::Accepted {
            OiStatus::Accepted
        } else if let Some(code) = checked.exit_code {
            super::testlib_verdict_from_exit(Some(i64::from(code)))
        } else {
            OiStatus::SystemError
        });
    }
    Ok(
        if super::runner::check_output(config.checker.kind, expected, &run.stdout) {
            OiStatus::Accepted
        } else {
            OiStatus::WrongAnswer
        },
    )
}

/// 所有运行在当前线程 runtime 中串行执行，CPU 时间不混入其它异步任务。
pub async fn analyze(options: Options) -> Result<Value> {
    anyhow::ensure!(
        matches!(options.language.as_str(), "c" | "cc"),
        "语言必须是 c 或 cc"
    );
    anyhow::ensure!((1..=10).contains(&options.repeat), "重复次数必须为 1..10");
    anyhow::ensure!(
        std::env::var_os("JUDGE_WASI_SYSROOT").is_some(),
        "独立分析请显式设置 JUDGE_WASI_SYSROOT，以纳入编译文件权限"
    );
    super::toolchain::validate_configured_toolchain()?;
    let source = std::fs::read_to_string(&options.source)?;
    anyhow::ensure!(source.len() <= 4 * 1024 * 1024, "源码过大");
    let config: OiRuntimeConfig = serde_json::from_slice(&std::fs::read(&options.config)?)?;
    let files = super::runner::index_files(
        crate::sandbox::container::extract_zip_entries_from_file(&options.package)?,
    )?;
    super::runner::validate_references(&config, &files)?;
    super::subtask_execution_order(&config).map_err(anyhow::Error::msg)?;
    // 完整配置验证沿用正式 scorer，给每个声明的点一个占位 AC。
    let placeholder: Vec<_> = config
        .subtasks
        .iter()
        .flat_map(|s| &s.cases)
        .map(|case| super::OiCaseResult {
            stdout: None,
            stderr: None,
            stdout_truncated: None,
            stderr_truncated: None,
            score: None,
            max_score: None,
            case_id: None,
            input: case.input.clone(),
            status: OiStatus::Accepted,
            time_ms: None,
            memory_kb: None,
            cpu_time_ms: None,
            wall_time_ms: None,
            equivalent_time_ms: None,
            fuel_consumed: None,
            fuel_budget: None,
            termination_reason: None,
        })
        .collect();
    super::score_submission(&config, &placeholder).map_err(anyhow::Error::msg)?;
    let user_files = select(&config.user_extra_files, &files);
    let compile_files = select(
        config
            .compile_extra_files
            .iter()
            .chain(&config.user_extra_files),
        &files,
    );
    let checker_files = select(&config.checker_extra_files, &files);
    let baseline =
        wasm_compile::compile_source_with_files(&options.language, &source, &compile_files)?;
    let compiled = wasm_compile::compile_for_analysis(&options.language, &source, &compile_files)?;
    anyhow::ensure!(
        compiled.object.starts_with(b"\0asm"),
        "分析目标文件不允许 LLVM bitcode/LTO"
    );
    let instrumented = instrument::instrument(&compiled.module)?;
    let origins = provenance::resolve(
        &compiled,
        &instrumented.body_ranges,
        instrumented.imported_functions,
    )?;
    let checker = if config.checker.kind == OiCheckerType::Testlib {
        let extra = select(
            config
                .compile_extra_files
                .iter()
                .chain(&config.checker_extra_files),
            &files,
        );
        let text =
            std::str::from_utf8(&files[config.checker.path.as_ref().context("checker 路径缺失")?])?;
        Some(wasm_compile::compile_source_with_files("cc", text, &extra)?)
    } else {
        None
    };
    anyhow::ensure!(
        !options.artifacts.exists(),
        "产物目录已存在，请使用新的目录"
    );
    std::fs::create_dir_all(&options.artifacts)?;
    std::fs::write(options.artifacts.join("baseline.wasm"), &baseline)?;
    std::fs::write(options.artifacts.join("main.o"), &compiled.object)?;
    std::fs::write(options.artifacts.join("linked.wasm"), &compiled.module)?;
    std::fs::write(
        options.artifacts.join("instrumented.wasm"),
        &instrumented.bytes,
    )?;
    let settings = super::toolchain::compiler_settings()?;
    let normalized_map = compiled
        .link_map
        .replace(
            &compiled.workspace.to_string_lossy().to_string(),
            "/workspace",
        )
        .replace(
            &settings.root.to_string_lossy().to_string(),
            "/opt/wasi-sdk",
        );
    std::fs::write(options.artifacts.join("link.map"), &normalized_map)?;
    std::fs::write(
        options.artifacts.join("origins.json"),
        serde_json::to_vec_pretty(&origins)?,
    )?;
    let mut relevant = BTreeMap::new();
    for subtask in &config.subtasks {
        for case in &subtask.cases {
            relevant.insert(case.input.clone(), standard::hash(&files[&case.input]));
            relevant.insert(case.output.clone(), standard::hash(&files[&case.output]));
        }
    }
    for path in config
        .compile_extra_files
        .iter()
        .chain(&config.user_extra_files)
        .chain(&config.checker_extra_files)
        .chain(config.checker.path.iter())
    {
        relevant.insert(path.clone(), standard::hash(&files[path]));
    }
    let eval_hash = standard::hash(
        standard::canonical_json(&json!({"runtime_config":config, "files":relevant})).as_bytes(),
    );
    let mut cases = Vec::new();
    for subtask in &config.subtasks {
        for case in &subtask.cases {
            if options
                .case
                .as_ref()
                .is_some_and(|name| name != &case.input)
            {
                continue;
            }
            let time = case
                .time_limit_ms
                .or(subtask.time_limit_ms)
                .unwrap_or(config.time_limit_ms);
            let memory = case
                .memory_limit_mb
                .or(subtask.memory_limit_mb)
                .unwrap_or(config.memory_limit_mb);
            anyhow::ensure!(
                (1..=300_000).contains(&time) && (1..=512).contains(&memory),
                "分析资源配置无效"
            );
            let budget = standard::fuel_budget(time)?;
            let raw_budget = budget.checked_mul(50).context("分析预算溢出")?;
            let input = &files[&case.input];
            let expected = &files[&case.output];
            let mut baselines = Vec::new();
            let mut analyses = Vec::new();
            for _ in 0..options.repeat {
                let run = wasm::run_analysis_module(
                    &baseline,
                    input,
                    memory,
                    budget,
                    time,
                    config.filename.as_deref(),
                    &user_files,
                    0,
                )
                .await?;
                let baseline_verdict = verdict(
                    &run,
                    &config,
                    checker.as_deref(),
                    input,
                    expected,
                    &checker_files,
                    time,
                    memory,
                )
                .await?;
                baselines.push(RunReport {
                    verdict: baseline_verdict,
                    fuel: run.fuel_consumed,
                    cpu_time_ms: run.cpu_time_ms,
                    wall_time_ms: run.wall_time_ms,
                    output_sha256: standard::hash(&run.stdout),
                    equivalent_time_ms: run.fuel_consumed.map(standard::reference_time_ms),
                });
                let run = wasm::run_analysis_module(
                    &instrumented.bytes,
                    input,
                    memory,
                    raw_budget,
                    time,
                    config.filename.as_deref(),
                    &user_files,
                    origins.len(),
                )
                .await?;
                let complete = run.status == wasm::WasmStatus::Accepted
                    && run.analysis_counters.len() == origins.len();
                let mut categories: BTreeMap<Category, u64> = [
                    Category::Contestant,
                    Category::IoCandidate,
                    Category::OtherSdk,
                    Category::Unconfirmed,
                ]
                .into_iter()
                .map(|c| (c, 0))
                .collect();
                let mut hotspots = Vec::new();
                for (origin, &cost) in origins.iter().zip(&run.analysis_counters) {
                    let entry = categories.entry(origin.category.clone()).or_default();
                    *entry = entry.checked_add(cost).context("分类计数溢出")?;
                    if cost != 0 {
                        hotspots.push(Hotspot {
                            origin: origin.clone(),
                            cost,
                        });
                    }
                }
                hotspots.sort_by(|a, b| {
                    b.cost
                        .cmp(&a.cost)
                        .then(a.origin.function_index.cmp(&b.origin.function_index))
                });
                // 保留完整函数计数，避免把热点截断造成的损失误认为未知来源。
                let without_io: u64 = categories
                    .iter()
                    .filter(|(c, _)| **c != Category::IoCandidate)
                    .map(|(_, &v)| v)
                    .sum();
                analyses.push(AnalysisRun {
                    complete,
                    analysis_output_verdict: if complete {
                        Some(
                            verdict(
                                &run,
                                &config,
                                checker.as_deref(),
                                input,
                                expected,
                                &checker_files,
                                time,
                                memory,
                            )
                            .await?,
                        )
                    } else {
                        None
                    },
                    termination: if complete {
                        "complete".into()
                    } else {
                        format!(
                            "analysis_incomplete:{}",
                            match run.status {
                                wasm::WasmStatus::TimeLimitExceeded => "raw_fuel_exhausted",
                                wasm::WasmStatus::SystemError => "host_watchdog",
                                wasm::WasmStatus::MemoryLimitExceeded => "memory_limit",
                                wasm::WasmStatus::OutputLimitExceeded => "output_limit",
                                _ => "guest_error",
                            }
                        )
                    },
                    raw_fuel: run.fuel_consumed,
                    raw_budget,
                    cpu_time_ms: run.cpu_time_ms,
                    wall_time_ms: run.wall_time_ms,
                    output_sha256: standard::hash(&run.stdout),
                    categories,
                    hotspots,
                    hypothetical_without_io_candidate_ms: complete.then(|| {
                        if without_io == 0 {
                            0
                        } else {
                            standard::reference_time_ms(without_io)
                        }
                    }),
                });
            }
            let reproducible = (options.repeat >= 2).then(|| {
                analyses.iter().all(|a| a.complete)
                    && analyses.windows(2).all(|p| {
                        p[0].raw_fuel == p[1].raw_fuel
                            && p[0].analysis_output_verdict == p[1].analysis_output_verdict
                            && p[0].output_sha256 == p[1].output_sha256
                            && p[0].categories == p[1].categories
                            && p[0]
                                .hotspots
                                .iter()
                                .map(|h| (h.origin.function_index, h.cost))
                                .eq(p[1]
                                    .hotspots
                                    .iter()
                                    .map(|h| (h.origin.function_index, h.cost)))
                    })
                    && baselines
                        .windows(2)
                        .all(|p| p[0].fuel == p[1].fuel && p[0].verdict == p[1].verdict)
            });
            let pairs: Vec<_> = baselines
                .iter()
                .zip(&analyses)
                .filter(|(b, a)| {
                    a.complete && matches!(b.verdict, OiStatus::Accepted | OiStatus::WrongAnswer)
                })
                .collect();
            let outputs_match = (!pairs.is_empty()).then(|| {
                pairs
                    .iter()
                    .all(|(b, a)| b.output_sha256 == a.output_sha256)
            });
            anyhow::ensure!(
                outputs_match != Some(false),
                "插桩改变了输出: {}",
                case.input
            );

            eprintln!(
                "{}: {:?}, 分类完成={}, 重复一致={:?}",
                case.input, baselines[0].verdict, analyses[0].complete, reproducible
            );
            let native = if let Some(image) = &options.native_image {
                Some(
                    native::native_case(
                        &options, &source, &config, case, time, memory, image, &files,
                    )
                    .await?,
                )
            } else {
                None
            };
            cases.push(CaseReport {
                input: case.input.clone(),
                input_sha256: standard::hash(input),
                expected_sha256: standard::hash(expected),
                time_limit_ms: time,
                memory_limit_mb: memory,
                fuel_budget: budget,
                baseline: baselines,
                analysis: analyses,
                classification_reproducible: reproducible,
                completed_outputs_match: outputs_match,
                native,
            });
        }
    }
    anyhow::ensure!(!cases.is_empty(), "没有匹配的测试点");
    let report = json!({
        "schema_version":1, "analysis_version":RULE_VERSION, "standard_version":standard::manifest()["id"],
        "standard_hash":standard::profile().hash, "source_hash":standard::hash(source.as_bytes()), "language":options.language,
        "toolchain_hash":standard::manifest()["toolchain_components_sha256"], "evaluation_hash":eval_hash,
        "baseline_module_hash":standard::hash(&baseline), "linked_module_hash":standard::hash(&compiled.module),
        "baseline_matches_analysis_link":baseline == compiled.module, "instrumented_module_hash":standard::hash(&instrumented.bytes),
        "origin_map_hash":standard::hash(standard::canonical_json(&serde_json::to_value(&origins)?).as_bytes()),
        "link_map_hash":standard::hash(normalized_map.as_bytes()), "contestant_object_hash":standard::hash(&compiled.object),
        "counter_semantics":"原指令成本；纯指令段在边界结算，可能陷阱的操作在尝试前计费；中止结果是部分统计。模块实例化/宿主执行不归入函数计数。IO 候选不等于可豁免 IO；插桩 raw fuel 不等于分类工作量。",
        "attribution_limitations":"来源映射确认实际函数体归属。已内联代码不能按源函数单独拆分；共享解析函数不能仅凭函数来源区分文件流与字符串流。",
        "runtime_config":config, "cases":cases,
    });
    std::fs::write(&options.output, serde_json::to_vec_pretty(&report)?)?;
    std::fs::write(options.output.with_extension("md"), markdown(&report))?;
    Ok(report)
}

pub fn markdown(report: &Value) -> String {
    let mut out = format!("# WASM IO 分类分析\n\n标准：{}；分析规则：{}。IO 候选不是已确认可豁免成本。\n\n| 测试点 | 标准状态 | 参考 ms | CPU ms | 选手成本 | IO 候选 | 其他 SDK | 未确认 | 分析完成 |\n|---|---|---:|---:|---:|---:|---:|---:|---|\n", report["standard_version"].as_str().unwrap_or(""), RULE_VERSION);
    if let Some(cases) = report["cases"].as_array() {
        for case in cases {
            let b = &case["baseline"][0];
            let a = &case["analysis"][0];
            let c = &a["categories"];
            out.push_str(&format!(
                "| {} | {} | {} | {} | {} | {} | {} | {} | {} |\n",
                case["input"].as_str().unwrap_or("").replace('|', "\\|"),
                b["verdict"].as_str().unwrap_or(""),
                b["equivalent_time_ms"],
                b["cpu_time_ms"],
                c["contestant"],
                c["io_candidate"],
                c["other_sdk"],
                c["unconfirmed"],
                a["complete"]
            ));
        }
    }
    out.push_str("\n分类统计排除插入指令；raw fuel 包含插桩开销。中止统计不用于推断完整成本。详细热点和摘要见同名 JSON。\n");
    out
}
