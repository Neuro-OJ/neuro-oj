# Agent Note: llm-gateway 按 billed-token 计费并返回 out_of_usage

Status: implemented

## Problem

OpenAI 兼容上游（如 DeepSeek）会返回 `usage.prompt_tokens_details.cached_tokens`，
缓存命中的 prompt token 不应计入实际计费。旧实现用
`actual_prompt_tokens + actual_completion_tokens` 结算单次评测 token 计数，
会导致缓存命中越多、评测可用额度被越早错误扣减。同时，评测内 LLM 超限/配额错误
返回普通 `{ error: message }` 结构，选手 agent 无法按 OpenAI SDK 惯例识别
“本次评测额度耗尽”而停止重试。

## Decision

- 新增 `src/billing.ts` 纯函数 `calcBilledUsage`：从上游 usage 提取
  `cached_tokens`，billed prompt = max(0, prompt - cached)，billed total =
  billed prompt + completion；无 usage 时回退估算值。
- `settleUsage` 的 token 增量改为
  `actualBilledTotalTokens - (promptTokens + completionTokens)`，成本也按 billed
  total 计算；`actualPromptTokens`/`actualCompletionTokens` 仅用于审计展示。
- `llm_usage` 新增 `cached_prompt_tokens`、`billed_prompt_tokens`、
  `billed_total_tokens` 三列，迁移追加为 `drizzle/0001_llm_usage_billed_tokens.sql`。
- 所有限流/配额拒绝统一返回 OpenAI 兼容 429：
  `{ error: { message: "Out of usage for this evaluation", type:
  "invalid_request_error", code: "out_of_usage" } }`，便于选手侧识别后停止重试。

## Alternatives considered

- 继续按上游 `total_tokens` 结算：实现最简单，但缓存命中的 token 会被重复扣减，
  与 LLM 服务商计费口径不一致。
- 仅在审计表记录 billed 字段、不改变 Redis 计数：可追溯但评测限额仍不准，
  无法解决“缓存越多越容易提前超限”的核心问题。
- 自定义 JSON 错误码而非 OpenAI 兼容格式：便于内部精确表达，但与选手使用
  OpenAI SDK 的预期不一致，增加 Agent 判错成本。

## Consequences

缓存命中请求会正确释放单次评测 token 额度，使同一预算下可执行更多 LLM 调用；
`llm_usage` 同时保留原始上游 total 与 billed 明细，便于后续成本分析。
超限响应在 OpenAI SDK 中表现为 `out_of_usage`，可以统一被 Agent 模板识别。
注意：本题包（P2/P3）所需的单次评测 `max_calls/max_tokens` 仍来自 eval_token，
暂未接入题目级配置；路由层 fallback completion 为 0，与既有估算逻辑一致。
