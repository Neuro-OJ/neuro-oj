## Why

NOJ 已有 `noj-llm-gateway` 负责 Provider 密钥加密、模型调用、限流和用量记录，但普通用户还不能安全地管理自己的模型配置。BYOK 需要复用该服务，避免在 Core、Judge 或 Evaluator 中复制密钥存储与 Provider 适配逻辑。

## What Changes

- 在现有 `llm_providers` 表上增加用户归属能力，用户可创建、查看、轮换、删除和测试自己的 OpenAI-compatible Provider。
- Core 增加认证后的用户管理 API；Gateway 继续负责密钥加密和 Provider 请求。
- 提交保存用户 Provider 配置 ID，JudgeTask 只携带短期 eval token 和非秘密模型上下文。
- Judge 保留 `request_user_llm_completion` capability，直接调用 Gateway，并保证请求不转发给 Evaluator。
- 编辑器支持在普通编程题提交时选择 BYOK；竞赛提交保持原有行为。
- 增加出站 host allowlist、HTTPS、大小/超时/错误码保护，以及配置和部署文档。
- 未选择 BYOK 时，现有平台 LLM 与普通 Evaluator capability 行为保持兼容。

## Capabilities

### New Capabilities

- `user-byok-credentials`：用户级 Provider 配置、归属校验、脱敏展示和生命周期。
- `user-llm-gateway`：通过现有 LLM Gateway 安全调用用户 Provider。

### Modified Capabilities

- `network-capability`：增加 `request_user_llm_completion` 保留 capability，明确不经过 Evaluator。

## Impact

- `noj-core`：用户 API、提交绑定字段、JudgeTask 构造和 Gateway 管理客户端。
- `noj-llm-gateway`：BYOK Provider 归属过滤、目标地址校验、删除/测试 API 和错误清洗。
- `noj-judge`：保留 capability 拦截和 Gateway 结果转换；不注入密钥环境变量。
- `noj-ui`：设置页配置管理和编辑器提交选择。
- Docker Compose、环境模板、迁移和用户文档同步更新。

## Compatibility

本变更复用 `llm_providers.created_by` 和 `NOJ_LLM_STORE_KEY`。平台 Provider 使用 `created_by = "0"`，用户 Provider 使用用户 ID；不新增重复的 Core 密钥表，也不引入 `BYOK_ENCRYPTION_KEY`。
