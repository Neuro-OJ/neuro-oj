# 如何提供 LLM 调用能力（运营者）

本页面向运营者/管理员：如何在本实例上提供“LLM 调用能力”，让出题人可以创建
调用真实 LLM API 的题目。

> 若只需**能提交 LLM 题**，关键就三步：gateway 两个密钥就位 → 后台建一个启用
> 的 Provider → 配齐平台默认 `provider_id` + `model`。缺任一项，LLM 题提交会
> 以 400 失败。

## 总体流程

1. 部署并配置 `noj-llm-gateway`。
2. 在管理后台添加并启用 LLM Provider。
3. 配置平台默认 Provider 与模型（`llm_default_provider_id` /
   `llm_default_model`）。
4. 按需配置用户/全局/题目的配额。
5. 确认 Judge Worker 的 evaluator 能访问 gateway。
6. 出题人创建 P 型 LLM 题目并完成评测验证。

出题人侧的接入说明见 [出 LLM 调用题](../problemsetters/llm-problem.md)。

## 1. 部署 noj-llm-gateway

生产环境使用 `docker-compose.prod.yml`：

- 必须设置 `NOJ_LLM_SERVICE_TOKEN`（core↔gateway 服务间鉴权 + eval_token
  签发/校验，≥16 字符）。
- 必须设置 `NOJ_LLM_STORE_KEY`（加密 Provider API Key，≥16 字符）。
- `llm-gateway` 容器加入 `noj-net`，core 通过 `http://llm-gateway:8001` 访问。

::: warning 即使不做 LLM 题也必须填这两个密钥
`docker-compose.prod.yml` 默认**始终启动** `llm-gateway` 且对这两个密钥使用
`${...:?}` 必填校验，缺失会导致 `docker compose config` 直接报错。
:::

网关分钟限流可通过环境变量调整：

- `NOJ_LLM_USER_RATE_LIMIT_PER_MINUTE`：每个用户在 UTC 分钟窗口内的调用上限。
- `NOJ_LLM_IP_RATE_LIMIT_PER_MINUTE`：每个 IP 在 UTC 分钟窗口内的调用上限。
- 两项均为可选正整数，默认均为 `60`；配置缺失不会改变既有行为。
- 配置在网关启动时读取，修改后需重启 `llm-gateway`；非法值会导致启动失败。

## 2. 创建并启用 Provider

在管理后台「LLM Providers」新增上游 OpenAI 兼容服务：

- 名称：便于识别的显示名。
- Base URL：上游服务地址（如 `https://api.openai.com/v1`）。
- API Key：仅保存到 gateway，加密存储；列表只显示掩码。
- 费用/1K token：用于用量估算。
- 启用状态：只有 `enabled=true` 的 Provider 才能被 LLM 题目使用。

> Provider 不再自带默认模型；调用哪个模型由下一节的平台默认决定。

## 3. 配置平台默认 Provider 与模型

题目不再携带 Provider / 模型，改用平台级全局默认。在管理后台 「系统设置 →
LLM」中配置以下两项 **runtime 设置**（写库即时生效，无需重启）：

| 设置键                    | 说明                                          |
| ------------------------- | --------------------------------------------- |
| `llm_default_provider_id` | 上一节创建的 Provider ID（gateway 内部 UUID） |
| `llm_default_model`       | 调用的模型名，如 `qwen-plus`（必须显式填写）  |

- **两项必须同时配置，无回退**：缺任一项时，LLM 题目的提交会被拒绝（400）。
- 部署者也可用 env 兜底 `NOJ_LLM_DEFAULT_PROVIDER_ID` /
  `NOJ_LLM_DEFAULT_MODEL`；DB 值优先，env 仅在 DB 未写入时生效。
- 修改这两项即可让**全部** LLM 题统一切换 Provider 或模型，无需逐题调整。

## 4. 配额（可选）

配额通过管理端接口维护（`GET/POST /api/v1/admin/llm/quotas`）：可按用户、全局、
题目，以及**用户×题目组合**维度维护 day/month 的 calls/tokens/cost 上限；
`0` 表示不限制但仍计数。

用户×题目组合维度（`scope_type=user_problem`，`scope_id` 形如
`<userId>:<problemId>`）用于防止一名选手反复提交打满**全选手共享**的题目日桶，
导致他人 LLM 题评测因 `out_of_usage` 得 0 分。默认兜底值见网关 `.env.example` 的
`NOJ_LLM_DEFAULT_USER_PROBLEM_*`（网关**启动期读取 env**，改动后需重启网关；`llm_quotas` 里的
占位行按 `scope_id=''` 写入，与 `<userId>:<problemId>` 精确匹配不上，不参与限额计算——
需要单条覆盖时请写 `scope_id` 为具体组合的行）。

分钟维度限流对无客户端 IP 的评测流量（Evaluator 直连网关、无
`X-Forwarded-For`）按 submission 隔离，不再共用全局 `unknown` 桶。

## 5. 网络要求

LLM 调用题要求 evaluator 联网访问 gateway：

- `JUDGE_ALLOW_EVALUATOR_NETWORK=true`
- `JUDGE_EVALUATOR_NETWORK` 必须指向 `llm-gateway` 所在 Docker 网络（如
  `noj-net`）。
- Solution 容器始终无网，且不注入任何 `NOJ_LLM_*` 环境变量。

## 6. 验证

1. 管理后台确认 Provider 为启用状态，且「系统设置 → LLM」两项平台默认已填写。
2. 按出题人文档创建一道 P 型 LLM 题并提交。
3. 在「LLM 用量」页确认调用记录已落库、状态为 `ok`。

## 密钥与安全

- 轮换 `NOJ_LLM_SERVICE_TOKEN` 会让所有未过期 eval_token 失效，需 core 与
  gateway 同步更新。
- 轮换 `NOJ_LLM_STORE_KEY` 后需要用新主密钥重新加密所有 Provider Key。
- 真实上游 Key 不会出现在 evaluator 容器、支持包、日志或提交代码中。

更多部署细节见 [生产部署](production-deploy.md) 与
[后台管理指南](admin-guide.md)。
