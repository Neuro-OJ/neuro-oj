#![allow(unused_doc_comments)]
// Docker 容器生命周期集成测试。
///
/// 验证：创建 → 启动 → 执行 Python 代码 → 等待退出 → 日志捕获 → 容器清理。
mod common;
use common::{create_test_container, ensure_test_image, get_docker, wait_container};

e2e_test!(
    #[ignore]
    test_container_lifecycle,
    async {
        let docker = get_docker().expect("连接 Docker 失败");
        ensure_test_image(&docker).await.expect("确保测试镜像失败");
        let (container_id, work_dir) = create_test_container(
            &docker,
            "noj-judge-test-runner",
            &["python3", "-c", "print(42)"],
            256,
            10000,
        )
        .await
        .expect("创建容器失败");

        let output = wait_container(&docker, &container_id, 10000)
            .await
            .expect("等待容器失败");

        assert_eq!(
            output.exit_code, 0,
            "预期退出码 0，实际 {}",
            output.exit_code
        );
        assert!(
            output.stdout.contains("42"),
            "stdout 应包含 '42'，实际: {}",
            output.stdout
        );

        let _ = std::fs::remove_dir_all(&work_dir);
    }
);

e2e_test!(
    #[ignore]
    test_container_non_zero_exit,
    async {
        let docker = get_docker().expect("连接 Docker 失败");
        ensure_test_image(&docker).await.expect("确保测试镜像失败");
        let (container_id, work_dir) = create_test_container(
            &docker,
            "noj-judge-test-runner",
            &["python3", "-c", "exit(42)"],
            256,
            10000,
        )
        .await
        .expect("创建容器失败");

        let output = wait_container(&docker, &container_id, 10000)
            .await
            .expect("等待容器失败");

        assert_eq!(
            output.exit_code, 42,
            "预期退出码 42，实际 {}",
            output.exit_code
        );
        let _ = std::fs::remove_dir_all(&work_dir);
    }
);

e2e_test!(
    #[ignore]
    test_container_stdout_and_stderr,
    async {
        let docker = get_docker().expect("连接 Docker 失败");
        ensure_test_image(&docker).await.expect("确保测试镜像失败");
        let code = "import sys; print('stdout msg'); print('stderr msg', file=sys.stderr)";
        let (container_id, work_dir) = create_test_container(
            &docker,
            "noj-judge-test-runner",
            &["python3", "-c", code],
            256,
            10000,
        )
        .await
        .expect("创建容器失败");

        let output = wait_container(&docker, &container_id, 10000)
            .await
            .expect("等待容器失败");

        assert_eq!(output.exit_code, 0);
        assert!(
            output.stdout.contains("stdout msg"),
            "stdout 应包含 'stdout msg'"
        );
        let all_output = format!("{} {}", output.stdout, output.stderr);
        assert!(all_output.contains("stderr msg"), "输出应包含 'stderr msg'");
        let _ = std::fs::remove_dir_all(&work_dir);
    }
);
