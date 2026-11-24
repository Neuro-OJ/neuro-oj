// Docker 安全隔离与资源限制对抗测试矩阵。
// 覆盖：生产 HostConfig 宿主边界与网络隔离、Fork 炸弹、OOM、Readonly rootfs、Capabilities 与非 ignore 单元测试。
use std::collections::HashMap;

use bollard::models::ContainerCreateBody;
use bollard::Docker;
mod common;
use common::{create_test_container, ensure_test_image, get_docker, wait_container};
use noj_judge::sandbox::host_config::build_host_config_with_cpu;

e2e_test!(
    #[ignore]
    test_network_isolation,
    async {
        let docker = get_docker().expect("连接 Docker 失败");
        ensure_test_image(&docker).await.expect("确保测试镜像失败");
        let code =
            "import urllib.request; urllib.request.urlopen('https://example.com', timeout=5)";
        let (container_id, work_dir) = create_test_container(
            &docker,
            "noj-judge-test-runner",
            &["python3", "-c", code],
            256,
            15000,
        )
        .await
        .expect("创建容器失败");

        let output = wait_container(&docker, &container_id, 15000)
            .await
            .expect("等待容器失败");

        // 网络请求应被阻断，退出码非 0
        assert_ne!(output.exit_code, 0, "网络隔离测试：请求应失败但退出了码 0");
        let _ = std::fs::remove_dir_all(&work_dir);
    }
);

// 使用生产路径的 HostConfig 创建容器，避免测试辅助函数中的临时 /tmp bind
// 掩盖评测容器不得挂载宿主路径这一安全约束。
e2e_test!(
    #[ignore]
    test_evaluation_container_host_boundary,
    async {
        let docker = get_docker().expect("连接 Docker 失败");
        ensure_test_image(&docker).await.expect("确保测试镜像失败");
        let host_config =
            build_host_config_with_cpu(256 * 1024 * 1024, HashMap::new(), true, "none", 1000);
        let config = ContainerCreateBody {
            image: Some("noj-judge-test-runner:latest".to_string()),
            cmd: Some(vec![
                "python3".to_string(),
                "-c".to_string(),
                "import os; paths=['/var/run/docker.sock','/host','/var/lib/docker']; [print(p) for p in paths if os.path.exists(p)]".to_string(),
            ]),
            host_config: Some(host_config),
            ..Default::default()
        };
        let container = docker
            .create_container(
                Some(bollard::query_parameters::CreateContainerOptions {
                    name: Some(format!("noj-security-{}", uuid::Uuid::new_v4())),
                    platform: String::new(),
                }),
                config,
            )
            .await
            .expect("创建安全隔离容器失败");

        let inspected = docker
            .inspect_container(
                &container.id,
                None::<bollard::query_parameters::InspectContainerOptions>,
            )
            .await
            .expect("检查安全隔离容器失败");
        let host_config = inspected.host_config.expect("容器缺少 HostConfig");
        // Docker inspect 未设置的 namespace 可能为 Some("")；只要非 host 或 container:<id> 即安全。
        let no_host_access = host_config.binds.unwrap_or_default().is_empty()
            && host_config.mounts.unwrap_or_default().is_empty()
            && host_config.devices.unwrap_or_default().is_empty()
            && host_config.cap_add.unwrap_or_default().is_empty()
            && !host_config
                .pid_mode
                .as_deref()
                .is_some_and(|mode| mode == "host" || mode.starts_with("container:"))
            && !host_config
                .uts_mode
                .as_deref()
                .is_some_and(|mode| mode == "host" || mode.starts_with("container:"))
            && host_config.privileged == Some(false);

        docker
            .start_container(
                &container.id,
                None::<bollard::query_parameters::StartContainerOptions>,
            )
            .await
            .expect("启动安全隔离容器失败");
        let output = wait_container(&docker, &container.id, 10000)
            .await
            .expect("等待安全隔离容器失败");
        assert!(no_host_access, "HostConfig 不得授予宿主或其他容器访问权限");
        assert_eq!(output.exit_code, 0);
        assert!(
            output.stdout.trim().is_empty(),
            "发现宿主机敏感路径: {}",
            output.stdout
        );
        run_host_boundary_adversarial(&docker, &container.id).await;
    }
);

// 敏感路径不可访问测试。
//
// 验证容器内无法访问宿主机敏感路径。
// 注意：/etc/passwd 和 /proc/* 在正常 Docker 容器中天然存在
//（分别来自镜像和 /proc 挂载），不代表宿主机路径泄漏。
e2e_test!(
    #[ignore]
    test_container_no_sensitive_mounts,
    async {
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

        let output = wait_container(&docker, &container_id, 10000)
            .await
            .expect("等待容器失败");

        assert_eq!(output.exit_code, 0, "敏感路径检查应正常退出");
        assert!(
            output.stdout.trim().is_empty(),
            "不应发现宿主机敏感路径，但找到了: {}",
            output.stdout
        );
        let _ = std::fs::remove_dir_all(&work_dir);

        run_readonly_rootfs_rejects_write(&docker).await;
        run_capabilities_dropped_and_no_new_privileges(&docker).await;
    }
);

use bollard::models::HostConfig;
use noj_judge::config::{
    validate_evaluator_network_mode, DEFAULT_EVALUATOR_NETWORK, MAX_CPU_LIMIT_MILLICORES,
    MIN_CPU_LIMIT_MILLICORES,
};
use noj_judge::sandbox::container::extract_zip_entries_from_file;
use std::io::Write;

/// 使用生产路径 `HostConfig` 创建并启动安全对抗测试容器，返回容器 ID。
async fn create_hardened_container(
    docker: &Docker,
    cmd: &[&str],
    host_config: HostConfig,
) -> String {
    let config = ContainerCreateBody {
        image: Some("noj-judge-test-runner:latest".to_string()),
        cmd: Some(cmd.iter().map(|s| s.to_string()).collect()),
        host_config: Some(host_config),
        ..Default::default()
    };
    let container = docker
        .create_container(
            Some(bollard::query_parameters::CreateContainerOptions {
                name: Some(format!("noj-security-{}", uuid::Uuid::new_v4())),
                platform: String::new(),
            }),
            config,
        )
        .await
        .expect("创建安全隔离容器失败");

    docker
        .start_container(
            &container.id,
            None::<bollard::query_parameters::StartContainerOptions>,
        )
        .await
        .expect("启动安全隔离容器失败");
    container.id
}

async fn force_remove_container(docker: &Docker, container_id: &str) {
    let _ = docker
        .remove_container(
            container_id,
            Some(bollard::query_parameters::RemoveContainerOptions {
                force: true,
                ..Default::default()
            }),
        )
        .await;
}

async fn run_host_boundary_adversarial(docker: &Docker, container_id: &str) {
    force_remove_container(docker, container_id).await;
    run_fork_bomb_blocked_by_pids_limit(docker).await;
    run_memory_limit_oom_isolation(docker).await;
}

// 对抗 1：Fork 炸弹拦截（验证 pids_limit=256 触发 cgroup pids 限制而不拖垮宿主机）。
async fn run_fork_bomb_blocked_by_pids_limit(docker: &Docker) {
    let host_config =
        build_host_config_with_cpu(128 * 1024 * 1024, HashMap::new(), true, "none", 1000);
    assert_eq!(host_config.pids_limit, Some(256));

    let script = r#"
import os, time
children = []
blocked = False
for _ in range(400):
    try:
        pid = os.fork()
        if pid == 0:
            time.sleep(2)
            os._exit(0)
        children.append(pid)
    except OSError:
        blocked = True
        break
for pid in children:
    try:
        os.waitpid(pid, 0)
    except ChildProcessError:
        pass
print(f"FORKED={len(children)} BLOCKED={blocked}")
assert blocked, "pids_limit 256 应拦截超限 fork"
assert len(children) <= 256, f"子进程数超出 pids_limit: {len(children)}"
"#;
    let container_id =
        create_hardened_container(docker, &["python3", "-c", script], host_config).await;

    let inspected = docker
        .inspect_container(
            &container_id,
            None::<bollard::query_parameters::InspectContainerOptions>,
        )
        .await
        .expect("检查容器失败");
    assert_eq!(
        inspected.host_config.and_then(|h| h.pids_limit),
        Some(256),
        "容器 pids_limit 必须为 256"
    );

    let output = wait_container(docker, &container_id, 15000)
        .await
        .expect("等待容器失败");
    force_remove_container(docker, &container_id).await;

    assert_eq!(
        output.exit_code, 0,
        "fork 炸弹测试异常退出: stdout={}, stderr={}",
        output.stdout, output.stderr
    );
    assert!(
        output.stdout.contains("BLOCKED=True"),
        "未观察到 fork 被拦截: {}",
        output.stdout
    );
}

// 对抗 2：内存超限 OOM 隔离（验证 cgroup memory + memory_swap 拦截容器内大内存分配）。
async fn run_memory_limit_oom_isolation(docker: &Docker) {
    let host_config =
        build_host_config_with_cpu(64 * 1024 * 1024, HashMap::new(), true, "none", 1000);
    // 分配 256MB 并按 4KB 页写入触发物理页提交，64MB cgroup 限制必然触发 OOM kill (137) 或 MemoryError
    let script = r#"
chunks = []
for _ in range(32):
    buf = bytearray(8 * 1024 * 1024)
    for i in range(0, len(buf), 4096):
        buf[i] = 1
    chunks.append(buf)
print("ALLOCATED_ALL")
"#;
    let container_id =
        create_hardened_container(docker, &["python3", "-c", script], host_config).await;
    let output = wait_container(docker, &container_id, 15000)
        .await
        .expect("等待容器失败");
    force_remove_container(docker, &container_id).await;

    assert!(
        !output.stdout.contains("ALLOCATED_ALL"),
        "超出 64MB 内存上限却完成全部分配: {}",
        output.stdout
    );
    assert!(
        output.exit_code == 137 || output.exit_code != 0,
        "内存超限应被 cgroup OOM 拦截（非 0 退出码），实际 exit_code={}",
        output.exit_code
    );
}

// 对抗 3：Readonly rootfs 越权写入拒绝（尝试写 /etc、/usr 与 / 均应失败，而 tmpfs /tmp 可写）。
async fn run_readonly_rootfs_rejects_write(docker: &Docker) {
    let mut tmpfs = HashMap::new();
    tmpfs.insert("/tmp", "rw,noexec,nosuid,size=32m");
    let host_config = build_host_config_with_cpu(128 * 1024 * 1024, tmpfs, true, "none", 1000);

    let script = r#"
import errno
targets = ['/etc/noj_ro_probe', '/usr/noj_ro_probe', '/noj_ro_probe']
for p in targets:
    try:
        with open(p, 'w') as f:
            f.write('escape')
        raise AssertionError(f'意外写入成功: {p}')
    except OSError as e:
        assert e.errno in (errno.EROFS, errno.EACCES, errno.EPERM), f'{p}: 非预期错误 {e}'
with open('/tmp/noj_tmp_ok', 'w') as f:
    f.write('ok')
print('READONLY_ROOTFS_ENFORCED')
"#;
    let container_id =
        create_hardened_container(docker, &["python3", "-c", script], host_config).await;
    let output = wait_container(docker, &container_id, 10000)
        .await
        .expect("等待容器失败");
    force_remove_container(docker, &container_id).await;

    assert_eq!(
        output.exit_code, 0,
        "readonly rootfs 测试失败: stdout={}, stderr={}",
        output.stdout, output.stderr
    );
    assert!(
        output.stdout.contains("READONLY_ROOTFS_ENFORCED"),
        "缺少只读根文件系统断言输出: {}",
        output.stdout
    );
}

// 对抗 4：Capabilities 丢弃与 no-new-privileges 生效探测。
async fn run_capabilities_dropped_and_no_new_privileges(docker: &Docker) {
    let host_config =
        build_host_config_with_cpu(128 * 1024 * 1024, HashMap::new(), true, "none", 1000);

    let script = r#"
status = {}
with open('/proc/self/status') as f:
    for line in f:
        if ':' in line:
            k, v = line.split(':', 1)
            status[k.strip()] = v.strip()
cap_eff = status.get('CapEff', '')
cap_prm = status.get('CapPrm', '')
no_new_privs = status.get('NoNewPrivs', '')
print(f"CapEff={cap_eff} CapPrm={cap_prm} NoNewPrivs={no_new_privs}")
assert cap_eff == '0000000000000000', f'CapEff 未清零: {cap_eff}'
assert cap_prm == '0000000000000000', f'CapPrm 未清零: {cap_prm}'
assert no_new_privs == '1', f'NoNewPrivs 未生效: {no_new_privs}'
"#;
    let container_id =
        create_hardened_container(docker, &["python3", "-c", script], host_config).await;
    let inspected = docker
        .inspect_container(
            &container_id,
            None::<bollard::query_parameters::InspectContainerOptions>,
        )
        .await
        .expect("检查容器失败");
    let hc = inspected.host_config.expect("缺少 HostConfig");
    assert_eq!(hc.cap_drop, Some(vec!["ALL".to_string()]));
    assert_eq!(hc.privileged, Some(false));
    assert!(
        hc.security_opt
            .unwrap_or_default()
            .iter()
            .any(|opt| opt == "no-new-privileges:true"),
        "security_opt 必须启用 no-new-privileges:true"
    );

    let output = wait_container(docker, &container_id, 10000)
        .await
        .expect("等待容器失败");
    force_remove_container(docker, &container_id).await;

    assert_eq!(
        output.exit_code, 0,
        "Capabilities 探测失败: stdout={}, stderr={}",
        output.stdout, output.stderr
    );
    assert!(output.stdout.contains("NoNewPrivs=1"));
}

// ── 非 ignore 单元测试：网络策略白名单、HostConfig 基线与 zip-slip/symlink 边界 ──

#[test]
fn test_evaluator_network_policy_whitelist_and_forbidden_modes() {
    for allowed in [
        DEFAULT_EVALUATOR_NETWORK,
        "none",
        "noj-eval-net",
        "noj_net.1",
    ] {
        assert!(
            validate_evaluator_network_mode(allowed).is_ok(),
            "合法网络模式 {:?} 应被白名单接受",
            allowed
        );
    }

    for forbidden in [
        "host",
        "HOST",
        "bridge",
        "Bridge",
        "",
        "  ",
        " noj-eval-net",
        "noj-eval-net ",
        "container:core",
        "noj/eval",
        "-bad-net",
    ] {
        assert!(
            validate_evaluator_network_mode(forbidden).is_err(),
            "危险或异常网络模式 {:?} 必须被拒绝",
            forbidden
        );
    }
}

#[test]
fn test_host_config_security_baseline() {
    let mut tmpfs = HashMap::new();
    tmpfs.insert("/tmp", "rw,noexec,nosuid,size=64m");
    let cfg = build_host_config_with_cpu(256 * 1024 * 1024, tmpfs, true, "none", 0);

    assert_eq!(cfg.pids_limit, Some(256));
    assert_eq!(cfg.cap_drop, Some(vec!["ALL".to_string()]));
    assert_eq!(
        cfg.security_opt,
        Some(vec!["no-new-privileges:true".to_string()])
    );
    assert_eq!(cfg.privileged, Some(false));
    assert_eq!(cfg.readonly_rootfs, Some(true));
    assert_eq!(cfg.network_mode, Some("none".to_string()));
    assert_eq!(cfg.ipc_mode, Some("none".to_string()));
    assert_eq!(cfg.memory, Some(256 * 1024 * 1024));
    assert_eq!(cfg.memory_swap, Some(256 * 1024 * 1024));
    assert_eq!(cfg.memory_swappiness, Some(0));
    assert!(cfg.binds.is_none());
    assert!(cfg.mounts.is_none());
    assert!(cfg.devices.is_none());
    assert!(cfg.cap_add.is_none());
    assert!(cfg.pid_mode.is_none());
    assert!(cfg.uts_mode.is_none());
    assert_eq!(
        cfg.nano_cpus,
        Some((MIN_CPU_LIMIT_MILLICORES * 1_000_000) as i64)
    );

    let high_cpu =
        build_host_config_with_cpu(256 * 1024 * 1024, HashMap::new(), true, "none", 999_999);
    assert_eq!(
        high_cpu.nano_cpus,
        Some((MAX_CPU_LIMIT_MILLICORES * 1_000_000) as i64)
    );
}

#[test]
fn test_zip_slip_and_symlink_boundary_rejection() {
    let write_temp_zip =
        |build: &dyn Fn(&mut zip::ZipWriter<std::fs::File>)| -> tempfile::NamedTempFile {
            let file = tempfile::NamedTempFile::new().expect("创建临时 zip 失败");
            let cloned = file.reopen().expect("重新打开临时文件失败");
            let mut writer = zip::ZipWriter::new(cloned);
            build(&mut writer);
            writer.finish().expect("完成 zip 写入失败");
            file
        };

    for malicious in [
        "../escape.py",
        "cases/../../etc/cron.d/pwn",
        "sub\\..\\escape.py",
        "/etc/passwd",
        "\\Windows\\win.ini",
    ] {
        let zip_file = write_temp_zip(&|w| {
            w.start_file(malicious, zip::write::SimpleFileOptions::default())
                .unwrap();
            w.write_all(b"evil").unwrap();
        });
        assert!(
            extract_zip_entries_from_file(zip_file.path()).is_err(),
            "恶意路径 {:?} 必须被 zip 解压拒绝",
            malicious
        );
    }

    let symlink_zip = write_temp_zip(&|w| {
        w.add_symlink(
            "link.txt",
            "/etc/shadow",
            zip::write::SimpleFileOptions::default(),
        )
        .unwrap();
    });
    let err = extract_zip_entries_from_file(symlink_zip.path()).unwrap_err();
    assert!(
        err.to_string().contains("符号链接"),
        "symlink 条目应被明确拒绝，实际: {}",
        err
    );

    let safe_zip = write_temp_zip(&|w| {
        w.start_file("evaluate.py", zip::write::SimpleFileOptions::default())
            .unwrap();
        w.write_all(b"print('ok')").unwrap();
    });
    let entries = extract_zip_entries_from_file(safe_zip.path()).unwrap();
    assert_eq!(entries.len(), 1);
    assert_eq!(entries[0].file_name, "evaluate.py");
}
