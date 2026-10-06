//! v2 工具链兼容性与固定成本门禁；仅输出确定性结果供独立进程比较。
use noj_judge::{
    oi::{standard, toolchain, wasm::evaluate_wasm, OiBackend},
    types::JudgeTask,
};
use std::collections::HashMap;

async fn run(source: &str, input: Vec<u8>, expected: &str, filename: bool) -> serde_json::Value {
    let mut task: JudgeTask = serde_json::from_str(include_str!(
        "../../noj-tests/fixtures/judge-task-oi.contract.json"
    ))
    .unwrap();
    task.code = source.into();
    task.language = "cc".into();
    task.oi_cost_profile = Some(standard::profile());
    let mut config = task.runtime_config.as_oi().unwrap().clone();
    config.backend = OiBackend::Wasm;
    config.time_limit_ms = 10000;
    config.filename = filename.then(|| "answer".into());
    let empty = HashMap::new();
    let result = evaluate_wasm(
        &task,
        &config,
        &[("testdata/1.in".into(), input, expected.as_bytes().to_vec())],
        &standard::profile(),
        None,
        &empty,
        &empty,
        &empty,
    )
    .await
    .unwrap();
    assert_eq!(result.details["oi"]["verdict"], "AC", "{}", result.details);
    let case = &result.details["oi"]["subtasks"][0]["cases"][0];
    serde_json::json!({"fuel":case["fuel_consumed"],"metering":result.details["metering"]})
}

#[tokio::main]
async fn main() {
    toolchain::validate_configured_toolchain().unwrap();
    let mut report = serde_json::Map::new();
    report.insert(
        "integer-streams".into(),
        run(
            include_str!("../toolchain/tests/integer-streams.cpp"),
            Vec::new(),
            "42",
            false,
        )
        .await,
    );
    let cases = [
        ("sync-toggle", "#include <cassert>\n#include <iostream>\nint main(){assert(std::ios::sync_with_stdio(false));assert(!std::ios::sync_with_stdio(false));assert(!std::ios::sync_with_stdio(true));assert(std::ios::sync_with_stdio(false));std::cin.tie(nullptr);int x;std::cin>>x;std::cout<<x<<std::flush;std::cin.clear();std::ios::sync_with_stdio(true);}", false),
        ("sync-c-io", "#include <cstdio>\n#include <iostream>\nint main(){int a,b;scanf(\"%d\",&a);std::cin>>b;printf(\"%d\",a+b);}", false),
        ("freopen-before", "#include <cstdio>\n#include <iostream>\nint main(){freopen(\"answer.in\",\"r\",stdin);freopen(\"answer.out\",\"w\",stdout);std::ios::sync_with_stdio(false);std::cin.tie(nullptr);int a,b;std::cin>>a>>b;std::cout<<a+b;}", true),
        ("freopen-after", "#include <cstdio>\n#include <iostream>\nint main(){std::ios::sync_with_stdio(false);std::cin.tie(nullptr);freopen(\"answer.in\",\"r\",stdin);freopen(\"answer.out\",\"w\",stdout);int a,b;std::cin>>a>>b;std::cout<<a+b;}", true),
    ];
    for (name, source, filename) in cases {
        let input = if name == "sync-toggle" {
            b"42".to_vec()
        } else {
            b"2 40\n".to_vec()
        };
        report.insert(name.into(), run(source, input, "42", filename).await);
    }
    let mut data = String::new();
    let mut sum = 0_i64;
    for i in 0..600000_i64 {
        let value = (i * 1664525 + 1013904223) % 40001 - 20000;
        sum += value;
        data.push_str(&format!("{value} "));
    }
    let source = include_str!("../toolchain/tests/parse-cost.cpp");
    let mut fuels = Vec::new();
    for (mode, label) in [
        ('C', "parse-cin"),
        ('R', "parse-checked"),
        ('B', "parse-bulk"),
    ] {
        let result = run(
            source,
            format!("{mode}\n{data}\n").into_bytes(),
            &sum.to_string(),
            false,
        )
        .await;
        fuels.push(result["fuel"].as_u64().unwrap());
        report.insert(label.into(), result);
    }
    assert!(
        fuels[0] <= fuels[1] * 3,
        "cin 成本不得超过完整边界解析的三倍: {fuels:?}"
    );
    println!("{}", serde_json::to_string_pretty(&report).unwrap());
}
