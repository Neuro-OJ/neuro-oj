# Agent Note: AI 评测可视化反馈（LLM Trace、分项雷达图与 Badcase 对比）

Status: implemented

## Problem

AI 工程题评测完成后，`noj-ui` 提交详情页仅展示总分与基础测试点表格；`noj-llm-gateway` 的 `llm_usage` 表已记录 Token、估算成本与单步调用延迟，但尚未按提交/评测尝试聚合下发，做题人缺少分项能力维度与 Badcase 对比反馈。

## Decision

1. **`noj-llm-gateway`**：新增 `GET /internal/usage/submission-summary`（`src/usage-summary.ts`），按 `submission_id`/`attempt_id` 聚合统计（含 P95 延迟与模型分布）与带 `offset_ms` 的时间线；默认不查询 `request_messages`，传 `include_messages=1` 时做字段裁剪、密钥脱敏与截断。
2. **`noj-core`**：按功能切片规范新建 `src/features/evaluation-feedback/` 并在 `src/features.ts` 装配，暴露 `GET /api/v1/domains/:slug/submissions/:id/feedback` 与 `GET /api/v1/domains/:slug/self-tests/:id/feedback`。严格遵循 `result_visibility` 门控并过滤隐藏测试点，普通正式提交默认不返回 `request_messages`；Gateway 不可用时优雅降级返回 `gateway_available: false`。
3. **`noj-ui`**：新增零外部依赖纯 SVG 雷达图 `MetricRadarChart.vue`、LLM 调用瀑布流 `LlmTraceTimeline.vue`、左右分栏行级 Diff 面板 `BadcaseComparison.vue` 与整合面板 `AiFeedbackPanel.vue`，接入正式提交与自测详情页。

## Alternatives considered

- **在 `noj-ui` 引入 ECharts 等重型图表库**：会增大前端构建体积并偏离 Nuxt UI + Tailwind 设计 Token；采用纯 SVG 雷达图保持轻量与视觉一致。
- **直接复用提交列表接口携带全量 Trace**：会拖慢列表与首屏加载；拆分为独立的 `evaluation-feedback` 切片按需获取并支持隔离降级。

## Consequences

- `noj-core` 边界检查（`check-feature-boundaries.ts` 与 `check-module-boundaries.ts`）零违规。
- 隐藏测试点用例与正式提交消息内容默认受防作弊门控保护，不会经反馈接口泄露。
