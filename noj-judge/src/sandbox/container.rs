use std::io::Read;
use std::path::{Path, PathBuf};
use std::time::Duration;

use anyhow::{Context, Result};
use base64::Engine;
use bollard::container::{
    Config, CreateContainerOptions, KillContainerOptions, LogsOptions, RemoveContainerOptions,
    StartContainerOptions, WaitContainerOptions,
};
use bollard::models::HostConfig;
use bollard::Docker;
use futures_util::StreamExt;
use tokio::fs;
use tokio::io::AsyncWriteExt;
use tracing::{error, info, warn};

use crate::types::JudgeTask;

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
async fn prepare_work_dir(work_dir: &Path, submission_id: &str) -> Result<PathBuf> {
    let dir = work_dir.join(submission_id);
    fs::create_dir_all(&dir)
        .await
        .with_context(|| format!("创建临时目录失败: {}", dir.display()))?;
    Ok(dir)
}

/// 获取支持包内容（Base64 解码）。
async fn get_support_package_bytes(task: &JudgeTask) -> Result<Option<Vec<u8>>> {
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
async fn extract_zip(data: &[u8], target_dir: &Path) -> Result<()> {
    let cursor = std::io::Cursor::new(data);
    let mut archive = zip::ZipArchive::new(cursor).context("打开 zip 文件失败")?;

    let mut entries: Vec<(bool, String, Vec<u8>)> = Vec::new();
    for i in 0..archive.len() {
        let mut file = archive.by_index(i).context("读取 zip 条目失败")?;
        let file_name = file.name().to_string();

        // 防止 path traversal 攻击
        let out_path = target_dir.join(&file_name);
        if !out_path.starts_with(target_dir) {
            warn!("跳过 zip 路径遍历: {}", file_name);
            continue;
        }

        let is_dir = file.is_dir();
        let mut buf = Vec::new();
        file.read_to_end(&mut buf)?;
        // file 在此 drop，释放对 archive 的借用
        entries.push((is_dir, file_name, buf));
    }

    for (is_dir, file_name, buf) in entries {
        let out_path = target_dir.join(&file_name);
        if is_dir {
            fs::create_dir_all(&out_path).await?;
        } else {
            if let Some(parent) = out_path.parent() {
                fs::create_dir_all(parent).await?;
            }
            let mut writer = fs::File::create(&out_path).await?;
            writer.write_all(&buf).await?;
        }
    }

    Ok(())
}

/// 写入用户代码到工作目录。
async fn write_user_code(work_dir: &Path, task: &JudgeTask) -> Result<()> {
    let file_name = task.file_name.as_deref().unwrap_or("main.py");
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
    if let Some(zip_data) = get_support_package_bytes(task).await? {
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

    let config = Config {
        image: Some(task.judge_image.clone()),
        cmd: Some(cmd_parts),
        host_config: Some(host_config),
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
        .await
        .with_context(|| format!("创建容器失败: {}", container_name))?;

    docker
        .start_container(&container.id, None::<StartContainerOptions<String>>)
        .await
        .with_context(|| format!("启动容器失败: {}", container_name))?;

    info!(
        "容器已启动: {} ({})",
        container_name,
        &container.id[..12.min(container.id.len())]
    );

    // 5. 等待容器退出（timeout = time_limit_ms + 5s 余量）
    let timeout = Duration::from_millis(task.time_limit_ms + 5000);
    let wait_result = tokio::time::timeout(timeout, async {
        let mut stream = docker.wait_container(
            &container.id,
            Some(WaitContainerOptions {
                condition: "not-running",
            }),
        );
        while let Some(item) = stream.next().await {
            match item {
                Ok(output) => return Ok(output.status_code),
                Err(e) => return Err(anyhow::anyhow!("等待容器失败: {}", e)),
            }
        }
        Err(anyhow::anyhow!("容器退出流提前结束"))
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
                    Some(RemoveContainerOptions {
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
                .kill_container(&container.id, None::<KillContainerOptions<String>>)
                .await;
            let output = capture_container_logs(docker, &container.id).await;
            let _ = fs::remove_dir_all(&work_dir).await;
            return Ok(ContainerOutput {
                stdout: output.stdout,
                stderr: output.stderr,
                exit_code: -1, // 超时代码
            });
        }
    };

    // 6. 捕获日志
    let output = capture_container_logs(docker, &container.id).await;

    // 清理容器
    let _ = docker
        .remove_container(
            &container.id,
            Some(RemoveContainerOptions {
                force: true,
                ..Default::default()
            }),
        )
        .await;

    // 7. 清理临时目录
    let _ = fs::remove_dir_all(&work_dir).await;

    Ok(ContainerOutput {
        stdout: output.stdout,
        stderr: output.stderr,
        exit_code,
    })
}

/// 确认 Docker 镜像在本地存在。
///
/// noj-judge 使用本地构建的评测镜像（如 `noj-judge-python`），
/// 这些镜像通过 `docker build` 提前构建好，不从远程拉取。
/// 如果镜像不存在，返回错误并提示构建命令。
async fn ensure_image_local(docker: &Docker, image: &str) -> Result<()> {
    let images = docker
        .list_images::<String>(None)
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
async fn capture_container_logs(docker: &Docker, container_id: &str) -> ContainerOutput {
    let options = LogsOptions::<String> {
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
                bollard::container::LogOutput::StdOut { message } => {
                    stdout.push_str(&String::from_utf8_lossy(&message));
                }
                bollard::container::LogOutput::StdErr { message } => {
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
        exit_code: 0,
    }
}

/// 解析评测命令为字符串数组。
///
/// 简单 shell 风格分词，支持单引号和双引号。
fn parse_command(command: &str) -> Vec<String> {
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

        let rt = tokio::runtime::Runtime::new().unwrap();
        let result = rt.block_on(get_support_package_bytes(&task)).unwrap();
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

        let rt = tokio::runtime::Runtime::new().unwrap();
        let result = rt.block_on(get_support_package_bytes(&task)).unwrap();
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

        let rt = tokio::runtime::Runtime::new().unwrap();
        let result = rt.block_on(get_support_package_bytes(&task)).unwrap();
        assert!(result.is_none());
    }
}
