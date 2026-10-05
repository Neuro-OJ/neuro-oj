//! 真实 Docker OI 回归：编译产物必须能在受限工作目录中执行。
use noj_judge::{oi::runner::evaluate_native, types::JudgeTask};
use std::io::Write;
use zip::write::SimpleFileOptions;

#[tokio::test]
#[ignore = "需要 Docker 和 noj-oi-cpp 镜像"]
async fn native_docker_cpp_executes_compiled_binary() {
    assert_eq!(std::env::var("NOJ_RUN_E2E").as_deref(), Ok("1"));
    assert!(std::env::var("JUDGE_GO_JUDGE_URL")
        .unwrap_or_default()
        .is_empty());
    let docker = bollard::Docker::connect_with_local_defaults().unwrap();
    let dir = tempfile::tempdir().unwrap();
    let package = dir.path().join("tests.zip");
    let mut zip = zip::ZipWriter::new(std::fs::File::create(&package).unwrap());
    for (name, content) in [("testdata/1.in", "2 40\n"), ("testdata/1.out", "42\n")] {
        zip.start_file(name, SimpleFileOptions::default()).unwrap();
        zip.write_all(content.as_bytes()).unwrap();
    }
    zip.finish().unwrap();
    let mut task: JudgeTask = serde_json::from_str(include_str!(
        "../../noj-tests/fixtures/judge-task-oi.contract.json"
    ))
    .unwrap();
    task.code =
        "#include <iostream>\nint main(){int a,b;std::cin>>a>>b;std::cout<<a+b<<std::endl;}".into();
    let mut config = task.runtime_config.as_oi().unwrap().clone();
    config.backend = noj_judge::oi::OiBackend::Native;
    config.subtasks.truncate(1);
    config.subtasks[0].cases.truncate(1);
    task.runtime_config = serde_json::from_value(serde_json::to_value(config).unwrap()).unwrap();
    let result = evaluate_native(
        &docker,
        &task,
        &package,
        "noj-oi-cpp",
        1000,
        "oi-native-regression",
        None,
    )
    .await
    .unwrap();
    assert_eq!(result.details["oi"]["verdict"], "AC");
}
