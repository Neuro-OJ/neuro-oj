## ADDED Requirements

### Requirement: 支持包校验缺失拒绝

judge 下载支持包时，若 `download_url` 未提供 `checksum_sha256` 或校验值为空，SHALL 拒绝该任务（或按配置降级但记录告警），不得静默跳过完整性校验。

#### Scenario: 缺失 checksum 被拒绝

- **WHEN** judge 收到 `noj-download://` URL 且无 `checksum_sha256` 参数
- **THEN** judge 拒绝该任务并返回错误

### Requirement: 缓存文件安全

judge 支持包缓存目录与缓存文件 SHALL 使用受限权限（如目录 0700、文件 0600），并在临时文件写入失败/rename 失败时清理残留临时文件。

#### Scenario: 缓存文件权限受限

- **WHEN** judge 写入缓存 zip 文件
- **THEN** 文件权限为 0600（或更严格），目录权限为 0700（或更严格）

#### Scenario: rename 失败清理临时文件

- **WHEN** 缓存写入时 rename 临时文件失败
- **THEN** judge 删除残留临时文件，不留下 `.tmp` 文件
