# 如何提供 LLM 调用能力（运营者）

本页面向运营者/管理员：如何在本实例上提供“LLM 调用能力”，让出题人可以创建
调用真实 LLM API 的题目。

## 总体流程

1. 部署并配置 `noj-llm-gateway`。
2. 在管理后台添加并启用 LLM Provider。
3. 按需配置用户/全局/题目的配额。
4. 确认 Judge Worker 的 evaluator 能访问 gateway。
5. 出题人创建 P 型 LLM 题目并完成评测验证。

出题人侧的接入说明见 [出 LLM 调用题](../problemsetters/llm-problem.md)。

## 1. 部署 noj-llm-gateway

生产环境使用 `docker-compose.prod.yml`：

- 必须设置 `NOJ_LLM_SERVICE_TOKEN`（core↔gateway 服务间鉴权 + eval_token 签发/校验）。
- 必须设置 `NOJ_LLM_STORE_KEY`（加密 Provider API Key）。
- `llm-gateway` 容器加入 `noj-net`，core 通过 `http://llm-gateway:8001` 访问。

由于 `docker-compose.prod.yml` 默认始终启动 `llm-gateway` 且对这两个密钥使用 `${...:?}` 必填校验，**即使不使用 LLM 调用题也必须填写**这两个密钥。

## 2. 创建并启用 Provider

在管理后台「LLM Providers」新增上游 OpenAI 兼容服务：

- 名称：便于识别的显示名。
- Base URL：上游服务地址（如 `https://api.openai.com/v1`）。
- 默认模型：如 `qwen-plus`。
- API Key：仅保存到 gateway，加密存储；列表只显示掩码。
- 费用/1K token：用于用量估算。
- 启用状态：只有 `enabled=true` 的 Provider 才能被 LLM 题目使用。

## 3. 配额（可选）

在「LLM 用量 / 配额」管理能力中，可按用户、全局、题目维度维护
day/month 的 calls/tokens/cost 上限；`0` 表示不限制但仍计数。

## 4. 网络要求

LLM 调用题要求 evaluator 联网访问 gateway：

- `JUDGE_ALLOW_EVALUATOR_NETWORK=true`
- `JUDGE_EVALUATOR_NETWORK` 必须指向 `llm-gateway` 所在 Docker 网络（如 `noj-net`）。
- Solution 容器始终无网，且不注入任何 `NOJ_LLM_*` 环境变量。

## 5. 验证

1. 管理后台确认 Provider 为启用状态。
2. 按出题人文档创建一道 P 型 LLM 题并提交。
3. 在「LLM 用量」页确认调用记录已落库、状态为 `ok`。

## 密钥与安全

- 轮换 `NOJ_LLM_SERVICE_TOKEN` 会让所有未过期 eval_token 失效，需 core 与 gateway 同步更新。
- 轮换 `NOJ_LLM_STORE_KEY` 后需要用新主密钥重新加密所有 Provider Key。
- 真实上游 Key 不会出现在 evaluator 容器、支持包、日志或提交代码中。

更多部署细节见 [生产部署](production-deploy.md) 与
[后台管理指南](admin-guide.md)。
