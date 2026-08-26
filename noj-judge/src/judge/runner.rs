use anyhow::Result;
use tracing::{error, info, warn};

use crate::sandbox::cache::SupportPackageCache;
use crate::sandbox::download;
use crate::types::{JudgeResult, JudgeTask};

/// 评测任务入口，允许通过 Worker 配置传入每个容器的 CPU 上限。
#[allow(clippy::too_many_arguments)]
pub async fn evaluate_with_cpu_limit(
    docker: bollard::Docker,
    task: &JudgeTask,
    download_timeout_secs: u64,
    cache_dir: String,
    cache_max_items: usize,
    cache_max_mb: u64,
    cpu_limit_millicores: u64,
    allow_evaluator_network: bool,
    evaluator_network_mode: &str,
    allow_http_s3: bool,
    image_prefix: &str,
    command_whitelist: &[String],
    max_evaluator_time_ms: u64,
    max_solution_call_timeout_ms: u64,
) -> Result<JudgeResult> {
    // 下载/获取支持包（含缓存）
    let support_pkg = if let Some(ref url) = task.download_url {
        if !url.is_empty() {
            match fetch_and_cache_support_package(
                url,
                download_timeout_secs,
                allow_http_s3,
                &cache_dir,
                cache_max_items,
                cache_max_mb,
            )
            .await
            {
                Ok(bytes) => {
                    info!(
                        submission_id = %task.submission_id,
                        size = bytes.len(),
                        "支持包已获取"
                    );
                    Some(bytes)
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

    crate::dual::evaluate_dual_with_cpu_limit(
        docker,
        &task.submission_id,
        &task.runtime_config,
        &task.code,
        support_pkg.as_deref(),
        task.rejudge_seq,
        task.llm.as_ref(),
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

/// 获取支持包：缓存优先 → 按 host 分派下载 → SHA-256 校验 → 写缓存。
async fn fetch_and_cache_support_package(
    download_url: &str,
    download_timeout_secs: u64,
    allow_http_s3: bool,
    cache_dir: &str,
    cache_max_items: usize,
    cache_max_mb: u64,
) -> Result<Vec<u8>> {
    // 尝试从缓存获取
    let cache = SupportPackageCache::new(cache_dir, cache_max_items, cache_max_mb).await?;

    // 先解析 URL 获取 checksum（用于缓存查找）
    let checksum = download::extract_checksum(download_url)?;
    if let Some(ref cs) = checksum {
        if let Some(cached) = cache.get(cs).await? {
            download::verify_checksum(&cached, Some(cs))?;
            return Ok(cached);
        }
    }

    let (zip_data, fetched_checksum) =
        download::fetch_support_package(download_url, download_timeout_secs, allow_http_s3).await?;

    // SHA-256 校验
    download::verify_checksum(&zip_data, fetched_checksum.as_deref())?;

    // 写入缓存
    if let Some(ref cs) = fetched_checksum {
        if !cs.is_empty() {
            if let Err(e) = cache.set(cs, &zip_data).await {
                warn!("写入支持包缓存失败: {}", e);
            }
        }
    }

    Ok(zip_data)
}
