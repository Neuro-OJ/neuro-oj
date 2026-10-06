//! 独立开发者分析入口；无需 Core、数据库或 Redis。
use anyhow::{Context, Result};
use noj_judge::oi::wasm_analyze::{analyze, Options};
use std::{collections::BTreeMap, path::PathBuf};
fn main() -> Result<()> {
    let args: Vec<_> = std::env::args().skip(1).collect();
    if args.is_empty() || args.iter().any(|arg| arg == "--help") {
        println!("wasm-analyze --source FILE --language c|cc --config JSON --package ZIP --output JSON --artifacts DIR [--repeat 2] [--case INPUT] [--native-image IMAGE]\n仅独立分析，不改变 v2 判题。SDK 通过 JUDGE_WASI_CC/JUDGE_WASI_CXX/JUDGE_WASI_SYSROOT 显式指定。");
        return Ok(());
    }
    anyhow::ensure!(args.len() % 2 == 0, "每个选项必须有值");
    let mut values = BTreeMap::new();
    for pair in args.as_chunks::<2>().0 {
        anyhow::ensure!(
            [
                "--source",
                "--language",
                "--config",
                "--package",
                "--output",
                "--artifacts",
                "--repeat",
                "--case",
                "--native-image"
            ]
            .contains(&pair[0].as_str()),
            "未知选项 {}",
            pair[0]
        );
        anyhow::ensure!(
            values.insert(pair[0].clone(), pair[1].clone()).is_none(),
            "重复选项 {}",
            pair[0]
        );
    }
    let get = |key: &str| {
        values
            .get(key)
            .cloned()
            .with_context(|| format!("缺少 {key}"))
    };
    let options = Options {
        source: PathBuf::from(get("--source")?),
        language: get("--language")?,
        config: PathBuf::from(get("--config")?),
        package: PathBuf::from(get("--package")?),
        output: PathBuf::from(get("--output")?),
        artifacts: PathBuf::from(get("--artifacts")?),
        repeat: values
            .get("--repeat")
            .map(|v| v.parse())
            .transpose()?
            .unwrap_or(2),
        case: values.get("--case").cloned(),
        native_image: values.get("--native-image").cloned(),
    };
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()?;
    runtime.block_on(analyze(options))?;
    Ok(())
}
