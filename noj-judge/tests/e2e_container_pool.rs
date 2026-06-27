/// 容器池 E2E 集成测试。
///
/// 验证：池初始化、容器分配、docker exec 执行、内存调整、超时处理、空闲回收、安全加固。
///
/// 运行方式：
/// ```bash
/// NOJ_RUN_E2E=1 cargo test --test e2e_container_pool -- --ignored
/// ```
mod common;

use std::time::Duration;

use bollard::container::LogOutput;
use bollard::models::ContainerCreateBody;
use bollard::models::HostConfig;
use bollard::Docker;
use common::{get_docker, is_e2e_enabled};

use noj_judge::pool::exec::execute_in_container;
use noj_judge::pool::with_timeout;
use noj_judge::pool::PoolManager;

// ── Helper ─────────────────────────────────────────────

/// 创建不带池的独立测试容器用于对比。
async fn create_test_container_raw(
    docker: &Docker,
    cmd: &[&str],
    memory_mb: u64,
) -> Result<String, anyhow::Error> {
    let container_name = format!("noj-pool-test-{}", uuid::Uuid::new_v4());
    let cmd_parts: Vec<String> = cmd.iter().map(|s| s.to_string()).collect();

    let config = ContainerCreateBody {
        image: Some("noj-judge-test-runner".to_string()),
        cmd: Some(cmd_parts),
        host_config: Some(HostConfig {
            memory: Some(memory_mb as i64 * 1024 * 1024),
            memory_swap: Some(memory_mb as i64 * 1024 * 1024),
            nano_cpus: Some(1_000_000_000),
            network_mode: Some("none".to_string()),
            cap_drop: Some(vec!["ALL".to_string()]),
            readonly_rootfs: Some(false),
            security_opt: Some(vec!["no-new-privileges:true".to_string()]),
            auto_remove: Some(false),
            ..Default::default()
        }),
        ..Default::default()
    };

    let container = docker
        .create_container(
            Some(bollard::query_parameters::CreateContainerOptions {
                name: Some(container_name.to_string()),
                platform: String::new(),
            }),
            config,
        )
        .await?;
    docker
        .start_container(
            &container.id,
            None::<bollard::query_parameters::StartContainerOptions>,
        )
        .await?;
    Ok(container.id)
}

/// 捕获容器的完整 stdout/stderr。
#[allow(dead_code)]
async fn capture_container_logs(docker: &Docker, container_id: &str) -> (String, String, i64) {
    let inspect = docker
        .inspect_container(
            container_id,
            None::<bollard::query_parameters::InspectContainerOptions>,
        )
        .await;
    let exit_code = inspect
        .ok()
        .and_then(|i| i.state)
        .and_then(|s| s.exit_code)
        .unwrap_or(-1);

    let options = bollard::query_parameters::LogsOptions {
        stdout: true,
        stderr: true,
        follow: false,
        since: 0,
        until: 0,
        timestamps: false,
        tail: "all".to_string(),
    };

    let mut stdout = String::new();
    let mut stderr = String::new();
    let mut stream = docker.logs(container_id, Some(options));
    use futures_util::StreamExt;
    while let Some(item) = stream.next().await {
        match item {
            Ok(LogOutput::StdOut { message }) => {
                stdout.push_str(&String::from_utf8_lossy(&message));
            }
            Ok(LogOutput::StdErr { message }) => {
                stderr.push_str(&String::from_utf8_lossy(&message));
            }
            _ => {}
        }
    }
    (stdout, stderr, exit_code)
}

/// 创建测试用的 PoolConfig。
fn make_pool_config(initial_size: usize, max_size: usize) -> noj_judge::config::PoolConfig {
    noj_judge::config::PoolConfig {
        initial_size,
        max_size,
        min_size: 1,
        memory_mb: 256,
        cpu: 0.0,
        idle_timeout_secs: 300,
        max_archive_mb: 25,
        kill_grace_secs: 2,
        label_prefix: "com.noj.judge.test".to_string(),
        images: vec!["noj-judge-test-runner".to_string()],
    }
}

/// 测试用的镜像列表。
fn test_images() -> Vec<String> {
    vec!["noj-judge-test-runner".to_string()]
}

// ── Tests ──────────────────────────────────────────────

/// 1. 池初始化：验证 POOL_INITIAL_SIZE 个容器已创建并运行。
#[ignore]
#[serial_test::serial]
#[tokio::test]
async fn test_pool_initialization() {
    if !is_e2e_enabled() {
        return;
    }

    let docker = get_docker().expect("连接 Docker 失败");
    common::ensure_test_image(&docker)
        .await
        .expect("确保测试镜像失败");

    // 初始化池管理器
    let config = make_pool_config(2, 4);

    let pool = PoolManager::init(docker.clone(), config, &test_images())
        .await
        .expect("PoolManager init 失败");

    // 验证池中有 2 个空闲容器
    let pools = pool.all_pools().await;
    assert!(!pools.is_empty(), "应有至少一个镜像的池");
    let test_pool = pools
        .into_iter()
        .find(|p| p.image() == "noj-judge-test-runner");
    assert!(test_pool.is_some(), "应找到 test-runner 池");

    let idle = test_pool.unwrap().idle_count().await;
    assert_eq!(idle, 2, "启动时应有 2 个空闲容器");
}

/// 2. 完整执行路径：with_container → docker exec → 自动清理。
#[ignore]
#[serial_test::serial]
#[tokio::test]
async fn test_pool_full_execution_path() {
    if !is_e2e_enabled() {
        return;
    }

    let docker = get_docker().expect("连接 Docker 失败");
    common::ensure_test_image(&docker)
        .await
        .expect("确保测试镜像失败");

    let config = make_pool_config(1, 2);
    let pool = PoolManager::init(docker.clone(), config, &test_images())
        .await
        .expect("PoolManager init 失败");

    // 使用 with_container 闭包 API
    let docker_for_inspect = docker.clone();
    let result: Result<String, anyhow::Error> = pool
        .with_container("noj-judge-test-runner", 128, |container_id| {
            let docker = docker_for_inspect.clone();
            async move {
                // 验证容器正在运行
                let inspect = docker
                    .inspect_container(
                        &container_id,
                        None::<bollard::query_parameters::InspectContainerOptions>,
                    )
                    .await
                    .expect("inspect 失败");
                let running = inspect
                    .state
                    .as_ref()
                    .and_then(|s| s.running)
                    .unwrap_or(false);
                assert!(running, "池容器应正在运行");

                // 通过 exec 执行简单命令
                let (stdout, _stderr, exit_code, _time_ms) = execute_in_container(
                    &docker,
                    &container_id,
                    &[
                        "python3".to_string(),
                        "-c".to_string(),
                        "print('pool-exec')".to_string(),
                    ],
                    10000,
                    2,
                )
                .await
                .expect("exec 执行失败");

                assert_eq!(exit_code, 0, "exit_code 应为 0，实际: {}", exit_code);
                assert!(
                    stdout.contains("pool-exec"),
                    "stdout 应包含 'pool-exec'，实际: {}",
                    stdout
                );

                Ok(container_id.clone())
            }
        })
        .await;

    let container_id = result.expect("with_container 失败");

    // 验证容器已被删除（with_container 退出后自动 release → rm -f）
    let inspect_result = docker
        .inspect_container(
            &container_id,
            None::<bollard::query_parameters::InspectContainerOptions>,
        )
        .await;
    assert!(inspect_result.is_err(), "容器应已被删除");
}

/// 3. 动态内存调整验证。
#[ignore]
#[serial_test::serial]
#[tokio::test]
async fn test_pool_memory_update() {
    if !is_e2e_enabled() {
        return;
    }

    let docker = get_docker().expect("连接 Docker 失败");
    common::ensure_test_image(&docker)
        .await
        .expect("确保测试镜像失败");

    // 先创建容器（直接用 create_test_container_raw）
    let container_id = create_test_container_raw(&docker, &["sleep", "infinity"], 512)
        .await
        .expect("创建预热容器失败");

    // 读取初始 memory 限制
    let inspect = docker
        .inspect_container(
            &container_id,
            None::<bollard::query_parameters::InspectContainerOptions>,
        )
        .await
        .expect("inspect 失败");
    let initial_memory = inspect
        .host_config
        .as_ref()
        .and_then(|h| h.memory)
        .unwrap_or(0);
    assert_eq!(initial_memory, 512 * 1024 * 1024, "初始内存应为 512MB");

    // 使用 docker update 下调到 64MB
    docker
        .update_container(
            &container_id,
            bollard::models::ContainerUpdateBody {
                memory: Some(64 * 1024 * 1024),
                memory_swap: Some(64 * 1024 * 1024),
                memory_swappiness: Some(0),
                ..Default::default()
            },
        )
        .await
        .expect("update_container 失败");

    // 验证内存已更新
    let inspect = docker
        .inspect_container(
            &container_id,
            None::<bollard::query_parameters::InspectContainerOptions>,
        )
        .await
        .expect("inspect 失败");
    let updated_memory = inspect
        .host_config
        .as_ref()
        .and_then(|h| h.memory)
        .unwrap_or(0);
    assert_eq!(updated_memory, 64 * 1024 * 1024, "更新后内存应为 64MB");

    // 清理
    docker
        .remove_container(
            &container_id,
            Some(bollard::query_parameters::RemoveContainerOptions {
                force: true,
                ..Default::default()
            }),
        )
        .await
        .expect("清理容器失败");
}

/// 4. exec 超时处理。
#[ignore]
#[serial_test::serial]
#[tokio::test]
async fn test_pool_exec_timeout() {
    if !is_e2e_enabled() {
        return;
    }

    let docker = get_docker().expect("连接 Docker 失败");
    common::ensure_test_image(&docker)
        .await
        .expect("确保测试镜像失败");

    let container_id = create_test_container_raw(&docker, &["sleep", "infinity"], 256)
        .await
        .expect("创建容器失败");

    // 执行一个长时间运行的任务，设置短超时
    let (_stdout, _stderr, exit_code, _time_ms) = execute_in_container(
        &docker,
        &container_id,
        &[
            "python3".to_string(),
            "-c".to_string(),
            "import time; time.sleep(30); print('done')".to_string(),
        ],
        2000, // 2s 超时
        2,
    )
    .await
    .expect("exec 应返回（即使超时）");

    assert_eq!(
        exit_code, -1,
        "超时应返回 exit_code=-1，实际: {}",
        exit_code
    );

    // 清理
    docker
        .remove_container(
            &container_id,
            Some(bollard::query_parameters::RemoveContainerOptions {
                force: true,
                ..Default::default()
            }),
        )
        .await
        .expect("清理容器失败");
}

/// 5. 容器安全配置验证：CapDrop、readonly_rootfs、network_mode。
#[ignore]
#[serial_test::serial]
#[tokio::test]
async fn test_pool_security_config() {
    if !is_e2e_enabled() {
        return;
    }

    let docker = get_docker().expect("连接 Docker 失败");
    common::ensure_test_image(&docker)
        .await
        .expect("确保测试镜像失败");

    let config = make_pool_config(1, 2);
    let pool = PoolManager::init(docker.clone(), config, &test_images())
        .await
        .expect("PoolManager init 失败");

    pool.with_container("noj-judge-test-runner", 128, |container_id| async move {
        // inspect 验证安全配置
        let inspect = docker
            .inspect_container(
                &container_id,
                None::<bollard::query_parameters::InspectContainerOptions>,
            )
            .await
            .expect("inspect 失败");

        let hc = inspect.host_config.as_ref().expect("应有 host_config");

        // CapDrop ALL
        assert!(hc.cap_drop.as_ref().is_some(), "cap_drop 应被设置");
        let caps = hc.cap_drop.as_ref().unwrap();
        assert!(caps.iter().any(|c| c == "ALL"), "cap_drop 应包含 ALL");

        // network_mode none
        assert_eq!(
            hc.network_mode.as_deref(),
            Some("none"),
            "network_mode 应为 none"
        );

        // readonly_rootfs
        assert_eq!(
            hc.readonly_rootfs,
            Some(false),
            "readonly_rootfs 应为 false（put_archive 兼容性）"
        );

        Ok(())
    })
    .await
    .expect("with_container 失败");
}

/// 6. 并发任务：池可同时运行多个任务（即时创建补足空闲不足）。
#[ignore]
#[serial_test::serial]
#[tokio::test]
async fn test_pool_concurrent_tasks() {
    if !is_e2e_enabled() {
        return;
    }

    let docker = get_docker().expect("连接 Docker 失败");
    common::ensure_test_image(&docker)
        .await
        .expect("确保测试镜像失败");

    let config = make_pool_config(1, 2); // 初始 1 个空闲，最大 2
    let pool = PoolManager::init(docker.clone(), config, &test_images())
        .await
        .expect("PoolManager init 失败");

    // 并发运行 2 个任务（第 2 个需即时创建容器）
    let pool1 = pool.clone();
    let pool2 = pool.clone();
    let (r1, r2) = tokio::join!(
        tokio::spawn(async move {
            pool1
                .with_container("noj-judge-test-runner", 128, |_id| async move {
                    tokio::time::sleep(Duration::from_millis(500)).await;
                    Ok::<_, anyhow::Error>("done".to_string())
                })
                .await
        }),
        tokio::spawn(async move {
            pool2
                .with_container("noj-judge-test-runner", 128, |_id| async move {
                    tokio::time::sleep(Duration::from_millis(500)).await;
                    Ok::<_, anyhow::Error>("done".to_string())
                })
                .await
        }),
    );

    assert!(r1.unwrap().is_ok(), "任务 1 应成功");
    assert!(r2.unwrap().is_ok(), "任务 2 应成功（即时创建容器）");
}

/// 7. 带超时的 bollard API 调用测试。
#[ignore]
#[serial_test::serial]
#[tokio::test]
async fn test_pool_with_timeout() {
    if !is_e2e_enabled() {
        return;
    }

    let docker = get_docker().expect("连接 Docker 失败");

    // 正常的调用应通过
    let result = with_timeout(5, "ping", async {
        docker.ping().await.map_err(anyhow::Error::from)
    })
    .await;
    assert!(result.is_ok(), "docker ping 应在 5s 内完成");
}
