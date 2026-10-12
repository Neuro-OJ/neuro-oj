# Agent Note: LLM Provider 管理页新增「测试连接」

Status: implemented

## Problem

运营者在「LLM → Provider 管理」新增 Provider 后，没有办法确认 Base URL / API Key / 模型是否可用，只能配好平台默认后实际提交一道 LLM 题，再去「LLM 用量」查看是否报错。

gateway 早已实现 `POST /internal/providers/:id/test`（`testProviderConnection`，以 `max_tokens: 1` 请求上游 `/chat/completions`），但 core 没有对应的管理端路由，前端也没有入口，生产环境 `/internal/*` 不对外暴露，等于不可用。

## Decision

- noj-core 新增 `POST /api/v1/admin/gateway/llm/providers/:id/test`（`domains/admin/routes/gateway.ts`），body `{ model }` 必填，透传 gateway 测试接口（`domains/gateway/services/llm.ts` 的 `testLlmProvider`）。
- 上游类失败（`provider_auth_failed` / `provider_rate_limited` / `provider_unavailable` / `provider_error` / `provider_base_url_blocked`）是测试的**正常结果**：以 200 + `{ status: "failed", code, message }` 返回中文原因，而不是经 `mapLlmError` 统一变成 503「模型服务暂时不可用」（那样管理员无法区分 Key 错误与网络问题）。
- Provider 不存在（404）、gateway 不可用（503）、缺少模型（400）仍走原有错误映射。
- 响应附带 `latency_ms`（core 侧计时，含 core→gateway 开销）。
- 前端 `providers.vue` 操作列新增「测试连接」按钮，打开抽屉填写模型（默认带出平台默认模型），展示成功/失败、耗时、错误码与原因。
- 测试不写审计日志：不修改任何配置。

## Alternatives considered

- **新增/编辑表单内"先测试再保存"**：需要 gateway 支持用未保存的明文 Key 测试，Key 会多一条传输路径；现有接口只测已保存的 Provider，安全面更小。
- **测试时不要求模型、使用平台默认模型**：新 Provider 往往尚未设为默认，且不同 Provider 模型名不同，仍需可手填；前端以平台默认模型作为初始值兼顾两者。

## Consequences

- 每次测试会向上游发起一次真实请求，产生极少量费用；文档已注明。
- 本地验证（2026-10-12，SiliconFlow `Qwen/Qwen3-8B`）：有效 Key → ok（约 6s）；不存在的模型 → `provider_error`；无效 Key → `provider_auth_failed`；空模型 → 400。
