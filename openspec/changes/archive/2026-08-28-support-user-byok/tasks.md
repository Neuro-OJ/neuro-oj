## 1. Gateway 与数据模型

- [x] 1.1 复用 Gateway 现有加密存储和 `llm_providers.created_by`，不重复实现 Core 密钥表。
- [x] 1.2 增加 `submissions.llm_provider_config_id`、外键、索引及 PGlite DDL，生成追加式迁移。
- [x] 1.3 增加用户 Provider 输入/响应类型、归属过滤和稳定错误码。
- [x] 1.4 增加 `NOJ_LLM_BYOK_ALLOWED_HOSTS` 配置模板和安全目标校验。

## 2. 用户 API

- [x] 2.1 实现列表、创建、更新/轮换、删除和连通性测试 API。
- [x] 2.2 校验 Provider 归属、HTTPS、host allowlist、私有地址和字段大小。
- [x] 2.3 确保响应、错误和日志不包含完整 API Key 或 Provider 原始错误 body。

## 3. 提交与 Judge

- [x] 3.1 普通提交保存用户配置 ID，并在创建、重测和 pending 恢复时构造非秘密 `user_llm` 上下文。
- [x] 3.2 Judge 拦截 `request_user_llm_completion`，调用 Gateway 并返回 result/error 帧。
- [x] 3.3 保证 BYOK capability 不转发给 Evaluator，既有 `request_llm_completion` 保持兼容。
- [x] 3.4 增加未绑定配置和安全边界回归测试。

## 4. UI、部署与文档

- [x] 4.1 设置页支持创建、脱敏查看、轮换、测试和删除。
- [x] 4.2 编辑器支持普通题选择 BYOK，未选择时保持原行为，竞赛不启用。
- [x] 4.3 更新 Docker Compose、生产/开发环境模板和文档。
- [x] 4.4 运行格式化、lint、类型检查、构建和模块测试。
- [ ] 4.5 在具备可控 Provider mock 的 Docker 环境中补充跨模块 E2E 门控。
