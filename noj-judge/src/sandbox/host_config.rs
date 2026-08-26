use bollard::models::HostConfig;
use std::collections::HashMap;

use crate::config::{MAX_CPU_LIMIT_MILLICORES, MIN_CPU_LIMIT_MILLICORES};

/// 构造带指定 CPU 上限的 Docker HostConfig。
///
/// `cpu_limit_millicores` 使用 millicores 单位：1000 = 1 个 CPU 核。
/// 即使调用方传入越界值，也会在这里收敛到安全范围，避免 0 被 Docker
/// 解释为“不限制 CPU”。
pub fn build_host_config_with_cpu(
    memory_bytes: i64,
    tmpfs: HashMap<&str, &str>,
    readonly_rootfs: bool,
    network_mode: &str,
    cpu_limit_millicores: u64,
) -> HostConfig {
    let normalized_cpu =
        cpu_limit_millicores.clamp(MIN_CPU_LIMIT_MILLICORES, MAX_CPU_LIMIT_MILLICORES);
    let nano_cpus = (normalized_cpu * 1_000_000) as i64;

    HostConfig {
        // 评测容器不得获得任何宿主路径、设备或其他容器的挂载。
        binds: None,
        mounts: None,
        volumes_from: None,
        devices: None,
        device_requests: None,
        device_cgroup_rules: None,
        cap_add: None,
        pid_mode: None,
        uts_mode: None,
        userns_mode: None,
        cap_drop: Some(vec!["ALL".to_string()]),
        security_opt: Some(vec!["no-new-privileges:true".to_string()]),
        privileged: Some(false),
        readonly_rootfs: Some(readonly_rootfs),
        network_mode: Some(network_mode.to_string()),
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
        // NOJ-188：默认限制单容器最多 1 个 CPU；可通过 Judge 配置调整。
        nano_cpus: Some(nano_cpus),
        ..Default::default()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_security_fields_are_set() {
        let cfg = build_host_config_with_cpu(512 * 1024 * 1024, HashMap::new(), true, "none", 1000);

        assert_eq!(cfg.cap_drop, Some(vec!["ALL".to_string()]));
        assert_eq!(
            cfg.security_opt,
            Some(vec!["no-new-privileges:true".to_string()])
        );
        assert_eq!(cfg.privileged, Some(false));
        assert_eq!(cfg.network_mode, Some("none".to_string()));
        assert_eq!(cfg.ipc_mode, Some("none".to_string()));
        assert_eq!(cfg.pids_limit, Some(256));
    }

    #[test]
    fn test_cpu_limit_is_set() {
        let cfg = build_host_config_with_cpu(512 * 1024 * 1024, HashMap::new(), true, "none", 1000);
        assert_eq!(cfg.nano_cpus, Some(1_000_000_000));
    }

    #[test]
    fn test_cpu_limit_can_be_configured_in_millicores() {
        let cfg = build_host_config_with_cpu(512 * 1024 * 1024, HashMap::new(), true, "none", 2500);
        assert_eq!(cfg.nano_cpus, Some(2_500_000_000));
    }

    #[test]
    fn test_invalid_cpu_limit_is_clamped() {
        let zero = build_host_config_with_cpu(512 * 1024 * 1024, HashMap::new(), true, "none", 0);
        assert_eq!(zero.nano_cpus, Some(100_000_000));

        let too_large =
            build_host_config_with_cpu(512 * 1024 * 1024, HashMap::new(), true, "none", 20_000);
        assert_eq!(too_large.nano_cpus, Some(16_000_000_000));
    }

    #[test]
    fn test_memory_swap_equals_memory() {
        let memory = 256 * 1024 * 1024;
        let cfg = build_host_config_with_cpu(memory, HashMap::new(), true, "none", 1000);

        assert_eq!(cfg.memory, Some(memory));
        assert_eq!(cfg.memory_swap, Some(memory));
        assert_eq!(cfg.memory_swappiness, Some(0));
    }

    #[test]
    fn test_readonly_rootfs_honored() {
        let cfg_ro =
            build_host_config_with_cpu(512 * 1024 * 1024, HashMap::new(), true, "none", 1000);
        assert_eq!(cfg_ro.readonly_rootfs, Some(true));

        let cfg_rw =
            build_host_config_with_cpu(512 * 1024 * 1024, HashMap::new(), false, "none", 1000);
        assert_eq!(cfg_rw.readonly_rootfs, Some(false));
    }

    #[test]
    fn test_tmpfs_converted() {
        let mut tmpfs = HashMap::new();
        tmpfs.insert("/tmp", "size=256M");
        tmpfs.insert("/run", "size=64M");

        let cfg = build_host_config_with_cpu(512 * 1024 * 1024, tmpfs, true, "none", 1000);
        let tmpfs_out = cfg.tmpfs.unwrap();

        assert_eq!(tmpfs_out.get("/tmp").unwrap(), "size=256M");
        assert_eq!(tmpfs_out.get("/run").unwrap(), "size=64M");
        assert_eq!(tmpfs_out.len(), 2);
    }

    #[test]
    fn test_empty_tmpfs() {
        let cfg = build_host_config_with_cpu(512 * 1024 * 1024, HashMap::new(), true, "none", 1000);
        let tmpfs_out = cfg.tmpfs.unwrap();
        assert!(tmpfs_out.is_empty());
    }

    #[test]
    fn test_network_mode_honored() {
        let cfg_none =
            build_host_config_with_cpu(512 * 1024 * 1024, HashMap::new(), true, "none", 1000);
        assert_eq!(cfg_none.network_mode, Some("none".to_string()));

        let cfg_bridge =
            build_host_config_with_cpu(512 * 1024 * 1024, HashMap::new(), true, "bridge", 1000);
        assert_eq!(cfg_bridge.network_mode, Some("bridge".to_string()));
    }

    #[test]
    fn test_host_boundary_fields_do_not_grant_host_access() {
        let cfg = build_host_config_with_cpu(512 * 1024 * 1024, HashMap::new(), true, "none", 1000);

        assert!(cfg.binds.is_none());
        assert!(cfg.mounts.is_none());
        assert!(cfg.volumes_from.is_none());
        assert!(cfg.devices.is_none());
        assert!(cfg.device_requests.is_none());
        assert!(cfg.device_cgroup_rules.is_none());
        assert!(cfg.cap_add.is_none());
        assert!(cfg.pid_mode.is_none());
        assert!(cfg.uts_mode.is_none());
        assert!(cfg.userns_mode.is_none());
        assert_eq!(cfg.privileged, Some(false));
    }
}
