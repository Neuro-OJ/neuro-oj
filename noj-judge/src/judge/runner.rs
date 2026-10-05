use std::path::{Path, PathBuf};

use anyhow::Result;
use tracing::{error, info, warn};

use crate::sandbox::cache::SupportPackageCache;
use crate::sandbox::download::{self, DownloadedPackage};
use crate::types::{JudgeResult, JudgeTask, PublicJudgeError};

/// 支持包 / artifact 获取失败时回传给提交详情页的公开文案（不含 URL/路径）。
pub(crate) const MSG_SUPPORT_PACKAGE_FAILED: &str =
    "评测环境错误：题目支持包获取或完整性校验失败，请联系管理员检查题目支持包与存储配置";
pub(crate) const MSG_ARTIFACT_FAILED: &str =
    "评测环境错误：提交的产物文件获取或完整性校验失败，请稍后重新提交；若持续失败请联系管理员";

/// 读取支持包文件大小（用于日志展示；失败时返回 0，不阻断主流程）。
fn package_size(pkg: &DownloadedPackage) -> u64 {
    std::fs::metadata(&pkg.path).map(|m| m.len()).unwrap_or(0)
}

/// 评测任务入口，允许通过 Worker 配置传入每个容器的 CPU 上限。
///
/// `instance_id`：确定性实例 ID（`noj-{hash12}`），透传到容器实例标签（VULN-15）。
#[allow(clippy::too_many_arguments)]
pub async fn evaluate_with_cpu_limit(
    docker: bollard::Docker,
    resource_lease_client: redis::Client,
    task: &JudgeTask,
    download_timeout_secs: u64,
    cache_dir: String,
    cache_max_items: usize,
    cache_max_mb: u64,
    work_dir: String,
    cpu_limit_millicores: u64,
    allow_evaluator_network: bool,
    evaluator_network_mode: &str,
    allow_http_s3: bool,
    image_prefix: &str,
    oi_image: &str,
    command_whitelist: &[String],
    max_evaluator_time_ms: u64,
    max_solution_call_timeout_ms: u64,
    instance_id: &str,
) -> Result<JudgeResult> {
    let work_dir = PathBuf::from(work_dir);

    // 下载/获取支持包（含缓存）。返回的是磁盘文件路径，`DownloadedPackage`
    // 对临时文件负责自动清理，缓存命中的路径不会删除。
    let support_pkg = if let Some(ref url) = task.download_url {
        if !url.is_empty() {
            match fetch_and_cache_support_package(
                url,
                download_timeout_secs,
                allow_http_s3,
                &cache_dir,
                cache_max_items,
                cache_max_mb,
                &work_dir,
            )
            .await
            {
                Ok(pkg) => {
                    info!(
                        submission_id = %task.submission_id,
                        size = package_size(&pkg),
                        path = %pkg.path.display(),
                        "支持包已获取（流式落盘）"
                    );
                    Some(pkg)
                }
                Err(e) => {
                    // VULN-18：支持包获取/校验失败时**禁止静默放行**。
                    // 原实现仅打一条 error 日志后携带 None 继续，评测容器在缺少
                    // evaluate.py / 数据集的情况下启动，最终把「平台侧下载失败」
                    // 归因成做题人的 SystemError（甚至用空环境给出错误分数）。
                    error!(
                        submission_id = %task.submission_id,
                        error = %e,
                        "支持包获取或 SHA-256 校验失败，评测任务终止"
                    );
                    return Err(
                        PublicJudgeError(MSG_SUPPORT_PACKAGE_FAILED).with_detail(format!("{e:#}"))
                    );
                }
            }
        } else {
            None
        }
    } else {
        None
    };

    // 下载 artifact zip（一次性，不缓存）
    let artifact_zip = if let Some(ref url) = task.artifact_download_url {
        if !url.is_empty() {
            match fetch_artifact_package(url, download_timeout_secs, allow_http_s3, &work_dir).await
            {
                Ok(pkg) => {
                    info!(
                        submission_id = %task.submission_id,
                        size = package_size(&pkg),
                        path = %pkg.path.display(),
                        "artifact zip 已获取（流式落盘）"
                    );
                    Some(pkg)
                }
                Err(e) => {
                    error!(
                        submission_id = %task.submission_id,
                        error = %e,
                        "artifact 下载失败"
                    );
                    return Err(PublicJudgeError(MSG_ARTIFACT_FAILED).with_detail(format!("{e:#}")));
                }
            }
        } else {
            None
        }
    } else {
        None
    };

    if task.judge_type == "oi" {
        if artifact_zip.is_some() || task.llm.is_some() {
            anyhow::bail!("OI 评测任务不支持 artifact 或 LLM 字段");
        }
        let support_package = support_pkg
            .as_ref()
            .map(|package| package.path.as_path())
            .ok_or_else(|| anyhow::anyhow!("OI 评测任务缺少支持包"))?;
        return match tokio::time::timeout(
            std::time::Duration::from_secs(300),
            crate::oi::runner::evaluate_native(
                &docker,
                task,
                support_package,
                oi_image,
                cpu_limit_millicores,
                instance_id,
                Some(&resource_lease_client),
            ),
        )
        .await
        {
            Ok(result) => match result {
                Ok(result) => Ok(result),
                Err(error) => {
                    tracing::error!(
                        submission_id = %task.submission_id,
                        error = %error,
                        "OI 评测执行异常，归因为 SE"
                    );
                    Ok(crate::oi::runner::system_error_result(
                        task,
                        "OI 评测执行失败",
                    ))
                }
            },
            Err(_) => Ok(crate::oi::runner::system_error_result(
                task,
                "OI 评测超过 300 秒任务看门狗",
            )),
        };
    }

    let dual_runtime_config = task
        .runtime_config
        .as_dual()
        .ok_or_else(|| anyhow::anyhow!("judge_type 与 runtime_config 不匹配"))?;

    crate::dual::evaluate_dual_with_cpu_limit(
        docker,
        &task.submission_id,
        dual_runtime_config,
        &task.code,
        support_pkg.as_ref().map(|p| p.path.as_path()),
        artifact_zip.as_ref().map(|p| p.path.as_path()),
        task.rejudge_seq,
        task.llm.as_ref(),
        cpu_limit_millicores,
        allow_evaluator_network,
        evaluator_network_mode,
        image_prefix,
        command_whitelist,
        max_evaluator_time_ms,
        max_solution_call_timeout_ms,
        instance_id,
    )
    .await
}

/// 获取支持包：缓存优先 → 按 host 分派流式下载 → SHA-256 校验 → 流式写缓存。
async fn fetch_and_cache_support_package(
    download_url: &str,
    download_timeout_secs: u64,
    allow_http_s3: bool,
    cache_dir: &str,
    cache_max_items: usize,
    cache_max_mb: u64,
    work_dir: &Path,
) -> Result<DownloadedPackage> {
    // 尝试从缓存获取（只拿路径，不读整包到内存）
    let cache = SupportPackageCache::new(cache_dir, cache_max_items, cache_max_mb).await?;

    // 先解析 URL 获取 checksum（用于缓存查找）
    let checksum = download::extract_checksum(download_url)?;
    if let Some(ref cs) = checksum {
        if let Some(cached_path) = cache.get_path(cs).await? {
            download::verify_checksum_file(&cached_path, Some(cs)).await?;
            return Ok(DownloadedPackage {
                path: cached_path,
                checksum: Some(cs.clone()),
                cleanup: false,
            });
        }
    }

    let pkg = download::fetch_support_package_to_path(
        download_url,
        work_dir,
        download_timeout_secs,
        allow_http_s3,
    )
    .await?;

    // SHA-256 校验（流式读取文件）
    download::verify_checksum_file(&pkg.path, pkg.checksum.as_deref()).await?;

    // 流式写入缓存（不经过内存）
    if let Some(ref cs) = pkg.checksum {
        if !cs.is_empty() {
            if let Err(e) = cache.set_from_file(cs, &pkg.path).await {
                warn!("写入支持包缓存失败: {}", e);
            }
        }
    }

    Ok(pkg)
}

/// 下载 artifact zip（不缓存），返回文件路径并校验。
async fn fetch_artifact_package(
    download_url: &str,
    download_timeout_secs: u64,
    allow_http_s3: bool,
    work_dir: &Path,
) -> Result<DownloadedPackage> {
    let pkg = download::fetch_support_package_to_path(
        download_url,
        work_dir,
        download_timeout_secs,
        allow_http_s3,
    )
    .await?;
    download::verify_checksum_file(&pkg.path, pkg.checksum.as_deref()).await?;
    Ok(pkg)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::{EvaluatorRuntime, JudgeRuntimeConfig, RuntimeConfig, SolutionRuntime};

    /// 构造仅用于「支持包获取阶段失败」的测试任务：失败发生在触碰 Docker 之前。
    fn task_with_download_url(download_url: &str) -> JudgeTask {
        JudgeTask {
            submission_id: "sid-support-fail".to_string(),
            problem_id: "1001".to_string(),
            user_id: "u-1".to_string(),
            priority: "medium".to_string(),
            judge_type: "dual".to_string(),
            download_url: Some(download_url.to_string()),
            artifact_download_url: None,
            runtime_config: JudgeRuntimeConfig::Dual(RuntimeConfig {
                evaluator: EvaluatorRuntime {
                    image: "noj-evaluator-python".to_string(),
                    command: "python3 /workspace/evaluate.py".to_string(),
                    time_limit_ms: 1000,
                    memory_limit_mb: 128,
                    network: None,
                },
                solution: SolutionRuntime {
                    image: "noj-solution-python".to_string(),
                    call_timeout_ms: 1000,
                    memory_limit_mb: 128,
                },
            }),
            oi_cost_profile: None,
            language: "python3".to_string(),
            code: "def solve(): return 1".to_string(),
            file_name: None,
            rejudge_seq: None,
            llm: None,
        }
    }

    /// 该测试只覆盖支持包获取/校验失败的早退路径，不会真正连 Docker
    /// （daemon 不可用时也在下载失败之后，不会被触达）。
    fn offline_docker() -> bollard::Docker {
        bollard::Docker::connect_with_unix("/var/run/docker.sock", 1, bollard::API_DEFAULT_VERSION)
            .expect("构造 Docker 客户端不应失败（不建立连接）")
    }

    #[tokio::test]
    async fn support_package_download_failure_aborts_task() {
        let tmp = tempfile::tempdir().unwrap();
        // 不存在的本地支持包 → local 协议复制失败
        let url = "noj-download://local?path=%2Fnonexistent%2Fnope.zip&checksum_sha256=deadbeef";
        let task = task_with_download_url(url);

        let err = evaluate_with_cpu_limit(
            offline_docker(),
            redis::Client::open("redis://127.0.0.1/").unwrap(),
            &task,
            5,
            tmp.path().join("cache").to_string_lossy().to_string(),
            10,
            10,
            tmp.path().join("work").to_string_lossy().to_string(),
            1000,
            false,
            "noj-eval-net",
            false,
            "noj-",
            "noj-oi-cpp",
            &["python3".to_string()],
            300_000,
            60_000,
            "noj-testinstance",
        )
        .await
        .expect_err("支持包获取失败必须终止评测任务（VULN-18）");

        let msg = err.to_string();
        assert!(
            msg.contains("local 文件") || msg.contains("非法") || msg.contains("读取"),
            "错误信息应指向支持包获取失败，实际: {}",
            msg
        );
        let r = JudgeResult::from_error(&err, &task.submission_id, None);
        assert!(r.output.starts_with(MSG_SUPPORT_PACKAGE_FAILED));
        assert!(!r.output.contains("nonexistent"), "公开文案不得包含路径");
    }

    #[tokio::test]
    async fn support_package_checksum_mismatch_aborts_task() {
        let tmp = tempfile::tempdir().unwrap();
        // 真实存在的 zip，但 checksum 不匹配 → 必须终止评测任务
        let pkg_path = tmp.path().join("support.zip");
        std::fs::write(&pkg_path, b"PK\x03\x04 not a real zip").unwrap();
        let url = format!(
            "noj-download://local?path={}&checksum_sha256={}",
            pkg_path.to_string_lossy().replace('/', "%2F"),
            "0".repeat(64)
        );
        let task = task_with_download_url(&url);

        let err = evaluate_with_cpu_limit(
            offline_docker(),
            redis::Client::open("redis://127.0.0.1/").unwrap(),
            &task,
            5,
            tmp.path().join("cache").to_string_lossy().to_string(),
            10,
            10,
            tmp.path().join("work").to_string_lossy().to_string(),
            1000,
            false,
            "noj-eval-net",
            false,
            "noj-",
            "noj-oi-cpp",
            &["python3".to_string()],
            300_000,
            60_000,
            "noj-testinstance",
        )
        .await
        .expect_err("SHA-256 校验失败必须终止评测任务（VULN-18）");

        assert!(
            err.to_string().contains("SHA-256"),
            "错误信息应指向校验失败，实际: {}",
            err
        );
        let r = JudgeResult::from_error(&err, &task.submission_id, None);
        assert!(r.output.starts_with(MSG_SUPPORT_PACKAGE_FAILED));
    }
}
