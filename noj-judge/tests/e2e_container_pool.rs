/// 容器池 E2E 集成测试。
///
/// 验证：池初始化、容器分配、docker exec 执行、内存调整、超时处理、空闲回收、安全加固。
///
/// 运行方式：
/// ```bash
/// NOJ_RUN_E2E=1 cargo test --test e2e_container_pool -- --ignored
/// ```
mod common;
// Path and Arc used in tests below

use bollard::container::{
    Config, CreateContainerOptions, InspectContainerOptions, LogsOptions, RemoveContainerOptions,
    StartContainerOptions,
};
use bollard::models::HostConfig;
use bollard::Docker;
use common::{get_docker, is_e2e_enabled};

use noj_judge::pool::PoolManager;
use noj_judge::pool::exec::execute_in_container;
use noj_judge::pool::with_timeout;

// ── Helper ─────────────────────────────────────────────

/// 创建不带池的独立测试容器用于对比。
async fn create_test_container_raw(
    docker: &Docker,
    cmd: &[&str],
    memory_mb: u64,
) -> Result<String, anyhow::Error> {
    let container_name = format!("noj-pool-test-{}", uuid::Uuid::new_v4());
    let cmd_parts: Vec<String> = cmd.iter().map(|s| s.to_string()).collect();

    let config = Config {
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
            Some(CreateContainerOptions {
                name: &container_name,
                platform: None,
            }),
            config,
        )
        .await?;
    docker
        .start_container(&container.id, None::<StartContainerOptions<String>>)
        .await?;
    Ok(container.id)
}

/// 捕获容器的完整 stdout/stderr。
async fn capture_container_logs(
    docker: &Docker,
    container_id: &str,
) -> (String, String, i64) {
    let inspect = docker
        .inspect_container(container_id, None::<InspectContainerOptions>)
        .await;
    let exit_code = inspect
        .ok()
        .and_then(|i| i.state)
        .and_then(|s| s.exit_code)
        .unwrap_or(-1);

    let options = LogsOptions::<String> {
        stdout: true,
        stderr: true,
        ..Default::default()
    };

    let mut stdout = String::new();
    let mut stderr = String::new();
    let mut stream = docker.logs(container_id, Some(options));
    use futures_util::StreamExt;
    while let Some(item) = stream.next().await {
        match item {
            Ok(bollard::container::LogOutput::StdOut { message }) => {
                stdout.push_str(&String::from_utf8_lossy(&message));
            }
            Ok(bollard::container::LogOutput::StdErr { message }) => {
                stderr.push_str(&String::from_utf8_lossy(&message));
            }
            _ => {}
        }
    }
    (stdout, stderr, exit_code)
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
    let config = noj_judge::config::PoolConfig {
        enabled: true,
        initial_size: 2,
        max_size: 4,
        min_size: 1,
        memory_mb: 256,
        cpu: 0.0,
        images: vec!["noj-judge-test-runner".to_string()],
        per_image_memory: std::collections::HashMap::new(),
        idle_timeout_secs: 300,
        scale_interval_secs: 60,
        max_archive_mb: 25,
        kill_grace_secs: 2,
        label_prefix: "com.noj.judge.test".to_string(),
    };

    let pool = PoolManager::init(docker.clone(), config)
        .await
        .expect("PoolManager init 失败");

    // 验证池中有 2 个空闲容器
    let pools = pool.all_pools().await;
    assert!(!pools.is_empty(), "应有至少一个镜像的池");
    let test_pool = pools.into_iter().find(|p| p.image() == "noj-judge-test-runner");
    assert!(test_pool.is_some(), "应找到 test-runner 池");

    let idle = test_pool.unwrap().idle_count().await;
    assert_eq!(idle, 2, "启动时应有 2 个空闲容器");

    // 清理池
    let _ = docker
        .remove_container(
            "noj-judge-test-runner",
            None::<RemoveContainerOptions>,
        )
        .await;
}

/// 2. 完整执行路径：acquire → docker update → exec → rm → 回补。
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

    let config = noj_judge::config::PoolConfig {
        enabled: true,
        initial_size: 1,
        max_size: 2,
        min_size: 1,
        memory_mb: 256,
        cpu: 0.0,
        images: vec!["noj-judge-test-runner".to_string()],
        per_image_memory: std::collections::HashMap::new(),
        idle_timeout_secs: 300,
        scale_interval_secs: 60,
        max_archive_mb: 25,
        kill_grace_secs: 2,
        label_prefix: "com.noj.judge.test".to_string(),
    };

    let pool = PoolManager::init(docker.clone(), config)
        .await
        .expect("PoolManager init 失败");

    // acquire 容器
    let container_id = pool
        .acquire("noj-judge-test-runner", 128)
        .await
        .expect("acquire 失败");

    // 验证容器正在运行
    let inspect = docker
        .inspect_container(&container_id, None::<InspectContainerOptions>)
        .await
        .expect("inspect 失败");
    let running = inspect
        .state
        .as_ref()
        .and_then(|s| s.running)
        .unwrap_or(false);
    assert!(running, "池容器应正在运行");

    // 通过 exec 执行简单命令
    let (stdout, stderr, exit_code) = execute_in_container(
        &docker,
        &container_id,
        &["python3".to_string(), "-c".to_string(), "print('pool-exec')".to_string()],
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

    // 释放并删除容器
    if let Some(p) = pool.get_pool("noj-judge-test-runner").await {
        pool.release(&p, &container_id).await;
    }

    // 验证容器已被删除
    let inspect_result = docker
        .inspect_container(&container_id, None::<InspectContainerOptions>)
        .await;
    assert!(
        inspect_result.is_err(),
        "容器应已被删除"
    );
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
    let container_id = create_test_container_raw(&docker, &["sleep", "infinity"], 512).await
        .expect("创建预热容器失败");

    // 读取初始 memory 限制
    let inspect = docker
        .inspect_container(&container_id, None::<InspectContainerOptions>)
        .await
        .expect("inspect 失败");
    let initial_memory = inspect
        .host_config
        .as_ref()
        .and_then(|h| h.memory)
        .unwrap_or(0);
    assert_eq!(initial_memory, 512 * 1024 * 1024, "初始内存应为 512MB");

    // 使用 docker update 下调到 64MB
    use bollard::container::UpdateContainerOptions;
    docker
        .update_container(
            &container_id,
            UpdateContainerOptions::<String> {
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
        .inspect_container(&container_id, None::<InspectContainerOptions>)
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
        .remove_container(&container_id, Some(RemoveContainerOptions { force: true, ..Default::default() }))
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

    let container_id = create_test_container_raw(&docker, &["sleep", "infinity"], 256).await
        .expect("创建容器失败");

    // 执行一个长时间运行的任务，设置短超时
    let (stdout, stderr, exit_code) = execute_in_container(
        &docker,
        &container_id,
        &["python3".to_string(), "-c".to_string(),
          "import time; time.sleep(30); print('done')".to_string()],
        2000, // 2s 超时
        2,
    )
    .await
    .expect("exec 应返回（即使超时）");

    assert_eq!(exit_code, -1, "超时应返回 exit_code=-1，实际: {}", exit_code);

    // 清理
    docker
        .remove_container(&container_id, Some(RemoveContainerOptions { force: true, ..Default::default() }))
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

    let config = noj_judge::config::PoolConfig {
        enabled: true,
        initial_size: 1,
        max_size: 2,
        min_size: 1,
        memory_mb: 256,
        cpu: 0.0,
        images: vec!["noj-judge-test-runner".to_string()],
        per_image_memory: std::collections::HashMap::new(),
        idle_timeout_secs: 300,
        scale_interval_secs: 60,
        max_archive_mb: 25,
        kill_grace_secs: 2,
        label_prefix: "com.noj.judge.test".to_string(),
    };

    let pool = PoolManager::init(docker.clone(), config)
        .await
        .expect("PoolManager init 失败");

    // 获取池中容器
    let test_pool = pool.get_pool("noj-judge-test-runner").await.expect("应有 test-runner 池");
    let container_id = pool
        .acquire("noj-judge-test-runner", 128)
        .await
        .expect("acquire 失败");

    // inspect 验证安全配置
    let inspect = docker
        .inspect_container(&container_id, None::<InspectContainerOptions>)
        .await
        .expect("inspect 失败");

    let hc = inspect.host_config.as_ref().expect("应有 host_config");

    // CapDrop ALL
    assert!(
        hc.cap_drop.as_ref().is_some(),
        "cap_drop 应被设置"
    );
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

    // 释放
    if let Some(p) = pool.get_pool("noj-judge-test-runner").await {
        pool.release(&p, &container_id).await;
    }
}

/// 6. 队列等待：超过并发上限时应排队。
#[ignore]
#[serial_test::serial]
#[tokio::test]
async fn test_pool_queue_wait() {
    if !is_e2e_enabled() {
        return;
    }

    let docker = get_docker().expect("连接 Docker 失败");
    common::ensure_test_image(&docker)
        .await
        .expect("确保测试镜像失败");

    let config = noj_judge::config::PoolConfig {
        enabled: true,
        initial_size: 1,
        max_size: 1,  // 最大 1 个并发
        min_size: 1,
        memory_mb: 256,
        cpu: 0.0,
        images: vec!["noj-judge-test-runner".to_string()],
        per_image_memory: std::collections::HashMap::new(),
        idle_timeout_secs: 300,
        scale_interval_secs: 60,
        max_archive_mb: 25,
        kill_grace_secs: 2,
        label_prefix: "com.noj.judge.test".to_string(),
    };

    let pool = PoolManager::init(docker.clone(), config)
        .await
        .expect("PoolManager init 失败");

    // 占用唯一的槽位
    let c1 = pool
        .acquire("noj-judge-test-runner", 128)
        .await
        .expect("第一次 acquire 应成功");

    // 第二次 acquire 应排队（但因为我们不阻塞太久，通过获取超时来验证）
    let start = std::time::Instant::now();
    let timeout_result = tokio::time::timeout(
        std::time::Duration::from_millis(500),
        pool.acquire("noj-judge-test-runner", 128),
    )
    .await;

    assert!(
        timeout_result.is_err(),
        "超过 max_size 时应排队阻塞（500ms 超时）"
    );

    // 释放 c1 让队列继续
    if let Some(p) = pool.get_pool("noj-judge-test-runner").await {
        pool.release(&p, &c1).await;
    }
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
    let result = with_timeout(5, "ping", async { docker.ping().await.map_err(anyhow::Error::from) }).await;
    assert!(result.is_ok(), "docker ping 应在 5s 内完成");
}
