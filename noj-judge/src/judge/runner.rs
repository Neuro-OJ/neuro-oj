use std::path::{Path, PathBuf};

use anyhow::Result;
use tracing::{error, info, warn};

use crate::sandbox::cache::SupportPackageCache;
use crate::sandbox::download::{self, DownloadedPackage};
use crate::types::{JudgeResult, JudgeTask};

/// 读取支持包文件大小（用于日志展示；失败时返回 0，不阻断主流程）。
fn package_size(pkg: &DownloadedPackage) -> u64 {
    std::fs::metadata(&pkg.path).map(|m| m.len()).unwrap_or(0)
}

/// 评测任务入口，允许通过 Worker 配置传入每个容器的 CPU 上限。
#[allow(clippy::too_many_arguments)]
pub async fn evaluate_with_cpu_limit(
    docker: bollard::Docker,
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
    command_whitelist: &[String],
    max_evaluator_time_ms: u64,
    max_solution_call_timeout_ms: u64,
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
                    error!(
                        submission_id = %task.submission_id,
                        error = %e,
                        "支持包获取失败，继续执行（可能缺少评测文件）"
                    );
                    None
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
                    return Err(e);
                }
            }
        } else {
            None
        }
    } else {
        None
    };

    crate::dual::evaluate_dual_with_cpu_limit_and_user_llm(
        docker,
        &task.submission_id,
        &task.runtime_config,
        &task.code,
        support_pkg.as_ref().map(|p| p.path.as_path()),
        artifact_zip.as_ref().map(|p| p.path.as_path()),
        task.rejudge_seq,
        task.llm.as_ref(),
        task.user_llm.as_ref(),
        cpu_limit_millicores,
        allow_evaluator_network,
        evaluator_network_mode,
        image_prefix,
        command_whitelist,
        max_evaluator_time_ms,
        max_solution_call_timeout_ms,
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
