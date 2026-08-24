## 1. 生产配置校验

- [x] 1.1 新增可测试的生产配置校验模块，覆盖邮件 Provider、S3/local、关键密钥占位符、HTTPS APP_URL/CORS 和可信代理，并验证失败信息不包含凭据
- [x] 1.2 将生产配置校验接入 noj-core 启动流程，在 HTTP 监听前 fail-fast；保留 development/test 的 mock/local 行为并通过启动路径测试验证
- [x] 1.3 扩展 `check-env --strict` 或新增生产配置检查命令，支持部署前校验 `.env.prod`，并验证占位符和文件权限提示

## 2. 最小权限对象存储

- [x] 2.1 修改生产 Compose 和环境模板，分离 MinIO root 凭据与 `S3_ACCESS_KEY`/`S3_SECRET_KEY` 应用凭据，并验证 root 凭据不出现在 core 环境
- [x] 2.2 增加 bucket-scoped MinIO policy 文件和幂等初始化逻辑，验证目标 bucket 的读写权限与管理/跨 bucket 权限隔离
- [x] 2.3 更新生产部署和存储文档，说明首次迁移、应用凭据创建、权限验证和旧凭据撤销步骤

## 3. 密钥运维文档

- [x] 3.1 编写 JWT、TFA、数据库、Redis、S3、邮件凭据轮换与失效 Runbook，明确会话失效、TFA 解密和回滚影响
- [x] 3.2 更新生产配置清单和安全说明，验证 secrets manager/受限 secret 文件注入、日志脱敏和 `.env.prod` 权限要求

## 4. 验证

- [x] 4.1 为生产配置校验补充单元测试：合法配置、mock 邮件、local 存储、缺失 Provider 凭据、占位符和不安全 URL
- [x] 4.2 运行 `deno fmt`、`deno lint`、noj-core 测试和生产 Compose config 校验，并验证 MinIO policy 文件语法
- [x] 4.3 完成一次 staging 配置 smoke test 或提供可重复的验证命令，证明应用 S3 凭据能读写目标 bucket 且不能执行管理操作
