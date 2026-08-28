# Agent Note: LLM 回放测试

Status: implemented

## Problem

LLM 相关行为依赖真实 API，无 key 时无法测试；有 key 时每次跑真实调用成本高且不稳定。

## Decision

新增录制-回放快照：

- `noj-llm-gateway/tests/replay/fixtures/simple-chat.json`：录制的最小 chat completion fixture。
- `noj-llm-gateway/tests/replay_test.ts`：无 key 可跑，校验 fixture 结构与内容。
- `noj-llm-gateway/scripts/record-replay.ts`：有 `DEEPSEEK_API_KEY` 时调用真实 API 并更新 fixture，无 key 时跳过。
- 新增任务：`deno task test:snapshot` / `deno task test:snapshot:record`。

## Alternatives considered

- 只写 mock 测试：无法验证真实模型响应形状。
- 每次测试都调真实 API：成本高、不稳定、无 key 时 CI 失败。

## Consequences

- 无 key 环境可稳定回放。
- 有 key 环境可一键更新快照，作为真实行为基线。
