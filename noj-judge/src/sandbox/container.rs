use std::io::Read;
use std::path::{Path, PathBuf};
use std::time::Duration;

use anyhow::{Context, Result};
use base64::Engine;
use bollard::container::LogOutput;
use bollard::models::ContainerCreateBody;
use bollard::models::HostConfig;
use bollard::Docker;
use futures_util::StreamExt;
use tokio::fs;
use tracing::{error, info, warn};

use crate::types::JudgeTask;

/// 解压炸弹防护：最大条目数。
const MAX_ZIP_ENTRIES: usize = 1000;
/// 解压炸弹防护：单文件最大大小（64MB）。
const MAX_FILE_SIZE: u64 = 64 * 1024 * 1024;
/// 解压炸弹防护：总解压大小（512MB）。
const MAX_TOTAL_SIZE: u64 = 512 * 1024 * 1024;

/// 同步解压 zip 内容到目标目录。
///
/// 使用 std::fs 同步写入以避免 tokio async fs 在特定环境下可能出现的缓冲问题。
fn extract_zip_sync(data: &[u8], target_dir: &Path) -> Result<()> {
    let cursor = std::io::Cursor::new(data);
    let mut archive = zip::ZipArchive::new(cursor).context("打开 zip 文件失败")?;

    let mut seen_paths = std::collections::HashSet::new();

    // 解压炸弹防护：最多条目数
    if archive.len() > MAX_ZIP_ENTRIES {
        anyhow::bail!("zip 条目数 {} 超过上限 {}", archive.len(), MAX_ZIP_ENTRIES);
    }

    let mut total_extracted: u64 = 0;

    for i in 0..archive.len() {
        let mut file = archive.by_index(i).context("读取 zip 条目失败")?;
        let file_name = file.name().to_string();

        // 防止 path traversal 攻击：拒绝任何含 .. 路径组件的条目
        if file_name.split(['/', '\\']).any(|part| part == "..") {
            warn!("跳过 zip 路径遍历: {}", file_name);
            continue;
        }

        // 拒绝 overlapping entries（同名路径出现两次）
        if !seen_paths.insert(file_name.clone()) {
            anyhow::bail!("zip 包含重复条目: {}", file_name);
        }

        let out_path = target_dir.join(&file_name);

        if file.is_dir() {
            std::fs::create_dir_all(&out_path)
                .with_context(|| format!("创建目录失败: {}", out_path.display()))?;
        } else {
            if let Some(parent) = out_path.parent() {
                std::fs::create_dir_all(parent)
                    .with_context(|| format!("创建父目录失败: {}", parent.display()))?;
            }

            // 单文件大小限制
            if file.size() > MAX_FILE_SIZE {
                anyhow::bail!(
                    "zip 条目 '{}' 大小 {} 超过单文件上限 {}",
                    file_name, file.size(), MAX_FILE_SIZE
                );
            }

            let mut buf = Vec::new();
            file.read_to_end(&mut buf)?;

            // 总解压大小限制
            total_extracted += buf.len() as u64;
            if total_extracted > MAX_TOTAL_SIZE {
                anyhow::bail!(
                    "zip 总解压大小 {} 超过上限 {}",
                    total_extracted, MAX_TOTAL_SIZE
                );
            }

            std::fs::write(&out_path, &buf)
                .with_context(|| format!("写入文件失败: {}", out_path.display()))?;
        }
    }

    Ok(())
}

/// 容器执行输出
#[derive(Debug, Clone)]
pub struct ContainerOutput {
    pub stdout: String,
    pub stderr: String,
    pub exit_code: i64,
}

/// 准备临时工作目录。
///
/// 在 work_dir 下创建 `{submission_id}` 目录。
pub async fn prepare_work_dir(work_dir: &Path, submission_id: &str) -> Result<PathBuf> {
    let dir = work_dir.join(submission_id);
    fs::create_dir_all(&dir)
        .await
        .with_context(|| format!("创建临时目录失败: {}", dir.display()))?;
    Ok(dir)
}

/// 获取支持包内容（Base64 解码）。
///
/// Base64 解码是纯 CPU 操作，无需 async。
pub fn get_support_package_bytes(task: &JudgeTask) -> Result<Option<Vec<u8>>> {
    match &task.support_package_base64 {
        Some(base64_str) if !base64_str.is_empty() => {
            let bytes = base64::engine::general_purpose::STANDARD
                .decode(base64_str)
                .context("Base64 解码支持包失败")?;
            Ok(Some(bytes))
        }
        _ => Ok(None),
    }
}

/// 解压支持包到目标目录。
///
/// 使用 spawn_blocking 将同步解压操作移出 async 上下文，
/// 避免 zip crate 在 tokio runtime 下可能出现的数据读取问题。
pub async fn extract_zip(data: &[u8], target_dir: &Path) -> Result<()> {
    let data = data.to_vec();
    let target_dir = target_dir.to_path_buf();
    tokio::task::spawn_blocking(move || extract_zip_sync(&data, &target_dir))
        .await
        .context("解压线程阻塞失败")??;
    Ok(())
}

/// 写入用户代码到工作目录。
///
/// 验证 file_name 安全性：拒绝含路径分隔符或 `..` 的文件名，防止路径逃逸。
pub async fn write_user_code(work_dir: &Path, task: &JudgeTask) -> Result<()> {
    let file_name = task.file_name.as_deref().unwrap_or("main.py");

    // 安全校验：仅允许单级文件名，拒绝路径遍历
    if file_name.contains('/') || file_name.contains('\\') || file_name.contains("..") {
        anyhow::bail!("非法的 file_name（含路径分隔符或 ..）: {}", file_name);
    }

    let code_path = work_dir.join(file_name);
    fs::write(&code_path, &task.code)
        .await
        .with_context(|| format!("写入用户代码失败: {}", code_path.display()))?;
    Ok(())
}

/// 在 Docker 沙箱中执行评测命令。
///
/// 完整流程：
/// 1. 准备临时目录
/// 2. 获取并解压支持包
/// 3. 写入用户代码
/// 4. 创建并启动 Docker 容器
/// 5. 等待容器退出（带超时）
/// 6. 捕获 stdout/stderr
/// 7. 清理临时目录
pub async fn run_in_container(
    docker: &Docker,
    task: &JudgeTask,
    work_dir_root: &Path,
) -> Result<ContainerOutput> {
    let submission_id = &task.submission_id;
    let work_dir = prepare_work_dir(work_dir_root, submission_id).await?;

    // 1. 获取并解压支持包
    if let Some(zip_data) = get_support_package_bytes(task)? {
        extract_zip(&zip_data, &work_dir).await?;
        info!("支持包已解压: {} ({} bytes)", submission_id, zip_data.len());
    } else {
        info!("无支持包，跳过解压: {}", submission_id);
    }

    // 2. 写入用户代码
    write_user_code(&work_dir, task).await?;
    info!("用户代码已写入: {}", submission_id);

    // 3. 确认本地镜像存在
    ensure_image_local(docker, &task.judge_image).await?;

    // 4. 创建并启动容器
    let container_name = format!("noj-judge-{}", submission_id);
    let host_config = HostConfig {
        binds: Some(vec![format!("{}:/tmp", work_dir.to_string_lossy())]),
        memory: Some(task.memory_limit_mb as i64 * 1024 * 1024),
        memory_swap: Some(task.memory_limit_mb as i64 * 1024 * 1024), // 禁用 swap
        nano_cpus: Some(1_000_000_000),                               // 1 CPU 核
        network_mode: Some("none".to_string()),
        auto_remove: Some(false), // 手动管理生命周期以捕获日志
        ..Default::default()
    };

    // 解析 judge_command → cmd 数组
    let cmd_parts: Vec<String> = parse_command(&task.judge_command);

    let config = ContainerCreateBody {
        image: Some(task.judge_image.clone()),
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
        .start_container(&container.id, None::<bollard::query_parameters::StartContainerOptions>)
        .await
        .with_context(|| format!("启动容器失败: {}", container_name))?;

    info!(
        "容器已启动: {} ({})",
        container_name,
        &container.id[..12.min(container.id.len())]
    );

    // 5. 等待容器退出（timeout = time_limit_ms + 5s 余量）
    // 使用轮询 inspect_container 替代 wait_container，
    // 避免 bollard 0.18 与 Docker API 1.54+ 的 wait 端点兼容性问题
    let timeout = Duration::from_millis(task.time_limit_ms + 5000);
    let poll_interval = Duration::from_millis(200);
    let wait_result = tokio::time::timeout(timeout, async {
        loop {
            let info = docker
                .inspect_container(&container.id, None::<bollard::query_parameters::InspectContainerOptions>)
                .await
                .with_context(|| format!("检查容器状态失败: {}", container_name))?;

            let running = info.state.as_ref().and_then(|s| s.running).unwrap_or(false);

            if !running {
                let exit_code = info.state.as_ref().and_then(|s| s.exit_code).unwrap_or(-1);
                return Ok(exit_code);
            }

            tokio::time::sleep(poll_interval).await;
        }
    })
    .await;

    let exit_code = match wait_result {
        Ok(Ok(code)) => {
            info!("容器正常退出: {} (exit: {})", container_name, code);
            code
        }
        Ok(Err(e)) => {
            let _ = docker
                .remove_container(
                    &container.id,
                    Some(bollard::query_parameters::RemoveContainerOptions {
                        force: true,
                        ..Default::default()
                    }),
                )
                .await;
            let _ = fs::remove_dir_all(&work_dir).await;
            return Err(e);
        }
        Err(_elapsed) => {
            // 超时，强制 kill
            warn!("容器超时: {}", container_name);
            let _ = docker
                .kill_container(&container.id, None::<bollard::query_parameters::KillContainerOptions>)
                .await;
            let output = capture_container_logs(docker, &container.id, -1).await;
            let _ = fs::remove_dir_all(&work_dir).await;
            return Ok(ContainerOutput {
                stdout: output.stdout,
                stderr: output.stderr,
                exit_code: -1, // 超时代码
            });
        }
    };

    // 6. 捕获日志（传入实际的退出码）
    let output = capture_container_logs(docker, &container.id, exit_code).await;

    // 清理容器
    let _ = docker
        .remove_container(
            &container.id,
            Some(bollard::query_parameters::RemoveContainerOptions {
                force: true,
                ..Default::default()
            }),
        )
        .await;

    // 7. 清理临时目录
    let _ = fs::remove_dir_all(&work_dir).await;

    Ok(output)
}

/// 确认 Docker 镜像在本地存在。
///
/// noj-judge 使用本地构建的评测镜像（如 `noj-judge-python`），
/// 这些镜像通过 `docker build` 提前构建好，不从远程拉取。
/// 如果镜像不存在，返回错误并提示构建命令。
async fn ensure_image_local(docker: &Docker, image: &str) -> Result<()> {
    let images = docker
        .list_images(None::<bollard::query_parameters::ListImagesOptions>)
        .await
        .context("列出 Docker 镜像失败")?;

    let exists = images.iter().any(|i| {
        i.repo_tags
            .iter()
            .any(|tag| tag == image || tag.starts_with(&format!("{}:", image)))
    });

    if exists {
        return Ok(());
    }

    Err(anyhow::anyhow!(
        "Docker 镜像 '{}' 未在本地找到。请先构建：docker build -t {} -f noj-judge/docker/{}/Dockerfile .",
        image,
        image,
        image.strip_prefix("noj-judge-").unwrap_or(image)
    ))
}

/// 捕获容器 stdout 和 stderr。
///
/// `exit_code` 由调用方传入（来自容器 wait 结果或超时标记），
/// 本函数仅负责日志捕获，不负责确定退出码。
async fn capture_container_logs(
    docker: &Docker,
    container_id: &str,
    exit_code: i64,
) -> ContainerOutput {
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
                error!("读取容器日志失败: {}", e);
                break;
            }
        }
    }

    ContainerOutput {
        stdout,
        stderr,
        exit_code,
    }
}

/// 解析评测命令为字符串数组。
///
/// 简单 shell 风格分词，支持单引号和双引号。
pub fn parse_command(command: &str) -> Vec<String> {
    let mut args = Vec::new();
    let mut current = String::new();
    let mut in_quote = false;
    let mut quote_char = ' ';

    for c in command.chars() {
        match c {
            '\'' | '"' if !in_quote => {
                in_quote = true;
                quote_char = c;
            }
            '\'' | '"' if in_quote && c == quote_char => {
                in_quote = false;
            }
            ' ' if !in_quote => {
                if !current.is_empty() {
                    args.push(std::mem::take(&mut current));
                }
            }
            _ => {
                current.push(c);
            }
        }
    }

    if !current.is_empty() {
        args.push(current);
    }

    args
}

#[cfg(test)]
mod tests {
    use super::*;

    // ── parse_command ──

    #[test]
    fn test_parse_command_simple() {
        assert_eq!(
            parse_command("python3 /tmp/evaluate.py"),
            vec!["python3", "/tmp/evaluate.py"]
        );
    }

    #[test]
    fn test_parse_command_with_quotes() {
        assert_eq!(
            parse_command("deno run --allow-read 'script.ts'"),
            vec!["deno", "run", "--allow-read", "script.ts"]
        );
    }

    #[test]
    fn test_parse_command_multi_word_quoted() {
        assert_eq!(
            parse_command("echo 'hello world' \"second arg\""),
            vec!["echo", "hello world", "second arg"]
        );
    }

    #[test]
    fn test_parse_command_single_arg() {
        assert_eq!(parse_command("python3"), vec!["python3"]);
    }

    #[test]
    fn test_parse_command_empty() {
        let result: Vec<String> = parse_command("");
        assert!(result.is_empty());
    }

    #[test]
    fn test_parse_command_extra_spaces() {
        assert_eq!(
            parse_command("  python3   /tmp/evaluate.py  "),
            vec!["python3", "/tmp/evaluate.py"]
        );
    }

    #[test]
    fn test_parse_command_nested_quotes() {
        // 嵌套引号：外层双引号保留内层单引号
        assert_eq!(
            parse_command("sh -c \"echo 'hello'\""),
            vec!["sh", "-c", "echo 'hello'"]
        );
    }

    // ── extract_zip ──

    use std::io::Write;

    fn create_test_zip() -> Vec<u8> {
        let mut buf = std::io::Cursor::new(Vec::new());
        let mut zip = zip::ZipWriter::new(&mut buf);
        let options = zip::write::FileOptions::<()>::default()
            .compression_method(zip::CompressionMethod::Stored);
        zip.start_file("hello.txt", options).unwrap();
        zip.write_all(b"world").unwrap();
        zip.start_file("sub/file.txt", options).unwrap();
        zip.write_all(b"nested").unwrap();
        zip.finish().unwrap();
        buf.into_inner()
    }

    #[test]
    fn test_extract_zip_basic() {
        let data = create_test_zip();
        let target = tempfile::tempdir().unwrap();
        let target_path = target.path().to_path_buf();
        let rt = tokio::runtime::Runtime::new().unwrap();
        rt.block_on(async {
            extract_zip(&data, &target_path).await.unwrap();
        });
        assert_eq!(
            std::fs::read_to_string(target_path.join("hello.txt")).unwrap(),
            "world"
        );
        assert_eq!(
            std::fs::read_to_string(target_path.join("sub/file.txt")).unwrap(),
            "nested"
        );
    }

    #[test]
    fn test_extract_zip_path_traversal_prevented() {
        // 创建一个 zip，其中一个条目试图通过 ../ 逃逸
        let mut buf = std::io::Cursor::new(Vec::new());
        {
            let mut zip = zip::ZipWriter::new(&mut buf);
            let options = zip::write::FileOptions::<()>::default()
                .compression_method(zip::CompressionMethod::Stored);
            // 正常条目
            zip.start_file("ok.txt", options).unwrap();
            zip.write_all(b"good").unwrap();
            // path traversal 条目
            zip.start_file("../evil_outside.txt", options).unwrap();
            zip.write_all(b"bad").unwrap();
            zip.finish().unwrap();
        }

        let target = tempfile::tempdir().unwrap();
        let target_path = target.path().to_path_buf();

        // 记录目标目录下的文件列表
        let before: Vec<_> = std::fs::read_dir(&target_path)
            .unwrap()
            .filter_map(|e| e.ok())
            .map(|e| e.file_name())
            .collect();
        // 确保目录确实是空的
        assert!(before.is_empty(), "目标目录应初始为空");

        let rt = tokio::runtime::Runtime::new().unwrap();
        rt.block_on(async {
            extract_zip(&buf.into_inner(), &target_path).await.unwrap();
        });

        // 正常条目放到了目标目录内
        assert!(target_path.join("ok.txt").exists());

        // Path traversal 文件不应出现在目标目录内
        assert!(!target_path.join("evil_outside.txt").exists());
        // 正常条目之外不应有多余文件（确认 traversal 被拦截）
        let after: Vec<_> = std::fs::read_dir(&target_path)
            .unwrap()
            .filter_map(|e| e.ok())
            .map(|e| e.file_name())
            .collect();
        assert_eq!(after.len(), 1, "目标目录应只有 ok.txt");
        assert_eq!(after[0], "ok.txt");
    }

    // ── get_support_package_bytes ──

    #[test]
    fn test_get_support_package_bytes_base64() {
        let data = b"hello zip content";
        let encoded = base64::engine::general_purpose::STANDARD.encode(data);
        let task = JudgeTask {
            submission_id: "test".to_string(),
            problem_id: "1001".to_string(),
            judge_image: "img".to_string(),
            judge_command: "cmd".to_string(),
            support_package_base64: Some(encoded),
            language: "python3".to_string(),
            code: "".to_string(),
            file_name: None,
            time_limit_ms: 1000,
            memory_limit_mb: 128,
        };

        let result = get_support_package_bytes(&task).unwrap();
        assert_eq!(result, Some(data.to_vec()));
    }

    #[test]
    fn test_get_support_package_bytes_none() {
        let task = JudgeTask {
            submission_id: "test".to_string(),
            problem_id: "1001".to_string(),
            judge_image: "img".to_string(),
            judge_command: "cmd".to_string(),
            support_package_base64: None,
            language: "python3".to_string(),
            code: "".to_string(),
            file_name: None,
            time_limit_ms: 1000,
            memory_limit_mb: 128,
        };

        let result = get_support_package_bytes(&task).unwrap();
        assert!(result.is_none());
    }

    #[test]
    fn test_get_support_package_bytes_empty_string() {
        let task = JudgeTask {
            submission_id: "test".to_string(),
            problem_id: "1001".to_string(),
            judge_image: "img".to_string(),
            judge_command: "cmd".to_string(),
            support_package_base64: Some(String::new()),
            language: "python3".to_string(),
            code: "".to_string(),
            file_name: None,
            time_limit_ms: 1000,
            memory_limit_mb: 128,
        };

        let result = get_support_package_bytes(&task).unwrap();
        assert!(result.is_none());
    }
}
