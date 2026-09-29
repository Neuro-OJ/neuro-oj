//! 容器清理工具函数。

use std::collections::HashMap;
use std::time::Duration;

use bollard::errors::Error as BollardError;
use bollard::query_parameters::{ListContainersOptionsBuilder, RemoveContainerOptions};
use bollard::Docker;
use tokio::time::timeout;
use tracing::{error, info, warn};

/// docker rm -f 单次超时（秒）。
const RM_F_TIMEOUT_SECS: u64 = 10;

/// 实例标签 key：用于启动时**精准**清理本实例残留容器。
///
/// 值为确定性实例 ID（`noj-{hash12}`，见 `config::resolve_instance_id`）。
pub const INSTANCE_LABEL: &str = "com.noj.judge.instance";

/// 平台级归属标签 key：标记容器由 noj-judge 创建（兜底清扫用）。
pub const MANAGED_BY_LABEL: &str = "com.noj.managed-by";

/// 平台级归属标签值。
pub const MANAGED_BY_VALUE: &str = "noj-judge";

/// 构造「按实例标签精准匹配」的容器过滤器（VULN-15）。
///
/// 只匹配本实例自己创建的容器；即使实例 ID 变化也**不会**误杀 postgres/redis
/// 等宿主业务容器。平台级兜底清扫使用 [`MANAGED_BY_LABEL`]
/// （`com.noj.managed-by=noj-judge`），由运维显式操作，不进入启动清扫路径。
pub fn instance_label_filter(instance_id: &str) -> HashMap<String, Vec<String>> {
    let mut filters = HashMap::new();
    filters.insert(
        "label".to_string(),
        vec![format!("{}={}", INSTANCE_LABEL, instance_id)],
    );
    filters
}

/// 强制删除 Docker 容器（带重试）。
///
/// 重试策略：100ms → 500ms → 2s（共 3 次尝试）。
/// 容器已不存在（404）时立即返回，不视为错误。
///
/// 返回 `true` 表示容器已成功删除或本就不存在，
/// `false` 表示所有重试均失败。
pub async fn remove_container_force(docker: &Docker, container_id: &str) -> bool {
    let delays = [100u64, 500, 2000];

    for (i, delay_ms) in delays.iter().enumerate() {
        let options = RemoveContainerOptions {
            force: true,
            ..Default::default()
        };

        let result = timeout(
            Duration::from_secs(RM_F_TIMEOUT_SECS),
            docker.remove_container(container_id, Some(options)),
        )
        .await;

        match result {
            Ok(Ok(_)) => return true,
            Ok(Err(BollardError::DockerResponseServerError {
                status_code: 404, ..
            })) => return true, // 已不存在，无需重试
            Ok(Err(e)) => {
                warn!(
                    "docker rm -f 失败 (attempt {}/{}): container={}, error={}",
                    i + 1,
                    delays.len(),
                    container_id,
                    e
                );
            }
            Err(_elapsed) => {
                warn!(
                    "docker rm -f 超时 (attempt {}/{}): container={}",
                    i + 1,
                    delays.len(),
                    container_id,
                );
            }
        }
        tokio::time::sleep(Duration::from_millis(*delay_ms)).await;
    }

    error!(
        "docker rm -f 最终失败: container={}（已重试 {} 次）",
        container_id,
        delays.len(),
    );
    false
}

/// NOJ-154 / VULN-15：启动时按**确定性实例标签**清理本实例孤儿容器。
///
/// 实例标签在 `dual/container.rs` 创建容器时写入（值为 `noj-{hash12}`）；
/// 实例 ID 重启后保持不变，因此崩溃残留容器可被精准回收（原实现绑定
/// `{hostname}-{pid}`，PID 变化后清扫完全失效）。
pub async fn cleanup_orphan_containers(docker: &Docker, instance_id: &str) -> usize {
    let filters = instance_label_filter(instance_id);
    let options = ListContainersOptionsBuilder::new()
        .all(true)
        .filters(&filters)
        .build();

    let containers = match docker.list_containers(Some(options)).await {
        Ok(c) => c,
        Err(e) => {
            error!(error = %e, "列出孤儿容器失败");
            return 0;
        }
    };

    let mut cleaned = 0usize;
    for container in containers {
        let id = container.id.unwrap_or_default();
        if id.is_empty() {
            continue;
        }
        info!(container_id = %id, "启动时清理本实例残留容器");
        if remove_container_force(docker, &id).await {
            cleaned += 1;
        }
    }
    if cleaned > 0 {
        info!(count = cleaned, "孤儿容器清理完成");
    }
    cleaned
}

/// JA-03：清理 WorkDir 下崩溃遗留的孤儿支持包/artifact 临时文件（`support-*.zip`）。
/// 避免机器崩溃、OOM 或任务被强制 kill 时，临时 zip 残留撑爆磁盘。
pub async fn cleanup_orphan_support_packages(work_dir: &str) -> usize {
    let dir = std::path::Path::new(work_dir);
    if !dir.exists() {
        return 0;
    }
    let mut entries = match tokio::fs::read_dir(dir).await {
        Ok(e) => e,
        Err(e) => {
            warn!(error = %e, "读取 work_dir 清理孤儿支持包失败");
            return 0;
        }
    };
    let mut cleaned = 0usize;
    while let Ok(Some(entry)) = entries.next_entry().await {
        let path = entry.path();
        if let Some(file_name) = path.file_name().and_then(|f| f.to_str()) {
            if file_name.starts_with("support-") && file_name.ends_with(".zip") {
                if let Err(e) = tokio::fs::remove_file(&path).await {
                    warn!(path = %path.display(), error = %e, "删除孤儿临时 zip 失败");
                } else {
                    cleaned += 1;
                }
            }
        }
    }
    if cleaned > 0 {
        info!(count = cleaned, "清理孤儿 support-*.zip 临时文件完成");
    }
    cleaned
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 本实例清扫过滤器必须**只**匹配本实例标签（精准，不误杀宿主业务容器）。
    #[test]
    fn instance_label_filter_matches_exact_instance_label() {
        let instance_id = "noj-a4f78e2b109c";
        let filters = instance_label_filter(instance_id);
        assert_eq!(
            filters.get("label"),
            Some(&vec![format!("{}={}", INSTANCE_LABEL, "noj-a4f78e2b109c")])
        );
        assert_eq!(INSTANCE_LABEL, "com.noj.judge.instance");
        // 值必须是纯 ASCII 的 noj-{hash12}，不得含 ':'、'='、空格
        assert!(instance_id
            .chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-'));
    }

    /// 平台级兜底标签与实例标签必须解耦（兜底标签不得混入精准清扫过滤器）。
    #[test]
    fn managed_by_label_is_distinct_from_instance_label() {
        assert_eq!(MANAGED_BY_LABEL, "com.noj.managed-by");
        assert_eq!(MANAGED_BY_VALUE, "noj-judge");
        assert_ne!(MANAGED_BY_LABEL, INSTANCE_LABEL);

        let filters = instance_label_filter("noj-a4f78e2b109c");
        let patterns = filters.get("label").unwrap();
        assert_eq!(patterns.len(), 1, "精准清扫只能基于实例标签单条件匹配");
        assert!(
            !patterns[0].contains(MANAGED_BY_LABEL),
            "精准清扫不得退化为平台级兜底匹配: {:?}",
            patterns
        );
    }

    #[tokio::test]
    async fn test_cleanup_orphan_support_packages() {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path();
        // 创建 support-*.zip 文件与非 support 文件
        std::fs::write(path.join("support-1111.zip"), "mock-zip-1").unwrap();
        std::fs::write(path.join("support-2222.zip"), "mock-zip-2").unwrap();
        std::fs::write(path.join("other-file.txt"), "keep-me").unwrap();

        let cleaned = cleanup_orphan_support_packages(&path.to_string_lossy()).await;
        assert_eq!(cleaned, 2);
        assert!(!path.join("support-1111.zip").exists());
        assert!(!path.join("support-2222.zip").exists());
        assert!(path.join("other-file.txt").exists());
    }
}
