use bollard::models::HostConfig;
use std::collections::HashMap;

/// Build a Docker HostConfig with standard security hardening.
///
/// Parameters:
/// - `memory_bytes`: total memory limit (also applied to swap)
/// - `tmpfs`: tmpfs mounts (e.g., `("/tmp", "size=256M")`)
/// - `readonly_rootfs`: whether rootfs is read-only (dual evaluator/solution = false)
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_security_fields_are_set() {
        let cfg = build_host_config(512 * 1024 * 1024, HashMap::new(), true);

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
    fn test_memory_swap_equals_memory() {
        let memory = 256 * 1024 * 1024;
        let cfg = build_host_config(memory, HashMap::new(), true);

        assert_eq!(cfg.memory, Some(memory));
        assert_eq!(cfg.memory_swap, Some(memory));
        assert_eq!(cfg.memory_swappiness, Some(0));
    }

    #[test]
    fn test_readonly_rootfs_honored() {
        let cfg_ro = build_host_config(512 * 1024 * 1024, HashMap::new(), true);
        assert_eq!(cfg_ro.readonly_rootfs, Some(true));

        let cfg_rw = build_host_config(512 * 1024 * 1024, HashMap::new(), false);
        assert_eq!(cfg_rw.readonly_rootfs, Some(false));
    }

    #[test]
    fn test_tmpfs_converted() {
        let mut tmpfs = HashMap::new();
        tmpfs.insert("/tmp", "size=256M");
        tmpfs.insert("/run", "size=64M");

        let cfg = build_host_config(512 * 1024 * 1024, tmpfs, true);
        let tmpfs_out = cfg.tmpfs.unwrap();

        assert_eq!(tmpfs_out.get("/tmp").unwrap(), "size=256M");
        assert_eq!(tmpfs_out.get("/run").unwrap(), "size=64M");
        assert_eq!(tmpfs_out.len(), 2);
    }

    #[test]
    fn test_empty_tmpfs() {
        let cfg = build_host_config(512 * 1024 * 1024, HashMap::new(), true);
        let tmpfs_out = cfg.tmpfs.unwrap();
        assert!(tmpfs_out.is_empty());
    }
}
