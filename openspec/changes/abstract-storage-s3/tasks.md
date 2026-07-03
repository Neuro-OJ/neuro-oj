## 1. StorageProvider 接口与 URL 工具

- [ ] 1.1 创建 `src/lib/storage/types.ts` — StorageProvider 接口（put/get/delete/downloadUrl）、`noj-storage://` 与 `noj-download://` URL 解析工具、URL 层级转换
- [ ] 1.2 创建 `src/lib/storage/local.ts` — LocalStorageProvider（put 计算 SHA-256 并编码 base64、get 解码、downloadUrl 返回 `noj-download://base64/`），首次实例化输出废弃警告
- [ ] 1.3 创建 `src/lib/storage/factory.ts` — `getStorageProvider()` 工厂函数，读取 `STORAGE_PROVIDER` 环境变量
- [ ] 1.4 创建 `src/lib/storage/mod.ts` — 公共导出 barrel
- [ ] 1.5 创建 `tests/lib/storage/url.test.ts` — 两种 URL 空间的解析和转换测试

## 2. S3StorageProvider + JudgeTask 传输改造

- [ ] 2.1 创建 `src/lib/storage/s3.ts` — S3StorageProvider（`@aws-sdk/client-s3` + `@aws-sdk/s3-request-presigner`），put 计算 SHA-256、downloadUrl 生成 presigned URL 并做百分号编码
- [ ] 2.2 在 `deno.json` 添加 `@aws-sdk/client-s3` 和 `@aws-sdk/s3-request-presigner` 导入映射 → `deno install`
- [ ] 2.3 在 `.env.example` 添加 S3 环境变量
- [ ] 2.4 修改 `src/types/index.ts` — JudgeTask 字段 `support_package_base64` → `download_url?: string`
- [ ] 2.5 修改 `src/services/submissions.ts` — 三处（create/rejudge/batchRejudge）调用 `storage.downloadUrl()` 填充 `download_url`
- [ ] 2.6 修改 `src/mq/producer.ts` — 适配新字段名
- [ ] 2.7 创建 `tests/lib/storage/s3.test.ts` — S3StorageProvider 测试（需要 MinIO）

## 3. 支持包服务层改造
- [ ] 3.0 创建 Drizzle 迁移文件：`support_package_path` → `support_package_storage_url`（改名），更新 `src/db/schema.ts`

- [ ] 3.1 修改 `src/services/support-package.ts` — `saveSupportPackage` 调用 `storage.put()` 返回 `noj-storage://` URL；`deleteSupportPackage` 调用 `storage.delete()`
- [ ] 3.2 修改 `src/services/problems.ts` — `deleteProblem()` 使用 `storage.delete()`
- [ ] 3.3 修改 `src/routes/problems.ts` — 上传响应适配 `noj-storage://` URL 格式
- [ ] 3.4 在 `src/main.ts` 添加存储启动逻辑（S3 模式下调用 `ensureBucket()`）
- [ ] 3.5 修改 `scripts/seed.ts` — 更新硬编码路径格式
- [ ] 3.6 修改 `scripts/build-packages.ts` — 更新注释说明
- [ ] 3.7 修改 `tests/services/support-package.test.ts` — 适配 `noj-storage://` URL
- [ ] 3.8 修改 `tests/routes/support-package.test.ts` — 适配新 URL 格式

## 4. noj-judge 改造

- [ ] 4.1 修改 `Cargo.toml` — 添加 `reqwest`（rustls-tls）、`sha2`、`percent-encoding` 依赖
- [ ] 4.2 修改 `src/types.rs` — JudgeTask 字段 `support_package_base64` → `download_url: Option<String>`
- [ ] 4.3 新建 `src/sandbox/download.rs` — HTTP 下载 + 解析 `noj-download://` URL（host 分派 + percent 解码 + base64 解码）
- [ ] 4.4 新建 `src/sandbox/cache.rs` — 支持包磁盘缓存（内容寻址、SHA-256 校验、LRU 淘汰）
- [ ] 4.5 修改 `src/judge/runner.rs` — 通过 `download_url` 获取支持包：缓存命中优先 → 按 host 分派获取 → SHA-256 校验 → 写缓存
- [ ] 4.6 修改 `src/sandbox/container.rs` — 移除 `get_support_package_bytes()`，保留 `extract_zip()`
- [ ] 4.7 修改 `src/config.rs` — 添加 `SUPPORT_PACKAGE_DOWNLOAD_TIMEOUT`、`SUPPORT_CACHE_DIR`、`SUPPORT_CACHE_MAX_ITEMS`、`SUPPORT_CACHE_MAX_MB`

## 5. 文档与环境变量更新

- [ ] 5.1 更新 `noj-core/.env.example` — 新增 `STORAGE_PROVIDER`、`S3_ENDPOINT`、`S3_REGION`、`S3_ACCESS_KEY`、`S3_SECRET_KEY`、`S3_BUCKET`、`S3_FORCE_PATH_STYLE`
- [ ] 5.2 更新 `env.e2e.template` — 同步 S3/MinIO 环境变量
- [ ] 5.3 更新 `noj-core/CLAUDE.md` — 更新存储路径、环境变量表格、API 文档
- [ ] 5.4 更新根 `AGENTS.md` — 明确说明 `noj-storage://`（DB 存储层）和 `noj-download://`（Judge 交付层）两层 URL 概念和各层级格式，更新支持包存储和构建流程的过时描述

## 6. 基础设施

- [ ] 6.1 修改 `docker-compose.yml` — 添加 MinIO + minio-init
- [ ] 6.2 修改 `docker-compose.e2e.yml` — 添加 MinIO
- [ ] 6.3 修改 `.github/workflows/e2e.yml` — 添加 MinIO service
- [ ] 6.4 修改 `scripts/e2e/setup.sh` — E2E 初始化 MinIO bucket

## 7. 验证

- [ ] 7.1 运行 `deno task test` — 所有测试通过
- [ ] 7.2 运行 `cargo test --lib` — noj-judge 编译和测试通过
- [ ] 7.3 本地集成: `STORAGE_PROVIDER=local` — 上传 → 提交 → judge 通过 `noj-download://base64/` 解码
- [ ] 7.4 本地集成: `STORAGE_PROVIDER=s3` + MinIO — 上传 → 提交 → judge 通过 `noj-download://s3` presigned URL 下载
- [ ] 7.5 运行 `NOJ_RUN_E2E=1 deno task test:e2e` — E2E 全链路通过
