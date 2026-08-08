## Why

竞赛运营缺少参赛者提问、主办方答疑的通道：`contest_clarifications` 表已建立（含 `contest_id` / `problem_id` / `sender_id` / `content` / `reply_to_id` / `is_public`），但注释明确"API 将在后续阶段实现"。对标 HydroOJ，答疑（clarification）是竞赛标配功能，当前 issue #225 要求补齐 API 与 UI。

## What Changes

- 新增竞赛答疑 API（挂载于 `/api/v1/contests/:id/`）：
  - `POST /clarifications` — 参赛者提问（可挂竞赛题目或全局提问），仅竞赛进行期间、仅参赛者可提问
  - `POST /clarifications/:clarId/reply` — admin/竞赛创建者回复，支持公开（全员可见）与私密（仅提问者可见）
  - `GET /clarifications` — 答疑列表：参赛者见公开 + 自己的私密；admin/创建者见全部；未参赛者可读公开答疑
- 通知集成：回复时向提问者写入 `community_notifications`（新类型 `clarification`），经现有 `notification:new` SSE 通道推送；通知中心 UI 增加该类型的渲染与跳转
- 数据层迁移：`community_notifications` type CHECK 约束扩展；`contest_clarifications` 增加按竞赛查询索引
- UI：竞赛详情页重构为 Tabs（详情 / 题目 / 答疑 / 排名），新增答疑面板（提问表单 + 公开答疑流 + 私密对话视图 + admin 回复表单）
- 测试：noj-core 单测（权限 / 可见性 / 时间窗口 / 题目归属）+ noj-tests E2E（提问→回复→通知全链路 + 可见性隔离）

## Capabilities

### New Capabilities
- `contest-clarifications`: 竞赛答疑完整能力——提问/回复 API、可见性过滤与权限模型、通知集成、竞赛详情页答疑面板 UI

### Modified Capabilities

（无。`contest_clarifications` 数据模型已存在于 `contest-management` spec；答疑 API 行为全部纳入新能力。通知复用现有 `community_notifications` 表与 SSE 通道，社区通知系统自身行为不变。）

## Impact

- **noj-core**：`src/services/contest-clarifications.ts`（新）、`src/routes/contests.ts`（挂载端点）、`src/services/community.ts`（导出 `createNotification` 并扩展 type）、`src/db/schema.ts`（type CHECK 联合类型）、新迁移（CHECK 扩展 + 索引）
- **noj-ui**：`pages/contests/[contestId]/index.vue`（Tabs 重构）、`pages/contests/[contestId]/ranking.vue`（抽为可复用组件）、新增 `components/feature/contest/ClarificationsPanel.vue`、`pages/community/notifications.vue`（新类型渲染）、`composables/useContests.ts`（API 封装）
- **noj-tests**：新增 `e2e/28_clarifications.test.ts`
- **数据库**：`community_notifications` CHECK 约束变更 + 新索引（仅追加迁移，无破坏性变更）
- **无评测引擎改动**；无新依赖
