//! 容器清理工具函数。

use std::time::Duration;

use bollard::errors::Error as BollardError;
use bollard::query_parameters::RemoveContainerOptions;
use bollard::Docker;
use tokio::time::timeout;
use tracing::{error, warn};

/// docker rm -f 单次超时（秒）。
const RM_F_TIMEOUT_SECS: u64 = 10;

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
