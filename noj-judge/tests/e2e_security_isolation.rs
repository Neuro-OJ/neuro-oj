/// Docker 安全隔离集成测试。
///
/// 验证：NetworkMode=none 阻断网络、敏感路径不可访问。
mod common;
use common::{
    create_test_container, ensure_test_image, get_docker, is_e2e_enabled, wait_container,
};

/// 网络隔离测试：NetworkMode=none 下网络请求应失败
#[ignore]
#[serial_test::serial]
#[tokio::test]
async fn test_network_isolation() {
    if !is_e2e_enabled() {
        return;
    }

    let docker = get_docker().expect("连接 Docker 失败");
    ensure_test_image(&docker).await.expect("确保测试镜像失败");

    let code = "import urllib.request; urllib.request.urlopen('https://example.com', timeout=5)";
    let (container_id, work_dir) = create_test_container(
        &docker,
        "noj-judge-test-runner",
        &["python3", "-c", code],
        256,
        15000,
    )
    .await
    .expect("创建容器失败");

    let output = tokio::time::timeout(
        std::time::Duration::from_secs(30),
        wait_container(&docker, &container_id, 15000),
    )
    .await
    .expect("容器执行超时")
    .expect("等待容器失败");

    // 网络请求应被阻断，退出码非 0
    assert_ne!(output.exit_code, 0, "网络隔离测试：请求应失败但退出了码 0");
    let _ = std::fs::remove_dir_all(&work_dir);
}

/// 敏感路径不可访问测试。
///
/// 验证容器内无法访问宿主机敏感路径。
/// 注意：/etc/passwd 和 /proc/* 在正常 Docker 容器中天然存在
///（分别来自镜像和 /proc 挂载），不代表宿主机路径泄漏。
/// 此处仅检查确实不应存在的路径（Docker socket、宿主机数据目录等）。
#[ignore]
#[serial_test::serial]
#[tokio::test]
async fn test_container_no_sensitive_mounts() {
    if !is_e2e_enabled() {
        return;
    }

    let docker = get_docker().expect("连接 Docker 失败");
    ensure_test_image(&docker).await.expect("确保测试镜像失败");

    // 仅检查那些在正常容器中不应存在的敏感路径
    let code = r#"import os; paths=['/var/run/docker.sock','/host','/var/lib/docker']; [print(p) for p in paths if os.path.exists(p)]"#;
    let (container_id, work_dir) = create_test_container(
        &docker,
        "noj-judge-test-runner",
        &["python3", "-c", code],
        256,
        10000,
    )
    .await
    .expect("创建容器失败");

    let output = tokio::time::timeout(
        std::time::Duration::from_secs(30),
        wait_container(&docker, &container_id, 10000),
    )
    .await
    .expect("容器执行超时")
    .expect("等待容器失败");

    assert_eq!(output.exit_code, 0, "敏感路径检查应正常退出");
    assert!(
        output.stdout.trim().is_empty(),
        "不应发现宿主机敏感路径，但找到了: {}",
        output.stdout
    );
    let _ = std::fs::remove_dir_all(&work_dir);
}
