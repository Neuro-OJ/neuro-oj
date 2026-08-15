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

/// 实例标签 key：用于启动时只清理本实例残留容器。
pub const INSTANCE_LABEL: &str = "com.noj.judge.instance";

/// 读取实例标识（与 config.rs 保持一致）。
pub fn instance_label_value() -> String {
    std::env::var("JUDGE_INSTANCE_ID").unwrap_or_else(|_| {
        format!(
            "{}-{}",
            std::env::var("HOSTNAME").unwrap_or_else(|_| "unknown".to_string()),
            std::process::id()
        )
    })
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

/// NOJ-154：启动时清理带本实例标签的孤儿容器。
///
/// 实例标签在 `dual/container.rs` 创建容器时写入；旧版本/崩溃残留均可回收。
pub async fn cleanup_orphan_containers(docker: &Docker, instance_id: &str) -> usize {
    let mut filters = HashMap::new();
    filters.insert(
        "label".to_string(),
        vec![format!("{}={}", INSTANCE_LABEL, instance_id)],
    );
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
