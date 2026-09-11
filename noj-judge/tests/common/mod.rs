//! noj-judge E2E 集成测试辅助模块。
//!
//! 提供 Docker 容器管理、测试门控、镜像管理等通用工具函数。
//! 被各个测试文件通过 `mod common; use common::*;` 导入。

use std::path::PathBuf;
use std::time::Duration;

use anyhow::{Context, Result};
use bollard::container::LogOutput;
use bollard::models::ContainerCreateBody;
use bollard::models::HostConfig;
use bollard::Docker;
use futures_util::StreamExt;

/// 容器执行输出
#[derive(Debug, Clone)]
#[allow(dead_code)]
pub struct ContainerOutput {
    pub stdout: String,
    pub stderr: String,
    pub exit_code: i64,
}

/// 检查 E2E 测试是否启用（环境变量 NOJ_RUN_E2E=1）
pub fn is_e2e_enabled() -> bool {
    std::env::var("NOJ_RUN_E2E").as_deref() == Ok("1")
}

/// 获取 Docker 连接
pub fn get_docker() -> Result<Docker> {
    Docker::connect_with_local_defaults().context("连接 Docker daemon 失败")
}

/// 确保测试用 Docker 镜像存在。
///
/// 先检查本地是否已有 `noj-judge-test-runner` 镜像，
/// 不存在则通过 `docker build` 命令从 Dockerfile 构建。
#[allow(dead_code)] // 仅部分 E2E test binary 引用
pub async fn ensure_test_image(docker: &Docker) -> Result<()> {
    let image_name = "noj-judge-test-runner:latest";

    // 检查本地镜像
    let images = docker
        .list_images(None::<bollard::query_parameters::ListImagesOptions>)
        .await
        .context("列出 Docker 镜像失败")?;

    let exists = images.iter().any(|i| {
        i.repo_tags
            .iter()
            .any(|tag| tag == image_name || tag == "noj-judge-test-runner")
    });

    if exists {
        return Ok(());
    }

    // 通过子进程构建镜像（bollard 的 tar 构建在测试环境中不够可靠）
    println!("测试镜像 {} 不存在，开始构建...", image_name);

    let dockerfile_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/e2e");
    if !dockerfile_dir.join("Dockerfile.test-runner").exists() {
        anyhow::bail!(
            "Dockerfile 不存在: {}",
            dockerfile_dir.join("Dockerfile.test-runner").display()
        );
    }

    let status = std::process::Command::new("docker")
        .args([
            "build",
            "-t",
            image_name,
            "-f",
            "Dockerfile.test-runner",
            ".",
        ])
        .current_dir(&dockerfile_dir)
        .status()
        .context("执行 docker build 失败")?;

    if !status.success() {
        anyhow::bail!("docker build 失败 (exit: {:?})", status.code());
    }

    println!("测试镜像构建完成: {}", image_name);
    Ok(())
}

/// 创建测试用容器。
///
/// 返回 (container_id, work_dir_path)。
#[allow(dead_code)]
pub async fn create_test_container(
    docker: &Docker,
    image: &str,
    cmd: &[&str],
    memory_limit_mb: u64,
    _timeout_ms: u64,
) -> Result<(String, PathBuf)> {
    // 创建临时工作目录
    let work_dir = std::env::temp_dir().join(format!("noj-judge-test-{}", uuid::Uuid::new_v4()));
    tokio::fs::create_dir_all(&work_dir)
        .await
        .with_context(|| format!("创建临时目录失败: {}", work_dir.display()))?;

    let container_name = format!("noj-test-{}", uuid::Uuid::new_v4());

    let cmd_parts: Vec<String> = cmd.iter().map(|s| s.to_string()).collect();

    let host_config = HostConfig {
        binds: Some(vec![format!("{}:/tmp", work_dir.to_string_lossy())]),
        memory: Some(memory_limit_mb as i64 * 1024 * 1024),
        memory_swap: Some(memory_limit_mb as i64 * 1024 * 1024),
        nano_cpus: Some(1_000_000_000),
        network_mode: Some("none".to_string()),
        cap_drop: Some(vec!["ALL".to_string()]),
        readonly_rootfs: Some(true),
        security_opt: Some(vec!["no-new-privileges:true".to_string()]),
        auto_remove: Some(false),
        ..Default::default()
    };

    let config = ContainerCreateBody {
        image: Some(image.to_string()),
        cmd: Some(cmd_parts),
        host_config: Some(host_config),
        ..Default::default()
    };

    let container = docker
        .create_container(
            Some(bollard::query_parameters::CreateContainerOptions {
                name: Some(container_name.clone()),
                platform: String::new(),
            }),
            config,
        )
        .await
        .with_context(|| format!("创建容器失败: {}", container_name))?;

    docker
        .start_container(
            &container.id,
            None::<bollard::query_parameters::StartContainerOptions>,
        )
        .await
        .with_context(|| format!("启动容器失败: {}", container_name))?;

    Ok((container.id, work_dir))
}

/// 等待容器执行完成并返回输出。
///
/// 内部包含 30s 全局超时，调用方无需额外包装 timeout。
#[allow(dead_code)]
pub async fn wait_container(
    docker: &Docker,
    container_id: &str,
    poll_interval_ms: u64,
) -> Result<ContainerOutput> {
    let result = tokio::time::timeout(
        std::time::Duration::from_secs(30),
        wait_container_inner(docker, container_id, poll_interval_ms),
    )
    .await
    .map_err(|_| anyhow::anyhow!("容器执行超时（全局 30s）"))?
    .map_err(|e| anyhow::anyhow!("等待容器失败: {}", e))?;
    Ok(result)
}

/// 内部实现（不含外层 timeout，供 wait_container 使用）。
async fn wait_container_inner(
    docker: &Docker,
    container_id: &str,
    timeout_ms: u64,
) -> Result<ContainerOutput> {
    let timeout = Duration::from_millis(timeout_ms + 5000);

    let wait_result = tokio::time::timeout(timeout, async {
        let mut stream = docker.wait_container(
            container_id,
            Some(bollard::query_parameters::WaitContainerOptions {
                condition: "not-running".to_string(),
            }),
        );
        match stream.next().await {
            Some(Ok(output)) => Some(output.status_code),
            Some(Err(e)) => {
                // 部分 Docker 版本下 wait stream 对 OOM/non-zero 退出返回错误，
                // 回退到 inspect_container 读取退出码
                eprintln!("wait_container stream 错误，回退到 inspect: {}", e);
                None
            }
            None => None,
        }
    })
    .await;

    let exit_code = match wait_result {
        Ok(Some(code)) => code,
        Ok(None) => {
            // wait stream 失败，回退到 inspect_container
            match docker
                .inspect_container(
                    container_id,
                    None::<bollard::query_parameters::InspectContainerOptions>,
                )
                .await
            {
                Ok(info) => info.state.and_then(|s| s.exit_code).unwrap_or(-1),
                Err(e) => {
                    let _ = docker
                        .remove_container(
                            container_id,
                            Some(bollard::query_parameters::RemoveContainerOptions {
                                force: true,
                                ..Default::default()
                            }),
                        )
                        .await;
                    return Err(anyhow::anyhow!("等待容器失败（inspect 也失败）: {}", e));
                }
            }
        }
        Err(_elapsed) => {
            let _ = docker
                .kill_container(
                    container_id,
                    None::<bollard::query_parameters::KillContainerOptions>,
                )
                .await;
            let output = capture_logs(docker, container_id).await;
            return Ok(ContainerOutput {
                stdout: output.stdout,
                stderr: output.stderr,
                exit_code: -1,
            });
        }
    };

    let output = capture_logs(docker, container_id).await;

    let _ = docker
        .remove_container(
            container_id,
            Some(bollard::query_parameters::RemoveContainerOptions {
                force: true,
                ..Default::default()
            }),
        )
        .await;

    Ok(ContainerOutput {
        stdout: output.stdout,
        stderr: output.stderr,
        exit_code,
    })
}

/// 捕获容器日志。
#[allow(dead_code)]
async fn capture_logs(docker: &Docker, container_id: &str) -> ContainerOutput {
    let options = bollard::query_parameters::LogsOptions {
        stdout: true,
        stderr: true,
        ..Default::default()
    };

    let mut stdout = String::new();
    let mut stderr = String::new();

    let mut stream = docker.logs(container_id, Some(options));
    while let Some(item) = stream.next().await {
        match item {
            Ok(output) => match output {
                LogOutput::StdOut { message } => {
                    stdout.push_str(&String::from_utf8_lossy(&message));
                }
                LogOutput::StdErr { message } => {
                    stderr.push_str(&String::from_utf8_lossy(&message));
                }
                _ => {}
            },
            Err(e) => {
                eprintln!("读取容器日志失败: {}", e);
                break;
            }
        }
    }

    ContainerOutput {
        stdout,
        stderr,
        exit_code: 0,
    }
}

/// 创建 E2E 测试（自动处理 is_e2e_enabled 守卫 + 序列化执行）。
///
/// 宏只处理守卫和测试属性，测试体需自行声明 docker：
///
/// ```ignore
/// e2e_test!(#[ignore] test_name, async {
///     let docker = common::get_docker().expect("连接 Docker 失败");
///     common::ensure_test_image(&docker).await.expect("确保测试镜像失败");
///     // ... 测试逻辑
/// });
/// ```
#[macro_export]
macro_rules! e2e_test {
    ($name:ident, async $body:block) => {
        #[::serial_test::serial]
        #[tokio::test]
        async fn $name() {
            if !$crate::common::is_e2e_enabled() {
                return;
            }
            $body
        }
    };
    (#[ignore] $name:ident, async $body:block) => {
        #[ignore]
        #[::serial_test::serial]
        #[tokio::test]
        async fn $name() {
            if !$crate::common::is_e2e_enabled() {
                return;
            }
            $body
        }
    };
}

/// 确保带 SDK 的评测镜像存在（不存在则用仓库 Dockerfile 构建）。
///
/// 镜像内置 noj_evaluator_sdk / noj_solution_sdk 到 site-packages，
/// 供真实 SDK 全链路测试使用（evaluate_dual 的 solution 启动命令
/// 硬编码 `python3 -m noj_solution_sdk.host`，镜像必须含 SDK）。
/// 仅部分 e2e_* 测试文件引用，未引用的 test binary 会报 dead_code。
///
/// # 陈旧镜像问题（本函数存在的理由）
///
/// 若「镜像已存在就直接跳过构建」，本地改了 SDK 源码后跑 E2E 会**静默验证旧镜像**，
/// 产生两种同样有害的后果：
/// - 源码有问题却因旧镜像正常而**假绿**；
/// - 源码已修好却因旧镜像仍有问题而**假红**（本项目实际踩过：
///   旧镜像里 SDK 文件权限为 600，非 root 的容器用户无法 import，
///   一次性打挂整个双容器 E2E 套件，且报错指向 Python 而非权限根因）。
///
/// 因此这里用**构建输入的内容哈希**判断是否需要重建：把 Dockerfile 与 SDK 源码的
/// 路径+内容哈希写入镜像 label，并与当前输入比对。内容哈希（而非 mtime）避免
/// 「git checkout 刷新 mtime」造成的无谓重建，也避免 mtime 精度问题。
#[allow(dead_code)]
pub async fn ensure_sdk_images(docker: &Docker) -> Result<()> {
    /// 记录构建输入哈希的镜像 label。
    const INPUTS_LABEL: &str = "com.noj.build-inputs-sha";

    for (tag, dockerfile, source_dirs) in [
        (
            "noj-e2e-sdk-evaluator:latest",
            "docker/evaluator-python/Dockerfile",
            ["sdk/common", "sdk/evaluator"].as_slice(),
        ),
        (
            "noj-e2e-sdk-solution:latest",
            "docker/solution-python/Dockerfile",
            ["sdk/common", "sdk/solution"].as_slice(),
        ),
    ] {
        let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
        let expected = build_inputs_sha(&root, dockerfile, source_dirs)?;

        // 读取现有镜像的输入哈希 label（镜像不存在或无 label 时为 None）
        let current: Option<String> = match docker.inspect_image(tag).await {
            Ok(info) => info
                .config
                .and_then(|cfg| cfg.labels)
                .and_then(|labels| labels.get(INPUTS_LABEL).cloned()),
            Err(_) => None,
        };

        if current.as_deref() == Some(expected.as_str()) {
            continue;
        }

        match &current {
            None => println!("构建 SDK 测试镜像 {} ...", tag),
            Some(_) => println!("SDK 源码或 Dockerfile 已变更，重建测试镜像 {} ...", tag),
        }

        let status = std::process::Command::new("docker")
            .args([
                "build",
                "-t",
                tag,
                "-f",
                dockerfile,
                "--label",
                &format!("{INPUTS_LABEL}={expected}"),
                ".",
            ])
            // buildx 在部分环境写 activity 文件失败（只读 HOME），退回 legacy builder
            .env("DOCKER_BUILDKIT", "0")
            .current_dir(&root)
            .status()
            .context("执行 docker build 失败")?;
        if !status.success() {
            anyhow::bail!("docker build 失败: {}", tag);
        }
    }
    Ok(())
}

/// 计算 SDK 测试镜像构建输入的 SHA-256（Dockerfile + SDK 源码目录下全部文件）。
///
/// 输入按**相对路径排序**后依次喂入「路径 + NUL + 内容 + NUL」，
/// 保证结果与文件系统遍历顺序无关、且路径变化也能被检出。
///
/// 未纳入计算的文件与被忽略的文件（见下）不会触发重建——这是有意的：
/// 只有真正参与镜像构建的内容才算输入。
#[allow(dead_code)]
fn build_inputs_sha(
    root: &std::path::Path,
    dockerfile: &str,
    source_dirs: &[&str],
) -> Result<String> {
    use sha2::{Digest, Sha256};

    let mut files: Vec<PathBuf> = vec![root.join(dockerfile)];
    for dir in source_dirs {
        collect_files(&root.join(dir), &mut files)?;
    }
    // 跳过 Python 字节码缓存：它们不参与镜像内容（镜像内 PYTHONDONTWRITEBYTECODE=1），
    // 且本地运行时会被随意重建，纳入哈希会导致每次都不必要的重建。
    files.retain(|p| !p.components().any(|c| c.as_os_str() == "__pycache__"));

    let mut rel: Vec<(String, PathBuf)> = files
        .into_iter()
        .map(|p| {
            let key = p
                .strip_prefix(root)
                .unwrap_or(&p)
                .to_string_lossy()
                .replace('\\', "/");
            (key, p)
        })
        .collect();
    rel.sort_by(|a, b| a.0.cmp(&b.0));

    let mut hasher = Sha256::new();
    for (key, path) in rel {
        hasher.update(key.as_bytes());
        hasher.update([0u8]);
        let bytes = std::fs::read(&path)
            .with_context(|| format!("读取构建输入失败: {}", path.display()))?;
        hasher.update(&bytes);
        hasher.update([0u8]);
    }
    Ok(format!("{:x}", hasher.finalize()))
}

/// 递归收集目录下的全部文件（跳过符号链接，避免循环）。
#[allow(dead_code)]
fn collect_files(dir: &std::path::Path, out: &mut Vec<PathBuf>) -> Result<()> {
    for entry in
        std::fs::read_dir(dir).with_context(|| format!("读取目录失败: {}", dir.display()))?
    {
        let entry = entry?;
        let path = entry.path();
        let file_type = entry.file_type()?;
        if file_type.is_dir() {
            collect_files(&path, out)?;
        } else if file_type.is_file() {
            out.push(path);
        }
    }
    Ok(())
}

#[cfg(test)]
mod build_inputs_tests {
    use super::*;

    /// 搭一个临时目录，内含 Dockerfile 与 SDK 源文件。
    fn setup() -> tempfile::TempDir {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        std::fs::create_dir_all(root.join("docker/x")).unwrap();
        std::fs::create_dir_all(root.join("sdk/common/pkg")).unwrap();
        std::fs::write(root.join("docker/x/Dockerfile"), "FROM scratch\n").unwrap();
        std::fs::write(root.join("sdk/common/pkg/a.py"), "A = 1\n").unwrap();
        dir
    }

    /// 相同内容 → 相同哈希（保证「无改动就跳过构建」成立）。
    #[test]
    fn hash_is_stable_for_unchanged_inputs() {
        let dir = setup();
        let root = dir.path();
        let a = build_inputs_sha(root, "docker/x/Dockerfile", &["sdk/common"]).unwrap();
        let b = build_inputs_sha(root, "docker/x/Dockerfile", &["sdk/common"]).unwrap();
        assert_eq!(a, b);
        assert_eq!(a.len(), 64, "SHA-256 十六进制长度");
    }

    /// 改源码内容 → 哈希变化（保证「改了就会重建」成立）。
    #[test]
    fn hash_changes_when_source_content_changes() {
        let dir = setup();
        let root = dir.path();
        let before = build_inputs_sha(root, "docker/x/Dockerfile", &["sdk/common"]).unwrap();
        std::fs::write(root.join("sdk/common/pkg/a.py"), "A = 2\n").unwrap();
        let after = build_inputs_sha(root, "docker/x/Dockerfile", &["sdk/common"]).unwrap();
        assert_ne!(before, after, "源码内容变化必须使哈希变化");
    }

    /// 改 Dockerfile → 哈希变化（镜像构建输入包含 Dockerfile）。
    #[test]
    fn hash_changes_when_dockerfile_changes() {
        let dir = setup();
        let root = dir.path();
        let before = build_inputs_sha(root, "docker/x/Dockerfile", &["sdk/common"]).unwrap();
        std::fs::write(root.join("docker/x/Dockerfile"), "FROM scratch\nRUN true\n").unwrap();
        let after = build_inputs_sha(root, "docker/x/Dockerfile", &["sdk/common"]).unwrap();
        assert_ne!(before, after);
    }

    /// 新增文件 → 哈希变化（新增模块也必须触发重建）。
    #[test]
    fn hash_changes_when_file_added() {
        let dir = setup();
        let root = dir.path();
        let before = build_inputs_sha(root, "docker/x/Dockerfile", &["sdk/common"]).unwrap();
        std::fs::write(root.join("sdk/common/pkg/b.py"), "B = 1\n").unwrap();
        let after = build_inputs_sha(root, "docker/x/Dockerfile", &["sdk/common"]).unwrap();
        assert_ne!(before, after);
    }

    /// `__pycache__` 不参与哈希：否则本地跑一次 Python 就会触发无谓重建。
    #[test]
    fn hash_ignores_pycache() {
        let dir = setup();
        let root = dir.path();
        let before = build_inputs_sha(root, "docker/x/Dockerfile", &["sdk/common"]).unwrap();
        std::fs::create_dir_all(root.join("sdk/common/pkg/__pycache__")).unwrap();
        std::fs::write(
            root.join("sdk/common/pkg/__pycache__/a.cpython-312.pyc"),
            b"\x00\x01",
        )
        .unwrap();
        let after = build_inputs_sha(root, "docker/x/Dockerfile", &["sdk/common"]).unwrap();
        assert_eq!(before, after, "__pycache__ 不应影响构建输入哈希");
    }

    /// 路径也参与哈希：仅重命名文件（内容不变）必须被视为变更。
    #[test]
    fn hash_detects_rename_with_same_content() {
        let dir = setup();
        let root = dir.path();
        let before = build_inputs_sha(root, "docker/x/Dockerfile", &["sdk/common"]).unwrap();
        std::fs::rename(
            root.join("sdk/common/pkg/a.py"),
            root.join("sdk/common/pkg/renamed.py"),
        )
        .unwrap();
        let after = build_inputs_sha(root, "docker/x/Dockerfile", &["sdk/common"]).unwrap();
        assert_ne!(before, after, "重命名应被检出（路径参与哈希）");
    }

    /// 真实仓库输入可被哈希（对实际 Dockerfile 与 sdk 目录的冒烟验证）。
    #[test]
    fn hash_works_on_real_repo_inputs() {
        let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
        let sha = build_inputs_sha(
            &root,
            "docker/evaluator-python/Dockerfile",
            &["sdk/common", "sdk/evaluator"],
        )
        .expect("真实仓库输入应可哈希");
        assert_eq!(sha.len(), 64);
    }
}
