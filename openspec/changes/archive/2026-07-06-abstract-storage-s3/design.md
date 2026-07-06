## Context

当前 Neuro OJ 的支持包（题目测试数据 zip）完全依赖 noj-core 的本地文件系统。提交评测时，zip 被读取 → Base64 编码 → 嵌入 `JudgeTask` JSON → 通过 Redis MQ（`noj:judge:queue`）推送给 noj-judge。此架构的约束：

- **单机绑定**：文件必须存在于 noj-core 可访问的本地磁盘，无法水平扩展
- **消息大小限制**：Redis 消息上限 16MB，Base64 膨胀 ~33%，实际 zip 上限仅 12MB
- **传输效率低**：每次提交都重新读取、编码、传输完整 zip

目标是为生产环境引入 S3 兼容对象存储，同时保持开发环境的简洁性。参考项目中已有的 email provider 模式（`src/lib/email-providers/`，通过 `EMAIL_PROVIDER` 环境变量动态选择实现）。

## Goals / Non-Goals

**Goals:**
- 定义 `StorageProvider` 抽象接口，支持本地文件系统和 S3 兼容存储两种后端
- 定义 `noj-storage://` 和 `noj-download://` 两种 URL 空间，分离持久存储与 Judge 交付
- S3 模式下通过 presigned URL 让 judge 直接 HTTP 下载，消除 Redis MQ 传输瓶颈
- 本地存储模式标记为废弃（dev/test only），启动时输出明确警告
- `download_url` 自包含 `checksum_sha256`，judge 无需额外字段即可缓存和校验
- docker-compose 开发环境包含 MinIO，支持本地开发和测试
- 向后兼容：DB 中已有的本地路径自动识别为 legacy local path

**Non-Goals:**
- 不实现前端直传 S3（前端仍通过后端中转上传）
- 不实现历史文件自动迁移脚本（后续 PR）
- DB schema 变更：`support_package_path` 重命名为 `support_package_storage_url`
- 不改变上传/删除的权限模型
- 不在 noj-ui 中做任何 UI 变更
- 支持包大小上限提高至 **128 MiB**

## Decisions

### 1. Provider 选择模式：环境变量 + 动态 import

**选择**：`STORAGE_PROVIDER=local|s3` 环境变量，工厂函数动态 import 对应模块。

**替代方案**：依赖注入 → 过于复杂，无 DI 容器。编译时 feature flag → Deno 无此概念。

**参考**：项目已有的 `EMAIL_PROVIDER` → `email-providers/{mock,aliyun,tencent}.ts` 模式。

### 2. 两层 URL 空间

**选择**：

**`noj-storage://`**（DB 持久存储层）：
- `noj-storage://local/<base64>?checksum_sha256=<hex>`
- `noj-storage://s3/<key>?checksum_sha256=<hex>`

**`noj-download://`**（Judge 交付层）：
- `noj-download://base64/?content=[base64]&checksum_sha256=<hex>` — 内嵌 base64
- `noj-download://s3?url=[percent-encoded-presigned-URL]&checksum_sha256=<hex>` — 远程 URL

URL 嵌套处理：S3 presigned URL 本身是 HTTP URL，嵌入 `noj-download://s3?url=...` 时必须做 percent-encoding（RFC 3986），避免 query 参数歧义。

**向后兼容**：非 `noj-storage://` 前缀的值由各 provider 自行解释——local provider 视为本地文件路径。

### 3. JudgeTask 传输：`download_url` 单一字段

**选择**：JudgeTask 用 `download_url` 替代 `support_package_base64`（字段更名）。

- `download_url` 是 `noj-download://` URL，完全自包含：
  - 下载方式（scheme host 决定）
  - 数据内容（base64 模式）或远程地址（s3 模式）
  - 完整性校验哈希 `checksum_sha256`
- 无独立 `checksum_sha256` 字段——信息编码在 URL 中
- `StorageProvider.downloadUrl()` 负责将 `noj-storage://` 转换为 `noj-download://`

### 4. noj-judge 支持包获取：noj-download:// 分派

**选择**：`do_evaluate_with_pool()` 检查 `download_url`，根据 host 分派：

- `noj-download://base64/` → 提取 `content` 和 `checksum_sha256`，base64 解码，校验哈希
- `noj-download://s3` → 提取 `url`（percent 解码）和 `checksum_sha256`，HTTP 下载，校验哈希

两种路径最终都产生 zip 字节数组供解压。失败直接返回 SystemError。

### 5. 支持包缓存（按内容寻址）

**选择**：noj-judge 侧基于 `checksum_sha256` 的磁盘缓存。

- 缓存文件：`{SUPPORT_CACHE_DIR}/{checksum_sha256}.zip`
- 每次获取后 SHA-256 校验通过才写入缓存
- 校验失败时清理本次写入（防止缓存中毒）
- 缓存目录通过 `SUPPORT_CACHE_DIR` 配置（默认 `/tmp/noj-judge/support-cache`）
- LRU 淘汰：超出 `SUPPORT_CACHE_MAX_ITEMS`（500）或 `SUPPORT_CACHE_MAX_MB`（2048）时删除 `atime` 最旧的文件
- 无 `checksum_sha256` 时跳过缓存（向后兼容）

### 6. Presigned URL 有效期

**选择**：默认 1 小时（3600 秒），由 `downloadUrl()` 的 `expiresIn` 参数控制。

### 7. MinIO 部署方式

**选择**：docker-compose 中作为独立服务，使用 `minio/mc` 初始化 bucket。

### 8. 下载端点说明

`GET /api/v1/problems/:id/support-package` **始终通过 noj-core 代理**返回文件内容，不对外暴露 S3 presigned URL。原因：S3/MinIO 可能部署于内网，用户浏览器无法直接访问。

## URL 层级概览

| 层级 | local 模式 | S3 模式 |
|------|-----------|---------|
| **DB 存储** (`support_package_storage_url`) | `noj-storage://local/<base64>?checksum_sha256=...` | `noj-storage://s3/<key>?checksum_sha256=...` |
| **Judge 交付** (`download_url`) | `noj-download://base64/?content=[base64]&checksum_sha256=...` | `noj-download://s3?url=[encoded-presigned-URL]&checksum_sha256=...` |

## Risks / Trade-offs

| 风险 | 缓解 |
|------|------|
| **Presigned URL 过期**：judge 积压超过 1 小时 | 1 小时 TTL 足够覆盖正常评测；失败后 SystemError 触发 core 重试机制 |
| **S3/MinIO 不可用**：评测功能完全中断 | `ensureBucket()` 为非致命——bucket 创建失败仅 warn；core 无法生成 download_url 时返回明确错误 |
| **URL 嵌套歧义**：presigned URL 嵌入 `noj-download://` query 参数 | 统一 percent-encoding（RFC 3986）解决嵌套问题 |
| **@aws-sdk/client-s3 体积**：增加 Deno 依赖体积 | 仅 noj-core 使用，Deno 缓存可接受 |
| **reqwest 增加编译时间**：Rust 项目编译变慢 | 使用 `default-features = false` + `rustls-tls` 最小化 |
| **Legacy path 兼容性**：DB 中旧路径在新代码中的行为 | `LocalStorageProvider.get()` 对无 `noj-storage://` 前缀的值 fallback 为本地文件路径 |
