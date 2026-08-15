use bollard::models::HostConfig;
use std::collections::HashMap;

/// 构造带标准安全加固的 Docker HostConfig。
///
/// 参数：
/// - `memory_bytes`：内存上限（同时作用于 swap）
/// - `tmpfs`：tmpfs 挂载（如 `("/tmp", "size=256M")`）
/// - `readonly_rootfs`：rootfs 是否只读（双容器 evaluator/solution 均为 false）
/// - `network_mode`：容器网络模式（`"none"` 无网，`"bridge"` 默认桥接）
pub fn build_host_config(
    memory_bytes: i64,
    tmpfs: HashMap<&str, &str>,
    readonly_rootfs: bool,
    network_mode: &str,
) -> HostConfig {
    HostConfig {
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
        // NOJ-188：默认限制单容器最多 1 个 CPU。
        nano_cpus: Some(1_000_000_000),
        ..Default::default()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_security_fields_are_set() {
        let cfg = build_host_config(512 * 1024 * 1024, HashMap::new(), true, "none");

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
        let cfg = build_host_config(512 * 1024 * 1024, HashMap::new(), true, "none");
        assert_eq!(cfg.nano_cpus, Some(1_000_000_000));
    }

    #[test]
    fn test_memory_swap_equals_memory() {
        let memory = 256 * 1024 * 1024;
        let cfg = build_host_config(memory, HashMap::new(), true, "none");

        assert_eq!(cfg.memory, Some(memory));
        assert_eq!(cfg.memory_swap, Some(memory));
        assert_eq!(cfg.memory_swappiness, Some(0));
    }

    #[test]
    fn test_readonly_rootfs_honored() {
        let cfg_ro = build_host_config(512 * 1024 * 1024, HashMap::new(), true, "none");
        assert_eq!(cfg_ro.readonly_rootfs, Some(true));

        let cfg_rw = build_host_config(512 * 1024 * 1024, HashMap::new(), false, "none");
        assert_eq!(cfg_rw.readonly_rootfs, Some(false));
    }

    #[test]
    fn test_tmpfs_converted() {
        let mut tmpfs = HashMap::new();
        tmpfs.insert("/tmp", "size=256M");
        tmpfs.insert("/run", "size=64M");

        let cfg = build_host_config(512 * 1024 * 1024, tmpfs, true, "none");
        let tmpfs_out = cfg.tmpfs.unwrap();

        assert_eq!(tmpfs_out.get("/tmp").unwrap(), "size=256M");
        assert_eq!(tmpfs_out.get("/run").unwrap(), "size=64M");
        assert_eq!(tmpfs_out.len(), 2);
    }

    #[test]
    fn test_empty_tmpfs() {
        let cfg = build_host_config(512 * 1024 * 1024, HashMap::new(), true, "none");
        let tmpfs_out = cfg.tmpfs.unwrap();
        assert!(tmpfs_out.is_empty());
    }

    #[test]
    fn test_network_mode_honored() {
        let cfg_none = build_host_config(512 * 1024 * 1024, HashMap::new(), true, "none");
        assert_eq!(cfg_none.network_mode, Some("none".to_string()));

        let cfg_bridge = build_host_config(512 * 1024 * 1024, HashMap::new(), true, "bridge");
        assert_eq!(cfg_bridge.network_mode, Some("bridge".to_string()));
    }
}
