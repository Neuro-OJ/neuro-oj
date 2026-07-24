// Docker 资源限制集成测试。
//
// 验证：超时 kill、OOM 限制、正常内存使用。
mod common;
use common::{create_test_container, ensure_test_image, get_docker, wait_container};

e2e_test!(
    #[ignore]
    test_timeout_kill,
    async {
        let docker = get_docker().expect("连接 Docker 失败");
        ensure_test_image(&docker).await.expect("确保测试镜像失败");
        let (container_id, work_dir) = create_test_container(
            &docker,
            "noj-judge-test-runner",
            &["python3", "/evaluate.py", "--hang"],
            256,
            3000,
        )
        .await
        .expect("创建容器失败");

        let output = wait_container(&docker, &container_id, 3000)
            .await
            .expect("等待容器失败");

        assert_eq!(
            output.exit_code, -1,
            "超时应返回 exit_code=-1，实际 {}",
            output.exit_code
        );
        let _ = std::fs::remove_dir_all(&work_dir);
    }
);

e2e_test!(
    #[ignore]
    test_normal_execution_no_timeout,
    async {
        let docker = get_docker().expect("连接 Docker 失败");
        ensure_test_image(&docker).await.expect("确保测试镜像失败");
        let (container_id, work_dir) = create_test_container(
            &docker,
            "noj-judge-test-runner",
            &["python3", "-c", "print('fast')"],
            256,
            30000,
        )
        .await
        .expect("创建容器失败");

        let output = wait_container(&docker, &container_id, 30000)
            .await
            .expect("等待容器失败");

        assert_eq!(
            output.exit_code, 0,
            "正常退出预期 0，实际 {}",
            output.exit_code
        );
        assert!(output.stdout.contains("fast"));
        let _ = std::fs::remove_dir_all(&work_dir);
    }
);

e2e_test!(
    #[ignore]
    test_oom_kill,
    async {
        let docker = get_docker().expect("连接 Docker 失败");
        ensure_test_image(&docker).await.expect("确保测试镜像失败");
        let (container_id, work_dir) = create_test_container(
            &docker,
            "noj-judge-test-runner",
            &["python3", "/evaluate.py", "--memory-test"],
            50,
            15000,
        )
        .await
        .expect("创建容器失败");

        let output = wait_container(&docker, &container_id, 15000)
            .await
            .expect("等待容器失败");

        // OOM kill 退出码 137 = 128 + SIGKILL(9)
        assert!(
            output.exit_code == 137 || output.exit_code == -1,
            "OOM 预期退出码 137（或超时 -1），实际 {}",
            output.exit_code
        );
        let _ = std::fs::remove_dir_all(&work_dir);
    }
);

e2e_test!(
    #[ignore]
    test_memory_within_limits,
    async {
        let docker = get_docker().expect("连接 Docker 失败");
        ensure_test_image(&docker).await.expect("确保测试镜像失败");
        let (container_id, work_dir) = create_test_container(
            &docker,
            "noj-judge-test-runner",
            &["python3", "-c", "data = [0] * 100000; print(len(data))"],
            256,
            10000,
        )
        .await
        .expect("创建容器失败");

        let output = wait_container(&docker, &container_id, 10000)
            .await
            .expect("等待容器失败");

        assert_eq!(output.exit_code, 0);
        assert!(output.stdout.contains("100000"));
        let _ = std::fs::remove_dir_all(&work_dir);
    }
);
