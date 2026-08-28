## 1. 请求链路

```text
用户设置 API -> Core -> noj-llm-gateway/internal/providers
用户提交 -> Core 保存 llm_provider_config_id -> JudgeTask.user_llm
Solution -- request_user_llm_completion --> Judge -- eval token --> Gateway -> Provider
Solution <-- result/error ---------------- Judge <---------------- Gateway
```

`request_user_llm_completion` 由 Judge 保留并直接处理，不发送给 Evaluator。JudgeTask、Redis、Docker 环境和 Evaluator 环境只出现 provider ID、模型、Gateway 地址和短期 token；完整 API Key 只在 Gateway 解密后用于 Provider HTTP 请求。

## 2. 数据模型与归属

复用最新 main 已存在的 `llm_providers`：用户 Provider 的 `created_by` 为用户 ID，平台 Provider 为 `"0"`。Gateway 的 `NOJ_LLM_STORE_KEY` 负责密钥 envelope 加密。Core 的 `submissions.llm_provider_config_id` 记录选择结果，并设置 `ON DELETE SET NULL`，删除配置后新的调用不可用。

用户 API 通过 `created_by` 查询参数调用 Gateway 内部 Provider API；Gateway 再次执行归属检查，Core 不信任客户端提供的用户 ID、Provider ID 以外的目标信息。

## 3. Provider 安全边界

用户 Provider 仅允许 HTTPS、无凭据/查询参数的 URL，并且主机必须命中 `NOJ_LLM_BYOK_ALLOWED_HOSTS`；默认值为 `api.openai.com`。禁止本地、环回、链路本地、RFC1918、云元数据地址和非 443 端口。Gateway 使用固定 Chat Completions 路径、Bearer Key 和受限 JSON，禁止重定向，并限制响应大小。

## 4. 错误与生命周期

Gateway 对配置不存在、禁用、配额耗尽、目标拒绝、认证失败、限流和上游错误返回稳定错误码，不透传 Provider 原始错误 body。Judge 将其转换为 capability error 帧。轮换影响后续请求，删除立即阻止新请求；已发出的 Provider 请求不强制取消。

## 5. 回滚

先关闭 UI 提交入口和 BYOK capability，再回滚 Core/Gateway；保留配置和迁移数据，不执行破坏性删除。
