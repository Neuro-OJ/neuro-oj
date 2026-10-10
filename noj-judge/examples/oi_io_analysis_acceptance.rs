//! 真实 SDK 的来源隔离和固定生成成本快照；两个进程输出必须一致。
use anyhow::Result;
use noj_judge::oi::{
    standard,
    wasm_analyze::{analyze, Options},
};
use serde_json::{json, Value};
use std::io::Write;

#[tokio::main(flavor = "current_thread")]
async fn main() -> Result<()> {
    let root = tempfile::tempdir()?;
    let source = include_str!("../toolchain/tests/io-analysis.cpp");
    std::fs::write(root.path().join("main.cpp"), source)?;
    let mut input = String::from("4096\n");
    let mut sum = 0_i64;
    for i in 0..4096_i64 {
        let value = (i * 1664525 + 1013904223) % 100003;
        input.push_str(&format!("{value}\n"));
        sum += value + 1;
    }
    let expected = format!("{sum} 579 55 55 42");
    let config = json!({"backend":"wasm","languages":["cc"],"time_limit_ms":1000,"memory_limit_mb":128,
        "checker":{"type":"default"},"subtasks":[{"id":"1","score":100,"cases":[{"input":"1.in","output":"1.ans"}]}]});
    std::fs::write(root.path().join("config.json"), config.to_string())?;
    let package = root.path().join("package.zip");
    let mut zip = zip::ZipWriter::new(std::fs::File::create(&package)?);
    for (name, content) in [("1.in", input.as_bytes()), ("1.ans", expected.as_bytes())] {
        zip.start_file(name, zip::write::SimpleFileOptions::default())?;
        zip.write_all(content)?;
    }
    zip.finish()?;
    let report = analyze(Options {
        source: root.path().join("main.cpp"),
        language: "cc".into(),
        config: root.path().join("config.json"),
        package,
        output: root.path().join("report.json"),
        artifacts: root.path().join("artifacts"),
        repeat: 2,
        case: None,
        native_image: None,
    })
    .await?;
    assert_eq!(report["baseline_matches_analysis_link"], true);
    let case = &report["cases"][0];
    assert_eq!(case["baseline"][0]["verdict"], "AC");
    assert_eq!(case["classification_reproducible"], true);
    assert_eq!(case["completed_outputs_match"], true);
    let costs = &case["analysis"][0]["categories"];
    assert!(costs["contestant"].as_u64().unwrap() > 0);
    assert!(costs["io_candidate"].as_u64().unwrap() > 0);
    let hotspots = case["analysis"][0]["hotspots"].as_array().unwrap();
    for symbol in ["atoi", "_Zrs", "underflow", "do_get"] {
        assert!(
            hotspots.iter().any(|hotspot| hotspot["origin"]["symbol"]
                .as_str()
                .unwrap()
                .contains(symbol)
                && hotspot["origin"]["category"] == "contestant"),
            "用户回调/覆盖来源漏记: {symbol}"
        );
    }
    let mut streams = serde_json::Map::new();
    for (label, prefix, filename) in [
        ("stdio", "std::ios::sync_with_stdio(false);", None),
        ("freopen-before", "freopen(\"answer.in\",\"r\",stdin); freopen(\"answer.out\",\"w\",stdout); std::ios::sync_with_stdio(false);", Some("answer")),
        ("freopen-after", "std::ios::sync_with_stdio(false); freopen(\"answer.in\",\"r\",stdin); freopen(\"answer.out\",\"w\",stdout);", Some("answer")),
    ] {
        let dir = root.path().join(label); std::fs::create_dir(&dir)?;
        let program = format!("#include <iostream>\n#include <cstdio>\nint main(){{{prefix}long a; std::cin>>a; std::cout<<a;}}\n");
        std::fs::write(dir.join("main.cpp"), program)?;
        let mut cfg = config.clone(); cfg["filename"] = json!(filename);
        std::fs::write(dir.join("config.json"), cfg.to_string())?;
        let pkg = dir.join("package.zip");
        let mut zip = zip::ZipWriter::new(std::fs::File::create(&pkg)?);
        for (name, bytes) in [("1.in", b"7\n".as_slice()), ("1.ans", b"7".as_slice())] {
            zip.start_file(name, zip::write::SimpleFileOptions::default())?; zip.write_all(bytes)?;
        }
        zip.finish()?;
        let r = analyze(Options { source:dir.join("main.cpp"), language:"cc".into(), config:dir.join("config.json"), package:pkg,
            output:dir.join("report.json"), artifacts:dir.join("artifacts"), repeat:2, case:None, native_image:None }).await?;
        let c = &r["cases"][0]; assert_eq!(c["baseline"][0]["verdict"], "AC");
        assert_eq!(c["analysis"][0]["analysis_output_verdict"], "AC");
        assert_eq!(c["completed_outputs_match"], true); assert_eq!(c["classification_reproducible"], true);
        streams.insert(label.into(), json!({"module_hash":r["linked_module_hash"], "origin_map_hash":r["origin_map_hash"],
            "baseline_fuel":c["baseline"][0]["fuel"], "raw_fuel":c["analysis"][0]["raw_fuel"], "categories":c["analysis"][0]["categories"]}));
    }
    let deterministic: Value = json!({
        "analysis_version":report["analysis_version"], "source_hash":standard::hash(source.as_bytes()),
        "standard_hash":report["standard_hash"], "origin_map_hash":report["origin_map_hash"],
        "linked_module_hash":report["linked_module_hash"], "instrumented_module_hash":report["instrumented_module_hash"],
        "baseline_fuel":case["baseline"][0]["fuel"], "raw_fuel":case["analysis"][0]["raw_fuel"],
        "categories":costs, "hotspots":hotspots, "streams": streams,
    });
    println!("{}", serde_json::to_string_pretty(&deterministic)?);
    Ok(())
}
