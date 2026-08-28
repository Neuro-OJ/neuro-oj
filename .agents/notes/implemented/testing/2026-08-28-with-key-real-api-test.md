# Agent Note: with-key 真实 API 测试自跳

Status: implemented

## Problem

真实 LLM API 测试需要 key，但没有 key 时 CI 不应失败；同时需要确保有 key 时能跑真实调用。

## Decision

新增 `noj-llm-gateway/tests/real_api_test.ts`：

- 无 `DEEPSEEK_API_KEY` 时测试 `ignore`，CI 保持绿。
- 有 key 时对 `DEEPSEEK_BASE_URL`（默认 `https://api.deepseek.com`）发起一次最小 `chat/completions`，校验 HTTP 200 与 `choices` 非空。

## Alternatives considered

- 不写真实 API 测试：无法发现“单元测试绿、真实产品坏”的问题。
- 用 mock 代替真实 API：只验证桥接，不验证真实模型行为。

## Consequences

- 无 key 环境零成本跳过。
- 有 key 环境可验证真实模型链路，为后续 LLM 回放测试提供基础。
