## Why

当前支持包（题目测试数据 zip）全部使用本地文件系统存储，通过 Base64 编码后内联在 Redis 消息中传输给 noj-judge，限制上传大小约 12MB（Redis 16MB 消息上限 - Base64 ~33% 膨胀）。这阻碍了多 Worker 水平扩展（文件必须位于 noj-core 可访问的本地磁盘），且 12MB 的约束限制了复杂题目的测试数据规模。引入抽象存储层支持 S3 兼容对象存储（MinIO），支持包上限放宽至 128 MiB，实现存储与计算解耦，为生产环境多 Worker 部署铺路。

## What Changes

- 新增 `StorageProvider` 抽象接口，定义 `put`/`get`/`delete`/`downloadUrl` 四个方法
- 实现 `LocalStorageProvider`（标注为开发测试专用）和 `S3StorageProvider`（使用 `@aws-sdk/client-s3`）
- **两种 URL 空间**：`noj-storage://` 用于 DB 存储，`noj-download://` 用于 JudgeTask 交付
  - DB: `noj-storage://local/[base64]?checksum_sha256=...` / `noj-storage://s3/[key]?checksum_sha256=...`
  - JudgeTask: `noj-download://base64/?content=[base64]&checksum_sha256=...` / `noj-download://s3?url=[percent-encoded-presigned-url]&checksum_sha256=...`
- JudgeTask 字段 `support_package_url` **改名为 `download_url`**（移除 `support_package_base64`）
- `download_url` 自包含下载方式和 `checksum_sha256`，judge 无需额外字段
- noj-judge 解析 `noj-download://` URL 分派：host=`base64` → 提取 `content` 解码；host=`s3` → 解码 `url` 后 HTTP 下载
- 下载后校验 SHA-256 完整性（来自 URL 中 `checksum_sha256`）；磁盘缓存按内容寻址，LRU 淘汰
- docker-compose 开发环境增加 MinIO 服务
- DB schema 变更：`support_package_path` → `support_package_storage_url`

## Capabilities

### New Capabilities
- `object-storage`: 抽象存储层——定义 StorageProvider 接口、`noj-storage://` 与 `noj-download://` 两种 URL 规范、LocalStorageProvider 和 S3StorageProvider 的行为要求

### Modified Capabilities
- `support-package-upload`: 存储路径格式从本地相对路径变为 `noj-storage://` URL；新增支持包下载端点（GET，通过 core 代理）；上传/删除的权限模型不变
- `judge-worker`: 评测编排步骤中支持包获取方式从 Base64 解码改为 `noj-download://` URL 分派；支持磁盘缓存和完整性校验

## Impact

- **noj-core**: 新增 `src/lib/storage/` 模块（~4 文件）；修改 `services/support-package.ts`、`services/submissions.ts`、`services/problems.ts`、`types/index.ts`
- **noj-judge**: 新增 `reqwest`、`sha2` 依赖；修改 `types.rs`、`sandbox/container.rs`、`judge/runner.rs`、`config.rs`；移除 `get_support_package_bytes()`；新增缓存模块
- **noj-ui**: 无变更（上传仍通过后端中转）
- **文档**: 更新 `noj-core/CLAUDE.md` 和 `AGENTS.md` 中的存储路径描述、环境变量表格；更新 `README.md`
- **构建脚本**: `scripts/build-packages.ts` 更新注释；`scripts/seed.ts` 更新路径格式
- **环境变量**: `noj-core/.env.example` 新增 STORAGE_PROVIDER、S3_*；`env.e2e.template` 同步
- **基础设施**: `docker-compose.yml`、`docker-compose.e2e.yml`、`.github/workflows/e2e.yml`、`scripts/e2e/setup.sh` 增加 MinIO
- **依赖**: Deno 新增 `@aws-sdk/client-s3`、`@aws-sdk/s3-request-presigner`；Rust 新增 `reqwest`、`sha2`
- **向后兼容**: 非 `noj-storage://` 前缀的旧路径自动视为 local legacy path
