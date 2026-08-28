## Why

生产 Compose 的 `minio-init` 在最小化 `minio/mc` 镜像中调用不存在的 `sed`，会导致应用策略创建失败；由于脚本缺少 fail-fast，初始化仍返回成功，最终让 core 使用的应用凭据无法读写对象存储。这个问题在 staging 权限烟测中已复现，必须在生产部署前修复。

## What Changes

- 使用 `minio/mc` 镜像内置的 shell 能力替换 policy 模板中的 bucket 占位符。
- 为 `minio-init` 启用严格错误处理，策略创建或绑定失败时返回非零状态。
- 保留 bucket-scoped 应用策略，并补充可重复的读写、跨 bucket 和管理权限验证。

## Capabilities

### New Capabilities

无。

### Modified Capabilities

- `object-storage`: 生产对象存储初始化必须在策略创建失败时失败，并确保应用凭据可用。

## Impact

- 修改 `docker-compose.prod.yml` 中的 `minio-init` 初始化命令。
- 影响生产首次部署和应用 S3 凭据轮换；不改变 StorageProvider API 或现有 bucket policy 权限范围。
