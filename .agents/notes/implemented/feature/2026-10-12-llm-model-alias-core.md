# Agent Note: core 支持 LLM 模型别名（逐题选择模型）

Status: implemented

## Problem

2026-09-21 解耦后全部 LLM 题只能用平台默认模型，无法逐题选择。设计见 `dev-docs/superpowers/specs/2026-10-12-llm-model-aliases-design.md`；本 PR 是实施拆分第 2 步（须在 gateway `model_map` 发布之后）。

## Decision

- 新表 `llm_model_aliases`（别名 → provider_id + 真实模型 + 说明），迁移 `0114`；`default` 为保留别名，恒等于平台默认设置，不入表。选表而非系统设置：设置注册表不支持 JSON。
- `llm_config.models: string[]`（1–8 个别名，格式 `^[a-z][a-z0-9_-]{0,31}$`，可选，缺省 `["default"]`）；题包 manifest 的 `llm.models` 同形，noj-cli 契约副本同步。
- `buildJudgeTaskLlm`：default-only 保持旧形态（`allowed_models` 为真实模型名、无 `model_map`）；使用别名时 `allowed_models` 为别名，token 与 `JudgeTaskLlm` 携带 `model_map`。别名解析要求同属一个 Provider，否则 400。
- 冻结快照 `FrozenLlmExecution.models` 记录别名→真实模型，重派 / 重测不重新解析；无该字段的旧快照按单个 default 处理。
- 校验：题目保存、发布（content-security）严格校验别名存在且同 Provider；题包导入对未配置别名放行，已存在的别名仍检查跨 Provider；提交时兜底 400。
- API：管理端 `GET/PUT/DELETE /api/v1/admin/gateway/llm/model-aliases[/:alias]`（删除被引用别名返回 409，`?force=true` 强删；写入审计）；出题人 `GET /api/v1/problems/llm-model-aliases` 只返回别名与说明，不含 Provider 与真实模型。

## Alternatives considered

- 别名存系统设置（JSON）：注册表无 JSON 类型且 text 上限 1000 字符；否决。
- `model_map` 不进 `JudgeTaskLlm`、由快照构造器再查别名表：与签发之间存在竞态，且需异步化 `executionSnapshot`；否决。

## Consequences

- 须先发布 gateway（#630），再发布本 PR，否则旧 gateway 会把别名原样转发给上游。
- UI（别名管理卡片、出题多选）与文档在后续 PR。
- 管理员事后改别名映射只影响新建尝试；已冻结尝试 / 重测不变。
