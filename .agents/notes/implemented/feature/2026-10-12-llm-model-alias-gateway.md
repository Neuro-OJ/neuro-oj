# Agent Note: gateway 支持 eval_token 模型别名映射（model_map）

Status: implemented

## Problem

逐题选择模型的设计（`dev-docs/superpowers/specs/2026-10-12-llm-model-aliases-design.md`）要求评测代码用「别名」调用，gateway 转发前换成真实模型名。本 PR 是实施拆分的第 1 步，必须先于 core 发布。

## Decision

- eval_token 载荷新增可选 `model_map`（别名 → 上游真实模型名）；`allowed_models` 在带 `model_map` 时是别名列表。
- `routes/llm.ts`：别名通过 `allowed_models` 校验后，按 `model_map` 改写转发请求体的 `model`；映射缺失返回 403 `model_not_allowed`。
- 审计：`llm_usage.model` 记录真实模型名，`request_params.model_alias` 记录别名。
- 无 `model_map` 的 token（所有现存 token）行为逐字节不变。

## Alternatives considered

- 在 gateway 维护别名表：需 gateway 持有平台别名配置，且无法随 token 冻结；token 携带映射天然满足「重测不换模型」。

## Consequences

- 旧 gateway 不识别 `model_map`，故发布顺序必须是先 gateway、后 core。
- 本 PR 单独发布时对线上无可见变化（core 尚未签发 `model_map`）。
