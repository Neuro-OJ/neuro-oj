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

/// 记录构建输入哈希的镜像 label。
///
/// 用于判定「本地镜像是否由当前构建输入产出」。放在模块级是因为
/// `ensure_sdk_images` 与 `ensure_test_image` 共用同一约定。
const INPUTS_LABEL: &str = "com.noj.build-inputs-sha";

/// 镜像是否需要重建的判定（**纯函数，便于测试**）。
///
/// 这是陈旧判定的核心决策，抽出来单独测试的原因：判定逻辑若写死在
/// `ensure_*` 里，只能靠跑 Docker 才能覆盖，实践中就等于没有测试——
/// 而一个反向的判定（相等即重建 / 不等即跳过）会静默地把整套 E2E 变成
/// 「验证旧镜像」。
///
/// 语义（安全方向）：**无法证明镜像是最新的，就重建**。
/// - 无 label（None）→ 重建：镜像由他人构建、或早于本机制引入；
/// - label 与期望哈希不同 → 重建：构建输入已变；
/// - label 与期望哈希相同 → 跳过。
#[derive(Debug, PartialEq, Eq)]
pub enum ImageFreshness {
    /// 输入哈希一致，可复用现有镜像。
    UpToDate,
    /// 需要重建，附原因（用于日志，让「为什么重建」可见）。
    Rebuild(&'static str),
}

/// 依据「期望哈希」与「镜像上记录的哈希」判定是否需要重建。
#[allow(dead_code)]
pub fn decide_image_freshness(expected: &str, recorded: Option<&str>) -> ImageFreshness {
    match recorded {
        None => ImageFreshness::Rebuild("镜像无构建输入 label（他人构建或早于本机制）"),
        Some(got) if got == expected => ImageFreshness::UpToDate,
        Some(_) => ImageFreshness::Rebuild("构建输入已变更"),
    }
}

/// 读取镜像上记录的构建输入哈希（镜像不存在或无 label 时为 None）。
#[allow(dead_code)]
async fn recorded_inputs_sha(docker: &Docker, tag: &str) -> Option<String> {
    docker
        .inspect_image(tag)
        .await
        .ok()
        .and_then(|info| info.config)
        .and_then(|cfg| cfg.labels)
        .and_then(|labels| labels.get(INPUTS_LABEL).cloned())
}

/// 确保测试用 Docker 镜像存在**且不过期**。
///
/// 原实现只检查「tag 是否存在」：本地改了 `tests/e2e/evaluate.py` 或
/// `Dockerfile.test-runner` 后，E2E 仍会拿旧镜像跑并报绿——正是本轮要消灭的
/// 「静默验证旧镜像」失效模式。`ensure_sdk_images` 已改为按构建输入内容哈希判定，
/// 但该函数当时未一并修改，于是 8 个 E2E binary 中依赖它的 6 个仍有同样问题。
///
/// 现在与 `ensure_sdk_images` 同机制：把「Dockerfile + 构建上下文（tests/e2e）」
/// 的内容哈希写进镜像 label，判定不一致就重建。
#[allow(dead_code)] // 仅部分 E2E test binary 引用
pub async fn ensure_test_image(docker: &Docker) -> Result<()> {
    let image_name = "noj-judge-test-runner:latest";
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    // 构建上下文是 tests/e2e（docker build 在该目录下执行，见下方 current_dir）。
    // 除 Dockerfile 本身外，把整个上下文目录纳入哈希：evaluate.py 就在其中，
    // 而它正是最常被改动、也最容易被"陈旧镜像"掩盖的文件。
    let expected = build_inputs_sha(&root, "tests/e2e/Dockerfile.test-runner", &["tests/e2e"])?;

    let current = recorded_inputs_sha(docker, image_name).await;
    match decide_image_freshness(&expected, current.as_deref()) {
        ImageFreshness::UpToDate => {
            // 明确打印「已是最新」：否则「跳过了」与「没执行」在日志上无法区分。
            println!(
                "测试镜像 {} 已是最新（构建输入 {}…），跳过重建",
                image_name,
                &expected[..12]
            );
            return Ok(());
        }
        ImageFreshness::Rebuild(why) => {
            println!("重建测试镜像 {}（{}）...", image_name, why);
        }
    }

    let dockerfile_dir = root.join("tests/e2e");
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
            "--label",
            &format!("{INPUTS_LABEL}={expected}"),
            ".",
        ])
        .env("DOCKER_BUILDKIT", "0")
        .current_dir(&dockerfile_dir)
        .status()
        .context("执行 docker build 失败")?;

    if !status.success() {
        anyhow::bail!("docker build 失败 (exit: {:?})", status.code());
    }

    // 构建后复核 label 确实写进去了：若 docker 忽略了 --label（版本差异/被策略
    // 剥离），每轮都会「看起来重建成功」但下次判定仍为 None → 永久重建循环。
    // 与其静默循环，不如立刻报错。
    let after = recorded_inputs_sha(docker, image_name).await;
    if after.as_deref() != Some(expected.as_str()) {
        anyhow::bail!(
            "测试镜像构建完成但输入哈希 label 未生效（期望 {}，实际 {:?}）——\
             会导致每轮 E2E 都重复重建，请检查 docker 是否支持 --label",
            expected,
            after
        );
    }

    println!(
        "测试镜像构建完成: {}（输入 {}…）",
        image_name,
        &expected[..12]
    );
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
        let current = recorded_inputs_sha(docker, tag).await;

        match decide_image_freshness(&expected, current.as_deref()) {
            ImageFreshness::UpToDate => {
                // 明确打印「已是最新」：否则「跳过了」与「没执行」在日志上无法区分。
                println!(
                    "{} 已是最新（构建输入 {}…），跳过重建",
                    tag,
                    &expected[..12]
                );
                continue;
            }
            ImageFreshness::Rebuild(why) => {
                println!("重建 {}（{}）...", tag, why);
            }
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

        // 构建后复核 label 已生效（否则会静默退化为每轮重建）。
        let after = recorded_inputs_sha(docker, tag).await;
        if after.as_deref() != Some(expected.as_str()) {
            anyhow::bail!(
                "{} 构建完成但输入哈希 label 未生效（期望 {}，实际 {:?}）——\
                 会导致每轮 E2E 都重复重建，请检查 docker 是否支持 --label",
                tag,
                expected,
                after
            );
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
    // 跳过 Python 字节码缓存。
    //
    // 理由（评审订正，勿写成「镜像内没有 pycache」——那是错的）：镜像里**确实**有
    // pycache（构建期 `python3 -c "import ..."` 生成，外加从构建上下文复制进来的），
    // 实测 evaluator 镜像内有数百个 .pyc。但它的内容由源码决定、**不是构建输入**：
    // 本地每次 import/跑测试都会重建 `__pycache__`，纳入哈希会因这种与镜像无关的
    // 抖动导致每轮无谓重建。
    // 取舍是明确的：接受哈希漏掉一个派生文件，换掉永久重建抖动。若将来把
    // `__pycache__` 加进 .dockerignore、使镜像不再包含它，这个过滤才可以移除。
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

    /// **测试镜像的构建输入也可被哈希**（`ensure_test_image` 的判定依据）。
    ///
    /// 该函数此前只看 tag 是否存在，改 `tests/e2e/evaluate.py` 后 E2E 仍用旧镜像
    /// 跑并报绿。此用例保证其输入可被计算，且 `evaluate.py` 确实参与哈希
    /// （它是该上下文里最常被改动、最容易被陈旧镜像掩盖的文件）。
    #[test]
    fn test_image_inputs_are_hashable_and_cover_evaluate_py() {
        let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
        let before = build_inputs_sha(&root, "tests/e2e/Dockerfile.test-runner", &["tests/e2e"])
            .expect("测试镜像输入应可哈希");
        assert_eq!(before.len(), 64);

        // 复制真实输入到临时目录后改动 evaluate.py，哈希必须变化。
        let dir = tempfile::TempDir::new().unwrap();
        let staging = dir.path();
        copy_dir_all(&root.join("tests/e2e"), &staging.join("tests/e2e")).unwrap();
        let staged_before =
            build_inputs_sha(staging, "tests/e2e/Dockerfile.test-runner", &["tests/e2e"]).unwrap();
        let eval = staging.join("tests/e2e/evaluate.py");
        assert!(eval.exists(), "测试上下文应包含 evaluate.py");
        let mut body = std::fs::read_to_string(&eval).unwrap();
        body.push_str("\n# 评审回归：改动 evaluate.py 必须被检出\n");
        std::fs::write(&eval, body).unwrap();
        let staged_after =
            build_inputs_sha(staging, "tests/e2e/Dockerfile.test-runner", &["tests/e2e"]).unwrap();
        assert_ne!(
            staged_before, staged_after,
            "改动 evaluate.py 必须改变测试镜像的输入哈希（否则会静默验证旧镜像）"
        );
    }

    /// 递归复制目录（供上面把真实输入搬到临时目录）。
    fn copy_dir_all(src: &std::path::Path, dst: &std::path::Path) -> Result<()> {
        std::fs::create_dir_all(dst)?;
        for entry in std::fs::read_dir(src)? {
            let entry = entry?;
            let to = dst.join(entry.file_name());
            if entry.file_type()?.is_dir() {
                copy_dir_all(&entry.path(), &to)?;
            } else {
                std::fs::copy(entry.path(), to)?;
            }
        }
        Ok(())
    }
}

/// 陈旧判定（`decide_image_freshness`）的单元测试。
///
/// 这组用例针对评审指出的问题：**陈旧判定本身此前没有任何测试**——
/// 改掉判定分支或删掉 `--label` 都不会让任何用例失败，而一个写反的判定
/// 会静默把整套 E2E 变成「验证旧镜像」。
#[cfg(test)]
mod image_freshness_tests {
    use super::{decide_image_freshness, ImageFreshness};

    /// 无 label → 重建（安全方向：无法证明最新就重建）。
    #[test]
    fn missing_label_triggers_rebuild() {
        assert_eq!(
            decide_image_freshness("abc", None),
            ImageFreshness::Rebuild("镜像无构建输入 label（他人构建或早于本机制）")
        );
    }

    /// 哈希一致 → 跳过（不必要重建会显著拖慢 E2E）。
    #[test]
    fn matching_hash_is_up_to_date() {
        assert_eq!(
            decide_image_freshness("abc", Some("abc")),
            ImageFreshness::UpToDate
        );
    }

    /// 哈希不同 → 重建（这是本机制存在的理由）。
    #[test]
    fn differing_hash_triggers_rebuild() {
        assert_eq!(
            decide_image_freshness("abc", Some("def")),
            ImageFreshness::Rebuild("构建输入已变更")
        );
    }

    /// 边界：空字符串 label 不等于「无 label」，应判为变更而非缺失。
    #[test]
    fn empty_label_is_treated_as_changed_not_missing() {
        assert_eq!(
            decide_image_freshness("abc", Some("")),
            ImageFreshness::Rebuild("构建输入已变更")
        );
    }

    /// 判定必须是**对称且确定**的：同一输入反复求值结果一致
    /// （否则会出现「有时重建、有时跳过」的抖动）。
    #[test]
    fn decision_is_deterministic() {
        for _ in 0..3 {
            assert_eq!(
                decide_image_freshness("abc", Some("abc")),
                ImageFreshness::UpToDate
            );
            assert_eq!(
                decide_image_freshness("abc", Some("xyz")),
                ImageFreshness::Rebuild("构建输入已变更")
            );
        }
    }
}
