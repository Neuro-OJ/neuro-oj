## 1. StorageProvider 接口与 URL 工具

- [ ] 1.1 创建 `src/lib/storage/types.ts` — StorageProvider 接口定义、StorageUrl 类型、`parseStorageUrl`/`isStorageUrl`/`buildStorageUrl` 等工具函数
- [ ] 1.2 创建 `src/lib/storage/local.ts` — LocalStorageProvider（put/get 用 base64 编解码到 URL，首次实例化输出中文废弃警告，get 兼容 legacy path），presignedUrl 返回原 URL
- [ ] 1.3 创建 `src/lib/storage/factory.ts` — `getStorageProvider()` 工厂函数（单例模式），读取 `STORAGE_PROVIDER` 环境变量
- [ ] 1.4 创建 `src/lib/storage/mod.ts` — 公共导出 barrel
- [ ] 1.5 创建 `tests/lib/storage/url.test.ts` — URL 解析工具测试
- [ ] 1.6 创建 `tests/lib/storage/local.test.ts` — LocalStorageProvider 测试（base64 编解码、legacy path）

## 2. S3StorageProvider + JudgeTask 传输改造

- [ ] 2.1 创建 `src/lib/storage/s3.ts` — S3StorageProvider（`@aws-sdk/client-s3` + `@aws-sdk/s3-request-presigner`）
- [ ] 2.2 在 `deno.json` 添加 `@aws-sdk/client-s3` 和 `@aws-sdk/s3-request-presigner` 导入映射 → `deno install`
- [ ] 2.3 在 `.env.example` 添加 S3 环境变量
- [ ] 2.4 修改 `src/types/index.ts` — JudgeTask **移除** `support_package_base64`，添加 `support_package_url?: string`
- [ ] 2.5 修改 `src/services/submissions.ts` — 三处（create/rejudge/batchRejudge）统一调用 `storage.presignedUrl()`，仅设置 `support_package_url`
- [ ] 2.6 修改 `src/mq/producer.ts` — 移除 base64 消息大小限制相关逻辑
- [ ] 2.7 创建 `tests/lib/storage/s3.test.ts` — S3StorageProvider 测试（需要 MinIO，检查环境变量跳过）

## 3. 支持包服务层改造

- [ ] 3.1 修改 `src/services/support-package.ts` — `saveSupportPackage` 调用 `storage.put(key, data)`，`deleteSupportPackage` 调用 `storage.delete(url)`，返回/更新 `storage://` URL 或 object key
- [ ] 3.2 修改 `src/services/problems.ts` — `deleteProblem()` 使用 `storage.delete()` 替代 `Deno.remove`
- [ ] 3.3 修改 `src/routes/problems.ts` — 上传响应适配：local 模式返回 `storage://local/<base64>`，S3 模式返回 object key
- [ ] 3.4 在 `src/main.ts` 添加存储启动逻辑（S3 模式下调用 `ensureBucket()`）
- [ ] 3.5 修改 `scripts/seed.ts` — 更新硬编码的 `support_package_path` 格式
- [ ] 3.6 修改 `scripts/build-packages.ts` — 更新注释中的输出格式说明
- [ ] 3.7 修改 `tests/services/support-package.test.ts` — 适配 `storage://` URL 和 object key
- [ ] 3.8 修改 `tests/routes/support-package.test.ts` — 适配新 URL 格式

## 4. noj-judge 改造

- [ ] 4.1 修改 `Cargo.toml` — 添加 `reqwest`（rustls-tls）依赖
- [ ] 4.2 修改 `src/types.rs` — JudgeTask **移除** `support_package_base64`，添加 `support_package_url: Option<String>`
- [ ] 4.3 新建 `src/sandbox/download.rs` — `download_support_package()` HTTP 下载（60s 超时）
- [ ] 4.4 修改 `src/judge/runner.rs` — 支持包获取改为 URL scheme 分派：`http://`/`https://` → reqwest 下载；`storage://local/` → base64 解码
- [ ] 4.5 修改 `src/sandbox/container.rs` — 移除 `get_support_package_bytes()` base64 解码函数，保留 `extract_zip()`
- [ ] 4.6 修改 `src/config.rs` — 添加 `SUPPORT_PACKAGE_DOWNLOAD_TIMEOUT` 配置项

## 5. 文档与环境变量更新

- [ ] 5.1 更新 `noj-core/.env.example` — 新增 `STORAGE_PROVIDER`、`S3_ENDPOINT`、`S3_REGION`、`S3_ACCESS_KEY`、`S3_SECRET_KEY`、`S3_BUCKET`、`S3_FORCE_PATH_STYLE`
- [ ] 5.2 更新 `env.e2e.template` — 同步添加 S3/MinIO 环境变量（E2E 中设为 `STORAGE_PROVIDER=s3`）
- [ ] 5.3 更新 `noj-core/CLAUDE.md` — 修改目录结构、环境变量表格、API 文档中的存储相关过时描述
- [ ] 5.4 更新根 `AGENTS.md`（即 `CLAUDE.md`） — 更新支持包存储路径和构建流程的过时描述

## 6. 基础设施

- [ ] 6.1 修改 `docker-compose.yml` — 添加 MinIO 服务（端口 9000/9001）+ `minio-init`（bucket 创建）
- [ ] 6.2 修改 `docker-compose.e2e.yml` — 添加 MinIO 服务 + bucket 初始化
- [ ] 6.3 修改 `.github/workflows/e2e.yml` — 添加 MinIO service container，设置 `STORAGE_PROVIDER=s3`
- [ ] 6.4 修改 `scripts/e2e/setup.sh` — E2E 启动后初始化 MinIO bucket

## 7. 验证

- [ ] 7.1 运行 `deno task test` — 所有现有测试通过 + 新 storage 测试通过
- [ ] 7.2 运行 `cargo test --lib` — noj-judge 编译和单元测试通过
- [ ] 7.3 本地集成验证: `STORAGE_PROVIDER=local` — 上传支持包 → 创建提交 → judge 通过 `storage://local/<base64>` 解码
- [ ] 7.4 本地集成验证: `STORAGE_PROVIDER=s3` + MinIO — 上传支持包 → 创建提交 → judge 通过 presigned URL 下载
- [ ] 7.5 运行 `NOJ_RUN_E2E=1 deno task test:e2e` — E2E 全链路通过
