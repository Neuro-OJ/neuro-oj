## Why

当前支持包（题目测试数据 zip）全部使用本地文件系统存储，通过 Base64 编码后内联在 Redis 消息中传输给 noj-judge，限制上传大小约 12MB（Redis 16MB 消息上限 - Base64 ~33% 膨胀）。这阻碍了多 Worker 水平扩展（文件必须位于 noj-core 可访问的本地磁盘），且 12MB 的约束限制了复杂题目的测试数据规模。引入抽象存储层支持 S3 兼容对象存储（MinIO），支持包上限放宽至 128 MiB，实现存储与计算解耦，为生产环境多 Worker 部署铺路。

## What Changes

- 新增 `StorageProvider` 抽象接口，定义 `put`/`get`/`delete`/`presignedUrl` 四个方法
- 实现 `LocalStorageProvider`（标注为开发测试专用，base64 数据直接编码到 `storage://local/<base64>` URL 中）和 `S3StorageProvider`（使用 `@aws-sdk/client-s3`，DB 存 object key，judge 拿 presigned HTTPS URL）
- **JudgeTask 统一使用 `support_package_url`**（移除 `support_package_base64`）
- S3 模式：DB 存 object key（如 `packages/123.zip`），`presignedUrl()` 生成 presigned HTTPS URL → judge HTTP 下载
- Local 模式：数据自包含在 `storage://local/<base64>` URL 中 → judge 提取 base64 解码
- noj-judge 根据 URL scheme 分派：`http://` 或 `https://` → HTTP GET 下载；`storage://local/` → base64 解码
- 下载/解码失败直接返回 SystemError（无回退）
- docker-compose 开发环境增加 MinIO 服务
- DB schema 无变更（`support_package_path` text 列复用，值格式从本地相对路径变为 `storage://` URL）

## Capabilities

### New Capabilities
- `object-storage`: 抽象存储层——定义 StorageProvider 接口、`storage://` URL 规范、LocalStorageProvider 和 S3StorageProvider 的行为要求

### Modified Capabilities
- `support-package-upload`: 存储路径格式从本地相对路径变为 `storage://` URL；新增支持包下载端点（GET）；上传/删除的权限模型不变
- `judge-worker`: 评测编排步骤中支持包获取方式从 Base64 解码改为 HTTP URL 下载；下载失败直接返回 SystemError

## Impact

- **noj-core**: 新增 `src/lib/storage/` 模块（~4 文件）；修改 `services/support-package.ts`、`services/submissions.ts`、`services/problems.ts`、`types/index.ts`
- **noj-judge**: 新增 `reqwest` 依赖；修改 `types.rs`、`sandbox/container.rs`、`judge/runner.rs`、`config.rs`；移除 `get_support_package_bytes()` base64 解码函数
- **noj-ui**: 无变更（上传仍通过后端中转）
- **文档**: 更新 `noj-core/CLAUDE.md` 和 `AGENTS.md` 中的存储路径描述、环境变量表格、目录结构；更新 `README.md` 中关于支持包构建的描述
- **构建脚本**: `scripts/build-packages.ts` 更新输出格式注释；`scripts/seed.ts` 更新硬编码路径格式
- **环境变量**: `noj-core/.env.example` 新增 STORAGE_PROVIDER、S3_ENDPOINT、S3_REGION、S3_ACCESS_KEY、S3_SECRET_KEY、S3_BUCKET、S3_FORCE_PATH_STYLE；`env.e2e.template` 同步新增
- **基础设施**: `docker-compose.yml`、`docker-compose.e2e.yml`、`scripts/e2e/setup.sh`、`.github/workflows/e2e.yml` 增加 MinIO
- **基础设施**: `docker-compose.yml`、`docker-compose.e2e.yml`、`.env.example`、CI E2E workflow 增加 MinIO
- **依赖**: Deno 新增 `@aws-sdk/client-s3`、`@aws-sdk/s3-request-presigner`；Rust 新增 `reqwest`
- **向后兼容**: 非 `storage://` 前缀的旧路径自动视为 local legacy path，透明兼容
