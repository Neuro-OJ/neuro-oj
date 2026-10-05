//! 真实 WASI 工具链验收：通过 Worker 执行路径验证 C/C++、文件题、checker 和错误归因。
//! 运行方式见 scripts/check-oi-wasi-toolchain.sh，SDK 只从管理员参数读取。
use noj_judge::{
    oi::{wasm::evaluate_wasm, OiCheckerType},
    types::JudgeTask,
};
use std::collections::HashMap;

#[tokio::main]
async fn main() {
    tracing_subscriber::fmt().with_env_filter("warn").init();
    let fixture = include_str!("../../noj-tests/fixtures/judge-task-oi.contract.json");
    let c_source = "#include <stdio.h>\nint main(){int a,b;scanf(\"%d%d\",&a,&b);printf(\"%d\\n\",a+b);return 0;}";
    let cpp_source = "#include <bits/stdc++.h>\nint main(){int a,b;std::cin>>a>>b;std::stack<int> s;s.push(a);std::function<int(int)> add=[&](int x){return x+b;};std::cout<<add(s.top())<<std::endl;return 0;}";
    let outside = tempfile::tempdir().unwrap();
    let header = outside.path().join("private.h");
    std::fs::write(&header, "#define PRIVATE_VALUE 42\n").unwrap();
    let forbidden_source = format!(
        "#include \"{}\"\nint main(){{return PRIVATE_VALUE;}}",
        header.display()
    );
    for (label, language, source, expected, file_io, checker) in [
        ("C A+B", "c", c_source, "AC", false, false),
        ("C++ A+B", "cc", cpp_source, "AC", false, false),
        ("错误源码", "c", "invalid c source", "CE", false, false),
        ("错解", "c", "#include <stdio.h>\nint main(){puts(\"0\");}", "WA", false, false),
        ("无限循环", "c", "int main(){volatile unsigned x=0;while(1){x++;}}", "TLE", false, false),
        ("文件输入输出", "c", "#include <stdio.h>\nint main(){freopen(\"answer.in\",\"r\",stdin);freopen(\"answer.out\",\"w\",stdout);int a,b;scanf(\"%d%d\",&a,&b);printf(\"%d\\n\",a+b);}", "AC", true, false),
        ("独立 checker", "cc", cpp_source, "AC", false, true),
        ("checker 拒绝错解", "c", "#include <stdio.h>\nint main(){puts(\"0\");}", "WA", false, true),
        ("拒绝读取 Worker 私有文件", "c", forbidden_source.as_str(), "CE", false, false),
    ] {
        let mut task: JudgeTask = serde_json::from_str(fixture).unwrap();
        task.language = language.into();
        task.code = source.into();
        let mut config = task.runtime_config.as_oi().unwrap().clone();
        if file_io { config.filename = Some("answer".into()); }
        if checker { config.checker.kind = OiCheckerType::Testlib; }
        let checker_source = b"#include <fstream>\nint main(int argc,char**argv){if(argc!=4)return 3;std::ifstream out(argv[2]),ans(argv[3]);int a=0,b=1;out>>a;ans>>b;return a==b?0:1;}";
        let cases = vec![("testdata/1.in".into(), b"2 40\n".to_vec(), b"42\n".to_vec())];
        let empty = HashMap::new();
        let result = evaluate_wasm(&task, &config, &cases, task.oi_cost_profile.as_ref().unwrap(),
            checker.then_some(&checker_source[..]), &empty, &empty, &empty).await.unwrap();
        let value = serde_json::to_value(&result).unwrap();
        assert_eq!(value["details"]["oi"]["verdict"], expected, "{label}: {value}");
        println!("✓ {label}: {expected}");
    }
}
