//! 独立分析运行的文件 IO 与计数采集入口。
use super::*;

/// 独立分析工具复用同一 WASI 沙箱和保护，不参与正式任务执行。
#[allow(clippy::too_many_arguments)]
pub(crate) async fn run_analysis_module(
    module: &[u8],
    input: &[u8],
    memory: u64,
    fuel: u64,
    limit: u64,
    filename: Option<&str>,
    files: &HashMap<String, Vec<u8>>,
    counters: usize,
) -> Result<WasmRunResult> {
    let names = file_io_names(filename)?;
    let directory = tempfile::tempdir()?;
    write_extra_files(directory.path(), files)?;
    if let Some((name, _)) = &names {
        std::fs::write(directory.path().join(name), input)?;
    }
    let preopen = (names.is_some() || !files.is_empty()).then_some(directory.path());
    let observed = run_observed_module_with_files(
        module,
        if names.is_some() { &[] } else { input },
        memory,
        fuel,
        &super::super::standard::profile(),
        &[],
        preopen,
        if names.is_some() {
            FsPerms::ReadWrite
        } else {
            FsPerms::ReadOnly
        },
        Some(wall_budget_ms(limit)),
        counters,
        None,
    )
    .await;
    let mut result = match observed {
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
    if result.status == WasmStatus::Accepted {
        if let Some((_, output)) = names {
            let (bytes, limited) = read_limited_file(&directory.path().join(output))?;
            if limited {
                result.status = WasmStatus::OutputLimitExceeded;
            } else if let Some(bytes) = bytes {
                result.stdout = bytes;
            } else {
                result.status = WasmStatus::FormatError;
                result.stdout.clear();
            }
        }
    }
    Ok(result)
}
