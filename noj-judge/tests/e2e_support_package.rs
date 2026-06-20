/// 支持包与评测流程集成测试。
///
/// 验证：evaluate.py 执行、---RESULT--- 标记输出、无支持包场景、无标记场景。
mod common;
use common::{
    create_test_container, ensure_test_image, get_docker, is_e2e_enabled, wait_container,
};

/// 完整评测流程：evaluate.py + ---RESULT--- 标记
#[ignore]
#[serial_test::serial]
#[tokio::test]
async fn test_evaluation_with_support_package() {
    if !is_e2e_enabled() {
        return;
    }

    let docker = get_docker().expect("连接 Docker 失败");
    ensure_test_image(&docker).await.expect("确保测试镜像失败");

    let (container_id, work_dir) = create_test_container(
        &docker,
        "noj-judge-test-runner",
        &[
            "python3",
            "/evaluate.py",
            "--result-json",
            r#"{"status":"Accepted","score":1000,"details":{}}"#,
        ],
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

    assert_eq!(
        output.exit_code, 0,
        "预期退出码 0，实际 {}",
        output.exit_code
    );
    assert!(
        output.stdout.contains("---RESULT---"),
        "stdout 应包含 ---RESULT--- 标记"
    );
    assert!(
        output.stdout.contains("Accepted"),
        "stdout 应包含 'Accepted'"
    );
    let _ = std::fs::remove_dir_all(&work_dir);
}

/// 无支持包时评测不应崩溃
#[ignore]
#[serial_test::serial]
#[tokio::test]
async fn test_no_support_package() {
    if !is_e2e_enabled() {
        return;
    }

    let docker = get_docker().expect("连接 Docker 失败");
    ensure_test_image(&docker).await.expect("确保测试镜像失败");

    let (container_id, work_dir) = create_test_container(
        &docker,
        "noj-judge-test-runner",
        &["python3", "-c", "print('no support package needed')"],
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

    assert_eq!(output.exit_code, 0);
    assert!(output.stdout.contains("no support package needed"));
    let _ = std::fs::remove_dir_all(&work_dir);
}

/// 无 ---RESULT--- 标记但正常退出
#[ignore]
#[serial_test::serial]
#[tokio::test]
async fn test_no_result_marker_exit_0() {
    if !is_e2e_enabled() {
        return;
    }

    let docker = get_docker().expect("连接 Docker 失败");
    ensure_test_image(&docker).await.expect("确保测试镜像失败");

    let (container_id, work_dir) = create_test_container(
        &docker,
        "noj-judge-test-runner",
        &["python3", "/evaluate.py", "--no-result"],
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

    // exit_code == 0 但无标记 → 对应 SystemError 场景
    assert_eq!(output.exit_code, 0);
    assert!(
        !output.stdout.contains("---RESULT---"),
        "不应包含 ---RESULT--- 标记"
    );
    let _ = std::fs::remove_dir_all(&work_dir);
}
