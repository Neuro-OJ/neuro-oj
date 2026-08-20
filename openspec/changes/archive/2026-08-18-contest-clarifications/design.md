## Context

竞赛答疑是竞赛运营的标配能力（对标 HydroOJ）。数据模型 `contest_clarifications` 已就绪（`contest_id` / `problem_id`（可空）/ `sender_id` / `content` / `reply_to_id` 自引用 / `is_public` / `created_at`），但无 API 与 UI（issue #225）。

现状：
- 竞赛 API 位于 `routes/contests.ts`（`/api/v1/contests/:id/...`），服务层在 `services/contests.ts`；管理员判定惯例为 `checkPermission(c, "submission:read_all")`，参赛者判定为 `isParticipant()`
- 通知系统：`community_notifications` 表 + `createNotification()`（community.ts 内部私有）+ `publishEvent(Channels.user(id), ...)` SSE 推送；通知中心 UI 在 `pages/community/notifications.vue`，Navbar 经 `useEventSource` 监听 `notification:new` 刷新未读数
- 竞赛详情页 `pages/contests/[contestId]/index.vue` 为单页（公告 + 说明 + 题目列表），无 Tabs 结构；排名为独立页面 `ranking.vue`

约束：无评测引擎改动、无新依赖、纯追加式迁移（社区通知 type CHECK 需扩展）。

## Goals / Non-Goals

**Goals:**
- 参赛者在竞赛进行期间提问（可挂题目或全局）；admin/竞赛创建者公开或私密回复
- 答疑列表按身份过滤：参赛者见公开 + 自己的私密；admin/创建者见全部；未参赛者/匿名仅公开
- 回复时提问者收到持久化通知并经 SSE 实时提醒
- 竞赛详情页提供答疑面板（Tabs 化），通知中心可跳转

**Non-Goals:**
- 回复的回复（对话树）、提问/回复的编辑删除、附件、提问时通知 admin、答疑专用 SSE 频道、赛前/赛后提问
- 不改动现有社区通知系统行为（仅扩展 type 枚举）

## Decisions

### D1. 通知复用 `community_notifications` 表 + 现有 SSE 通道
回复时调用 `createNotification(提问者, 回复者, "clarification", null, null, { contest_id, clarification_id, problem_label, is_public })`。SSE 由现有 `publishEvent(Channels.user(...))` 自动推送，UI 无需新事件类型。

- 需要：`createNotification` 从 community.ts 导出（或提取为 `services/notifications.ts` 公共服务）并扩展 type 联合类型；迁移把 `community_notifications_type_check` 约束改为 `IN ('reply','like','follow','moderation','clarification')`；`notifications.vue` 增加渲染分支（typeLabel/typeIcon/notificationHref → `/contests/{contest_id}?tab=clarifications`）
- 备选（否决）：独立澄清通知表 → 通知中心需双份数据源；仅 SSE 不持久化 → 离线提醒丢失

### D2. 扁平线程模型：回复仅允许指向根提问
回复的 `reply_to_id` MUST 指向一条 `reply_to_id IS NULL` 且属于同一竞赛的提问；服务层校验，拒绝"回复的回复"（400）。列表按"提问（按时间升序）+ 其下回复（按时间升序）"组装。
- 理由：权限模型（仅主办方回复）下多层嵌套无意义；UI 简单（两层缩进）；数据模型自引用天然支持，未来可扩展
- 备选（否决）：任意深度回复树 → UI 与可见性过滤复杂化，YAGNI

### D3. 可见性过滤在服务层单次查询完成
列表查询 `WHERE contest_id = ?` 全量取该竞赛答疑，再按身份过滤组装：
- admin/创建者：全部
- 参赛者：`is_public = true` 或 `sender_id = 自己`（提问）／回复可见性随其根提问的可见范围收缩：公开回复全员可见，私密回复仅根提问者与 admin 可见
- 未参赛/匿名：仅公开问答（提问 + 公开回复）
- 分页基于提问数（回复跟随其根提问，不独立分页），单页上限与现有列表一致
- 理由：答疑量级小（单竞赛通常 < 千条），一次查询 + 内存组装最简单且可完全控制可见性逻辑；不引入 SQL 层 CTE 过滤复杂度

### D4. 回复权限：`isUserAdmin(userId) || contests.created_by === userId`
竞赛创建者可回复自己的竞赛；admin（`admin:full_access`，复用 `isUserAdmin`）可回复任意竞赛。
- 与现有竞赛路由惯例（`checkPermission(c, "submission:read_all")`）的关系：答疑管理权限语义更接近"主办方"，`submission:read_all` 是查看权限的代理，不直接等价；为明确性使用 `isUserAdmin` + `created_by`
- 列表的"admin 见全部"同样按此判定

### D5. 提问语义：提问本身始终公开（`is_public = true`）
参赛者提问进入公开答疑流（避免重复提问，HydroOJ 同款）。`is_public=false` 仅用于主办方的私密回复。
- `problem_id` 可空（全局提问）；非空时 MUST 存在于 `contest_problems`（该竞赛题目），否则 400
- 内容长度限制 5000 字符（与社区评论一致量级），非空校验

### D6. UI：竞赛详情页 Tabs 化 + 答疑面板组件
`index.vue` 重构为 `UTabs`（详情 / 题目 / 答疑 / 排名）：
- tab 状态同步到 `?tab=` query 参数（通知跳转 `/contests/{id}?tab=clarifications` 直达；刷新保持）
- 排名 tab 内嵌现有排名内容（`ranking.vue` 抽为 `components/feature/contest/ContestRanking.vue`，页面文件保留为薄壳以维持 URL 兼容）
- 答疑面板 `components/feature/contest/ClarificationsPanel.vue`：提问表单（running + 参赛者）、线程列表（提问 + 回复缩进，公开/私密标记）、主办方回复表单（公开/私密单选）、`notification:new` 时静默刷新（复用 `useEventSource` 模式）
- 备选（否决）：页面底部区块（答疑流长时体验差）、独立页面（增加路由层级）

### D7. 迁移策略（单次追加迁移）
- `ALTER TABLE community_notifications DROP CONSTRAINT community_notifications_type_check` + 重建含 `'clarification'`
- `CREATE INDEX idx_contest_clarifications_contest ON contest_clarifications (contest_id, created_at)`
- 无破坏性变更；回滚 = 撤销迁移

## Risks / Trade-offs

- [CHECK 约束重建期间短暂锁表] → community_notifications 表量级小，迁移在启动期执行，可接受
- [私密回复可见性泄漏（服务层过滤遗漏）] → 可见性逻辑集中在单一函数并强制单测 + E2E 覆盖（非参赛者 / 其他参赛者不可见）
- [通知 `data` 无外键，答疑删除后通知残留] → 本期无删除功能；通知跳转目标为竞赛答疑 tab，兜底展示"无内容"而非 404
- [index.vue Tabs 重构回归] → 保持 `/contests/:id/ranking` 与 `/contests/:id` 既有 URL 行为；重构后走 UI 检查（deno lint + build）
- [type CHECK 与 TS 联合类型不同步] → `schema.ts` 的 `$type` 与迁移 SQL 同步更新，core 单测覆盖通知创建

## Migration Plan

1. `deno task db:generate` 生成迁移（CHECK 扩展 + 索引），提交迁移文件
2. core 代码（服务/路由/通知导出）与迁移同 PR 合入；启动时自动迁移
3. 回滚：`deno task db:migrate` 无法回退——如出问题，反向手写迁移（重建旧 CHECK + DROP INDEX）后合入修复

## Open Questions

- 无（提问窗口、回复权限、UI 形态已由用户确认；通知跳转与列表分页采用上述默认）
