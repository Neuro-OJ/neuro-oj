//! 原生对照仅在独立 Docker 中执行，与正式评测无关。
use super::*;

#[allow(clippy::too_many_arguments)]
pub(super) async fn native_case(
    options: &Options,
    source: &str,
    config: &OiRuntimeConfig,
    case: &super::super::OiCase,
    time: u64,
    memory: u64,
    image: &str,
    files: &HashMap<String, Vec<u8>>,
) -> Result<Value> {
    anyhow::ensure!(
        config.checker.kind != OiCheckerType::Testlib,
        "原生性能对照目前只支持 default/strict checker；WASM 分析仍支持 testlib"
    );
    let directory = tempfile::tempdir()?;
    let root = directory.path();
    std::fs::write(
        root.join(if options.language == "c" {
            "main.c"
        } else {
            "main.cc"
        }),
        source,
    )?;
    std::fs::write(root.join("input"), &files[&case.input])?;
    std::fs::write(root.join("expected"), &files[&case.output])?;
    std::fs::write(
        root.join("native.py"),
        include_str!("../../../toolchain/tests/native-analyze.py"),
    )?;
    let extra = select(
        config
            .compile_extra_files
            .iter()
            .chain(&config.user_extra_files),
        files,
    );
    std::fs::create_dir(root.join("files"))?;
    wasm::write_extra_files(&root.join("files"), &extra)?;
    let limits: std::collections::BTreeSet<_> = [time, 2000].into_iter().collect();
    let request = json!({ "language":options.language, "limits":limits, "repeat":options.repeat,
        "filename":config.filename, "memory_mb":memory, "strict":config.checker.kind == OiCheckerType::Strict,
        "extra_files":config.user_extra_files });
    std::fs::write(root.join("request.json"), serde_json::to_vec(&request)?)?;
    let name = format!("noj-wasm-analysis-{}", uuid::Uuid::new_v4());
    let output_file = std::fs::File::create(root.join("report.json"))?;
    let error_file = std::fs::File::create(root.join("error.log"))?;
    let mut process = std::process::Command::new("docker")
        .args([
            "run",
            "--pull",
            "never",
            "--rm",
            "--name",
            &name,
            "--network",
            "none",
            "--ipc",
            "none",
            "--cap-drop",
            "ALL",
            "--security-opt",
            "no-new-privileges",
            "--pids-limit",
            "256",
            "--memory",
            "1g",
            "--memory-swap",
            "1g",
            "--cpus",
            "1",
            "--read-only",
            "--tmpfs",
            "/tmp:rw,exec,size=256m",
            "--mount",
        ])
        .arg(format!(
            "type=bind,src={},dst=/workspace,readonly",
            root.display()
        ))
        .args(["--entrypoint", "python3", image, "/workspace/native.py"])
        .stdin(std::process::Stdio::null())
        .stdout(output_file)
        .stderr(error_file)
        .spawn()?;
    let started = std::time::Instant::now();
    let result = loop {
        if let Some(status) = process.try_wait()? {
            break status;
        }
        if started.elapsed().as_secs() > 180 {
            let _ = process.kill();
            let _ = process.wait();
            let _ = std::process::Command::new("docker")
                .args(["rm", "-f", &name])
                .output();
            anyhow::bail!("原生对照运行保护超时");
        }
        std::thread::sleep(std::time::Duration::from_millis(20));
    };
    anyhow::ensure!(
        result.success(),
        "原生对照失败: {}",
        std::fs::read_to_string(root.join("error.log"))?
            .chars()
            .take(4096)
            .collect::<String>()
    );
    let mut report: Value = serde_json::from_slice(&std::fs::read(root.join("report.json"))?)?;
    report["image"] = image.into();
    let inspection = std::process::Command::new("docker")
        .args(["image", "inspect", "--format", "{{.Id}}", image])
        .output()?;
    report["image_id"] = String::from_utf8(inspection.stdout)?.trim().into();
    Ok(report)
}
