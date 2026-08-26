//! Docker daemon 连接与部署边界校验。

use anyhow::{bail, Context, Result};
use bollard::{Docker, API_DEFAULT_VERSION};

/// 本地开发默认使用的 Docker socket。
pub const DEFAULT_DOCKER_HOST: &str = "unix:///var/run/docker.sock";

/// 校验并连接配置的 Unix Docker endpoint。
///
/// 生产环境应将该 endpoint 指向独立 rootless daemon 或独立 judge 主机的 socket。
/// 不支持未经认证的 TCP/HTTP Docker API，避免把完整 Docker 控制面暴露到网络。
pub fn connect(docker_host: &str, require_isolated: bool) -> Result<Docker> {
    let socket_path = validate_endpoint(docker_host, require_isolated)?;
    Docker::connect_with_unix(socket_path, 120, API_DEFAULT_VERSION)
        .context("连接配置的 Docker Unix socket 失败")
}

/// 校验 Docker endpoint，返回去掉 `unix://` 前缀的 socket 路径。
pub fn validate_endpoint(docker_host: &str, require_isolated: bool) -> Result<&str> {
    let socket_path = docker_host
        .strip_prefix("unix://")
        .ok_or_else(|| anyhow::anyhow!("JUDGE_DOCKER_HOST 仅支持 unix:// endpoint"))?;

    if socket_path.is_empty() {
        bail!("JUDGE_DOCKER_HOST 不得为空");
    }

    if require_isolated && is_default_host_socket(socket_path) {
        bail!(
            "已启用 JUDGE_REQUIRE_ISOLATED_DOCKER，但 JUDGE_DOCKER_HOST 仍指向宿主 Docker socket；请配置独立 rootless daemon 或独立 judge 主机的 Unix socket"
        );
    }

    Ok(socket_path)
}

fn is_default_host_socket(path: &str) -> bool {
    matches!(path, "/var/run/docker.sock" | "/run/docker.sock")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_endpoint_is_allowed_for_development() {
        assert_eq!(
            validate_endpoint(DEFAULT_DOCKER_HOST, false).unwrap(),
            "/var/run/docker.sock"
        );
    }

    #[test]
    fn isolated_mode_rejects_default_host_sockets() {
        for host in ["unix:///var/run/docker.sock", "unix:///run/docker.sock"] {
            let error = validate_endpoint(host, true).unwrap_err().to_string();
            assert!(error.contains("JUDGE_REQUIRE_ISOLATED_DOCKER"));
        }
    }

    #[test]
    fn isolated_mode_accepts_dedicated_socket_path() {
        assert_eq!(
            validate_endpoint("unix:///run/noj-judge/docker.sock", true).unwrap(),
            "/run/noj-judge/docker.sock"
        );
    }

    #[test]
    fn non_unix_endpoints_are_rejected() {
        for host in ["tcp://docker:2375", "http://docker:2375", ""] {
            assert!(validate_endpoint(host, false).is_err());
        }
    }
}
