//! 容器清理工具函数。

use std::time::Duration;

use bollard::query_parameters::RemoveContainerOptions;
use bollard::Docker;
use tracing::warn;

/// 强制删除 Docker 容器（带重试）。
///
/// 重试策略：100ms → 500ms → 2s（共 3 次尝试）。
/// 容器已不存在（"not found"）时立即返回，不视为错误。
pub async fn remove_container_force(docker: &Docker, container_id: &str) {
    for delay_ms in &[100u64, 500, 2000] {
        let options = RemoveContainerOptions {
            force: true,
            ..Default::default()
        };
        match docker.remove_container(container_id, Some(options)).await {
            Ok(_) => return,
            Err(e) => {
                if e.to_string().contains("not found") {
                    return; // 已不存在，无需重试
                }
                warn!(
                    "docker rm -f 失败 (重试前等 {}ms): container={}, error={}",
                    delay_ms, container_id, e
                );
            }
        }
        tokio::time::sleep(Duration::from_millis(*delay_ms)).await;
    }
}
