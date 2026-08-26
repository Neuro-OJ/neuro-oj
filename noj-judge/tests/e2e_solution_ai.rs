//! noj-solution-ai 镜像相关测试。
//!
//! 完整 E2E（构建镜像 + 导入 torch）需要 Docker 与较大下载量，默认忽略；
//! 这里提供无需 Docker 的 Dockerfile 内容校验，保证镜像定义不漂移。

use std::path::PathBuf;

#[test]
fn solution_ai_dockerfile_contains_expected_packages() {
    let dockerfile =
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("docker/solution-ai/Dockerfile");
    let content = std::fs::read_to_string(&dockerfile).expect("读取 Dockerfile 失败");

    assert!(
        content.contains("python:3.12-slim"),
        "应基于 python:3.12-slim"
    );
    assert!(content.contains("torch"), "应安装 torch");
    assert!(content.contains("torchvision"), "应安装 torchvision");
    assert!(
        content.contains("noj_solution_sdk"),
        "应包含 noj_solution_sdk"
    );
    assert!(content.contains("opencv-python-headless"), "应安装 opencv");
    assert!(content.contains("safetensors"), "应安装 safetensors");
    assert!(content.contains("numpy"), "应安装 numpy");
    assert!(content.contains("scipy"), "应安装 scipy");
    assert!(content.contains("pandas"), "应安装 pandas");
    assert!(content.contains("scikit-learn"), "应安装 scikit-learn");
    assert!(content.contains("Pillow"), "应安装 Pillow");
    assert!(content.contains("matplotlib"), "应安装 matplotlib");
}

/// 完整 E2E：构建 noj-solution-ai 并验证 SDK/torch 可导入。
/// 需要 Docker 与网络，默认忽略。
#[ignore]
#[test]
fn solution_ai_image_build_and_import() {
    if std::env::var("NOJ_RUN_E2E").as_deref() != Ok("1") {
        return;
    }
    let status = std::process::Command::new("docker")
        .args([
            "build",
            "-t",
            "noj-solution-ai:test",
            "-f",
            "docker/solution-ai/Dockerfile",
            ".",
        ])
        .current_dir(env!("CARGO_MANIFEST_DIR"))
        .status()
        .expect("执行 docker build 失败");
    assert!(status.success(), "docker build noj-solution-ai 失败");

    let run = std::process::Command::new("docker")
        .args([
            "run",
            "--rm",
            "noj-solution-ai:test",
            "python3",
            "-c",
            "import torch, torchvision, noj_solution_sdk; print(torch.__version__)",
        ])
        .status()
        .expect("执行 docker run 失败");
    assert!(run.success(), "noj-solution-ai 导入 torch/SDK 失败");
}
