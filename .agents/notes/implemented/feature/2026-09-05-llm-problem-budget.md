# Agent Note: 题目级 LLM 调用/token 预算

Status: implemented

## Problem

题目包此前无法声明单次评测的 LLM 调用次数与 billed token 上限；`eval_token`
始终使用平台默认 `NOJ_LLM_MAX_CALLS` / `NOJ_LLM_MAX_TOKENS`。trial-snowy-manor
在 evaluator 内自行维护本地 LLM 计数与效率分，既与 gateway 的强制额度重复，
也让“题目可配置自己评测预算”的能力缺失。

## Decision

- `LlmConfig` 增加可选 `max_calls` / `max_tokens`，`isValidLlmConfig` 与
  `validateBundleManifest` 做纯值域校验（正整数，缺省允许）。
- 新增 `llm-limits.ts` 集中处理平台默认值：`getDefaultLlmLimits()` 读取环境
  变量；`resolveLlmLimits()` 在签发 `eval_token` 时对题目值做 `Math.min`
  防御；`assertLlmLimitsWithinDefault()` 在 CRUD / bundle 导入写库前拒绝超过
  平台默认的声明。
- 题目上限只经既有 `eval_token` 的 `max_calls` / `max_tokens` 流向
  noj-llm-gateway；不新增 DB 列、不新增 `JudgeTaskLlm` 字段、不向 evaluator
  注入题目预算环境变量。BYOK（`user_llm`）仍使用平台默认。
- noj-judge evaluator SDK 将 HTTP 错误结构化：`LLMError` 携带
  `status_code` / `error_code`，可识别 gateway 的 429 `out_of_usage`。
- noj-ui 题目编辑器增加“调用上限 / Token 上限”两个可选输入，留空不发送键。
- trial-snowy-manor 移除本地 LLM 计数与 LLM 效率分，主谋分从 200 调整为
  250；配额耗尽由 SDK 识别 gateway `out_of_usage` 后置评测失败并判 0 分。

## Alternatives considered

- 新增 MQ / 数据库字段单独传递题目预算：实现直观，但增加跨服务契约与迁移
  成本；既有 `eval_token` 已具备该语义，只需在签发侧填充。
- 让 evaluator / solution 感知题目配额并在本地预检：与 gateway 强制重复，
  且题目实际 billing 口径（billed token）只在 gateway 侧可靠。
- 保留 LLM 效率分并继续本地计数：分数语义复杂化，且与“配额到顶直接 0 分”
  的题目设计目标冲突。

## Consequences

- 出题人可在题目 `llm_config` 或 bundle manifest 中声明单次评测上限；平台默认
  值同时是安全天花板，超限声明在写库前被拒绝。
- 配额耗尽时 gateway 返回 OpenAI 兼容 429 `out_of_usage`，SDK 结构化后由题包
  将评测判为 0 分；evaluator / solution 无需读取题目预算即可得到一致行为。
- trial-snowy-manor 满分结构变为：反驳 5×100 + 主谋 250 + 证据 200 + 理由 50
  = 1000，不再有 `efficiency_score`。
