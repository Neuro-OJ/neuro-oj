## Context

当前 Neuro OJ 的支持包（题目测试数据 zip）完全依赖 noj-core 的本地文件系统。提交评测时，zip 被读取 → Base64 编码 → 嵌入 `JudgeTask` JSON → 通过 Redis MQ（`noj:judge:queue`）推送给 noj-judge。此架构的约束：

- **单机绑定**：文件必须存在于 noj-core 可访问的本地磁盘，无法水平扩展
- **消息大小限制**：Redis 消息上限 16MB，Base64 膨胀 ~33%，实际 zip 上限仅 12MB
- **传输效率低**：每次提交都重新读取、编码、传输完整 zip

目标是为生产环境引入 S3 兼容对象存储，同时保持开发环境的简洁性。参考项目中已有的 email provider 模式（`src/lib/email-providers/`，通过 `EMAIL_PROVIDER` 环境变量动态选择实现）。

## Goals / Non-Goals

**Goals:**
- 定义 `StorageProvider` 抽象接口，支持本地文件系统和 S3 兼容存储两种后端
- 统一使用 `storage://` URL 格式标识和定位存储资源
- S3 模式下通过 presigned URL 让 judge 直接 HTTP 下载，消除 Redis MQ 传输瓶颈
- 本地存储模式标记为废弃（dev/test only），启动时输出明确警告
- docker-compose 开发环境包含 MinIO，支持本地开发和测试
- 向后兼容：DB 中已有的本地路径自动识别为 legacy local path

**Non-Goals:**
- 不实现前端直传 S3（前端仍通过后端中转上传）
- 不实现历史文件自动迁移脚本（后续 PR）
- 不变更 DB schema（`support_package_path` 列复用）
- 不改变上传/删除的权限模型
- 不在 noj-ui 中做任何 UI 变更
- 支持包大小上限提高至 **128 MiB**

## Decisions

### 1. Provider 选择模式：环境变量 + 动态 import

**选择**：`STORAGE_PROVIDER=local|s3` 环境变量，工厂函数动态 import 对应模块。

**替代方案**：依赖注入 → 过于复杂，无 DI 容器。编译时 feature flag → Deno 无此概念。

**参考**：项目已有的 `EMAIL_PROVIDER` → `email-providers/{mock,aliyun,tencent}.ts` 模式。

### 2. URL 方案

**选择**：
- Local: `storage://local/<base64>` — 数据自包含，base64 编码直接嵌入 URL
- S3: `storage://s3/<key>` — DB 中统一使用 `storage://` 格式，key 为 S3 object key（如 `packages/123.zip`），bucket 来自配置

**Judge 分派只看 URL 前缀**：`http://`/`https://` → HTTP 下载；`storage://local/` → base64 解码。`storage://s3/` 不会出现在 JudgeTask 中——presigned URL 已转换为 HTTP URL。

**向后兼容**：非 `storage://` 前缀的值由各 provider 自行解释——local provider 视为本地文件路径。

### 3. JudgeTask 传输：单一 URL 字段

**选择**：`JudgeTask` 只包含 `support_package_url`（移除 `support_package_base64`）。

- S3 模式：`presignedUrl()` 返回 presigned HTTPS URL → judge HTTP GET 下载
- Local 模式：`presignedUrl()` 返回 `storage://local/<base64>`（数据自包含在 URL 的 base64 部分中）→ judge 提取 base64 解码
- Judge 根据 URL scheme 区分处理方式：`http://` 或 `https://` → HTTP 下载；`storage://local/` → base64 解码
- 失败直接返回 SystemError（无回退）

**替代方案**：保留 base64 字段做回退 → 字段冗余，judge 需维护两套逻辑入口。

### 4. noj-judge 支持包获取：根据 URL scheme 分派

**选择**：`do_evaluate_with_pool()` 检查 `support_package_url`，根据 URL scheme 分派：

- `http://` 或 `https://` → HTTP 下载（S3 presigned URL）
- `storage://local/` → 提取 base64 解码（数据内嵌在URL中）

两种路径最终都产生 zip 字节数组供解压。失败直接返回 SystemError。

**替代方案**：仅支持 HTTP 下载，local 模式从 core 提供 HTTP 服务 → 增加 unnecessary 网络依赖和鉴权复杂度。self-contained URL 更简单。

### 5. Presigned URL 有效期

**选择**：默认 1 小时（3600 秒），由 `presignedUrl()` 的 `expiresIn` 参数控制。

**权衡**：更长有效期增加安全窗口（URL 泄露风险），更短则 judge 积压时可能过期。1 小时平衡了安全性和可靠性。后续可改为 judge 通过 Redis RPC 实时请求 presigned URL。

### 6. MinIO 部署方式

**选择**：docker-compose 中作为独立服务，使用 `minio/mc` 初始化 bucket。

**替代方案**：应用启动时通过 S3 SDK 创建 bucket → 需要额外 IAM 权限，不符合最小权限原则。专用 init container 更清晰。

## Risks / Trade-offs

| 风险 | 缓解 |
|------|------|
| **Presigned URL 过期**：judge 积压超过 1 小时 | 1 小时 TTL 足够覆盖正常评测；失败后 SystemError 触发 core 重试机制；后续可改为 judge 实时 RPC 请求 URL |
| **S3/MinIO 不可用**：评测功能完全中断 | `ensureBucket()` 为非致命——bucket 创建失败仅 warn，API 仍启动；core 在无法生成 presigned URL 时返回明确错误 |
| **storage://local/<base64> URL 过长**：大文件导致 URL 超长 | 限制支持包 12MB，base64 后 ~16MB——仍在 Redis 16MB 消息上限内；URL 在 Redis 消息中传输，无 HTTP URL 的长度限制问题 |
| **@aws-sdk/client-s3 体积**：增加 Deno 依赖体积 | 仅 noj-core 使用；S3 SDK 的 npm 包 ~8MB，Deno 缓存可接受 |
| **reqwest 增加编译时间**：Rust 项目编译变慢 | 使用 `default-features = false` + `rustls-tls` 最小化依赖树 |
| **Legacy path 兼容性**：DB 中旧路径在新代码中的行为 | `LocalStorageProvider.get()` 对无 `storage://` 前缀的值 fallback 为本地路径读取；`presignedUrl()` 读取文件后编码为 `storage://local/<base64>` |

## Open Questions

1. **Presigned URL 过期后的重试策略**：当前设计依赖 core 重试（judge 返回 SystemError → core 重新创建提交）。是否需要 judge 主动通过 Redis RPC 请求新的 presigned URL？
   - **暂定**：Phase 1 依赖 core 重试；后续 PR 评估 RPC 方案。