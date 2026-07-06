/// 题目资源限制集成测试。
///
/// 验证题目的 time_limit_ms 和 memory_limit_mb 实际约束了 Docker 容器执行。
///
/// 运行方式：
/// ```bash
/// NOJ_RUN_E2E=1 cargo test --test e2e_problem_limits -- --ignored
/// ```
mod common;
use common::{
    create_test_container, ensure_test_image, get_docker, is_e2e_enabled, wait_container,
};

/// 超时限制测试：短超时应 kill 长时间 sleep
#[ignore]
#[serial_test::serial]
#[tokio::test]
async fn test_problem_time_limit_enforced() {
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
            "-c",
            "import time; time.sleep(10); print('never')",
        ],
        256,
        500, // time_limit_ms = 500ms
    )
    .await
    .expect("创建容器失败");

    let output = tokio::time::timeout(
        std::time::Duration::from_secs(30),
        wait_container(&docker, &container_id, 500),
    )
    .await
    .expect("容器执行超时")
    .expect("等待容器失败");

    assert_eq!(
        output.exit_code, -1,
        "超时应返回 exit_code=-1，实际 {}",
        output.exit_code
    );
    let _ = std::fs::remove_dir_all(&work_dir);
}

/// 内存限制测试：低内存限制下 OOM 应被触发
#[ignore]
#[serial_test::serial]
#[tokio::test]
async fn test_problem_memory_limit_enforced() {
    if !is_e2e_enabled() {
        return;
    }

    let docker = get_docker().expect("连接 Docker 失败");
    ensure_test_image(&docker).await.expect("确保测试镜像失败");

    let (container_id, work_dir) = create_test_container(
        &docker,
        "noj-judge-test-runner",
        &["python3", "/evaluate.py", "--memory-test"],
        50, // memory_limit_mb = 50MB
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

    // OOM kill 退出码 137 = 128 + SIGKILL(9)
    assert!(
        output.exit_code == 137 || output.exit_code == -1,
        "OOM 预期退出码 137（或超时 -1），实际 {}",
        output.exit_code
    );
    let _ = std::fs::remove_dir_all(&work_dir);
}

/// 宽松限制下正常任务应完成
#[ignore]
#[serial_test::serial]
#[tokio::test]
async fn test_limits_not_exceeded() {
    if !is_e2e_enabled() {
        return;
    }

    let docker = get_docker().expect("连接 Docker 失败");
    ensure_test_image(&docker).await.expect("确保测试镜像失败");

    let (container_id, work_dir) = create_test_container(
        &docker,
        "noj-judge-test-runner",
        &["python3", "-c", "print('done within limits')"],
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

    assert_eq!(output.exit_code, 0, "应正常退出");
    assert!(
        output.stdout.contains("done within limits"),
        "stdout 应包含预期输出"
    );
    let _ = std::fs::remove_dir_all(&work_dir);
}
