use bollard::models::HostConfig;
use std::collections::HashMap;

/// Build a Docker HostConfig with standard security hardening.
///
/// Parameters:
/// - `memory_bytes`: total memory limit (also applied to swap)
/// - `tmpfs`: tmpfs mounts (e.g., `("/tmp", "size=256M")`)
/// - `readonly_rootfs`: whether rootfs is read-only (pool containers = true, dual evaluator = false)
pub fn build_host_config(
    memory_bytes: i64,
    tmpfs: HashMap<&str, &str>,
    readonly_rootfs: bool,
) -> HostConfig {
    HostConfig {
        cap_drop: Some(vec!["ALL".to_string()]),
        security_opt: Some(vec!["no-new-privileges:true".to_string()]),
        privileged: Some(false),
        readonly_rootfs: Some(readonly_rootfs),
        network_mode: Some("none".to_string()),
        ipc_mode: Some("none".to_string()),
        pids_limit: Some(256),
        tmpfs: Some(
            tmpfs
                .into_iter()
                .map(|(k, v)| (k.to_string(), v.to_string()))
                .collect(),
        ),
        memory: Some(memory_bytes),
        memory_swap: Some(memory_bytes),
        memory_swappiness: Some(0),
        ..Default::default()
    }
}
