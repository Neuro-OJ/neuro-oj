## ADDED Requirements

### Requirement: 容器安全配置验证

系统 SHALL 通过容器 inspect 验证评测容器的安全加固配置实际生效。

#### Scenario: pids_limit 验证

- **WHEN** 通过 `PoolManager` 创建评测容器后执行 `inspect_container`
- **THEN** `host_config.pids_limit` 的值为 `Some(256)`（DoS 防护）

#### Scenario: ipc_mode 验证

- **WHEN** 通过 `PoolManager` 创建评测容器后执行 `inspect_container`
- **THEN** `host_config.ipc_mode` 的值为 `Some("none")`（IPC 隔离）

#### Scenario: no-new-privileges 验证

- **WHEN** 通过 `PoolManager` 创建评测容器后执行 `inspect_container`
- **THEN** `host_config.security_opt` 包含 `"no-new-privileges:true"`（禁止子进程获得更高权限）
