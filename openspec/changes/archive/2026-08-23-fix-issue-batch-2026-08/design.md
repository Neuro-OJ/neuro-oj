## Context

当前 NOJ 仓库存在 10 个已上报 issue，涉及编辑器、客观题、私信、导航、题单、社区和个人主页活跃度。多数问题落在现有代码路径上：后端接口已具备部分能力，但前端未展示或交互缺失；另一些（#292、#293、#294）需要先通过测试/复现确认真实根因后再修复。

仓库已使用 OpenSpec 管理规范变更，代码分为 noj-core / noj-ui / noj-judge 三模块。本变更主要影响 noj-core 与 noj-ui，不涉及评测 Worker。

## Goals / Non-Goals

**Goals:**

- 修复 #279、#280、#284、#285、#286、#291、#292、#293、#294、#308 对应问题，使交互闭环。
- 为 #292、#293、#294 先补充复现/回归测试，避免基于猜测修改。
- 保持向后兼容：不破坏现有 API 响应结构，不在无必要情况下新增数据库表。
- 统一 UI 交互风格，减少重复弹窗与“无响应”体验。

**Non-Goals:**

- 不重做私信、社区、题单的整体架构。
- 不新增第三方依赖（如新的 UI 组件库、状态管理库）。
- 不改变评测沙箱与 Judge 逻辑。
- 不实现 #291 中未要求的题单权限/进度统计等进阶功能。

## Decisions

### 1. 草稿清除采用“确认弹窗 + 重置 code + 重新拉模板”

- 现有 `useDraftStorage.clear()` 只删除 localStorage，不清空编辑器内容。
- 决策：`clear()` 内部同时将 `code` 置空、重置 `savedAt/state`；`EditorWorkspace` 的 `@clear-draft` 处理中先 `dialog.confirm`，确认后调用 clear，并复用现有“模板加载”逻辑重新拉取题目默认模板。
- 替代方案：仅删除草稿不重置 code。该方案无法满足 issue 中“立即恢复题目原始版本代码”，故不采用。

### 2. 客观题提交记录直接复用现有历史/详情 API

- 后端 `GET /api/v1/problems/submissions?paper_id=...` 已返回 `answers`、`details`、`score`、`created_at`，`GET /api/v1/problems/submissions/:id` 可获取详情。
- 决策：不新增后端接口，只在 `ObjectiveAnswerForm.vue` 增加“提交记录”折叠区，直接渲染列表数据；竞赛模式沿用后端对 `details` 的裁剪。
- 替代方案：为 UI 单独聚合一个接口，属多余改动，不采用。

### 3. 私信未读计数统一排除自己的消息

- 问题根因是未读 SQL 没有过滤 `sender_id`，自己发的消息也被计入未读。
- 决策：在 `listConversations`、`getUnreadCount`、`getUnreadCountByConversation` 三处 SQL 增加 `AND m.sender_id <> <userId>`。
- 替代方案：前端发送后手工扣除未读数，容易漏掉跨端/刷新场景，不采用。

### 4. 私信前端通过“显式刷新 + SSE 事件”保证侧栏同步

- 发送消息成功后，由父页面调用 `ChatSidebar` 暴露的 `refresh()` 立即刷新会话列表；`markAsRead()` 成功后同样刷新。
- 当前活跃会话收到 `message:new` 时，加载消息后立即 `markAsRead`，避免红点堆积。
- 替代方案：把所有会话列表状态提升到父组件统一管理，改动面更大；先采用暴露 `refresh()` 的最小改动。

### 5. 私信关闭采用“SSE `feature:disabled` 事件 + 前端停止轮询”

- 后端 `/api/v1/conversations/events` 不再被全局 `FEATURE_DISABLED` 中间件直接拒绝；若私信关闭，则发送 `feature:disabled` 事件后正常关闭 SSE 流。
- 前端收到该事件后设置 `messagingDisabled`，停止 SSE/fallback 轮询，只提示一次。
- 替代方案：单纯让前端把 `fetchConversations` 改 silent。这能减少弹窗但不能阻止 3 秒一次的无效轮询，不彻底。

### 6. 导航栏采用 ResizeObserver 动态折叠“更多”

- 在 `Navbar.vue` 中增加 `ResizeObserver` 监听导航容器宽度，计算可容纳的导航项；放不下的移入“更多”下拉（使用 Nuxt UI 的 dropdown/popover）。
- 低于 `md` 断点时仍走现有 `UDrawer` 侧边抽屉。
- 替代方案：仅按 Tailwind 断点分级隐藏，实现简单但不能精确适配不同宽度，且不符合 issue 中“先省略再折叠”的描述；作为备选，不首选。

### 7. 题单编辑 UI 复用现有 `updateTraining`

- 后端 `PUT /api/v1/trainings/:id` 已存在；`TrainingFormModal.vue` 增加 `edit` 模式，支持标题/简介/可见性编辑。
- “我的题单”和题单详情页增加“编辑”入口。
- 后台管理页卡死先补复现测试；若复现则修复，若未复现则用测试锁定当前可用状态。

### 8. #292/#293/#294 先复现/补测试，再决定修复动作

- #292：写服务/路由测试覆盖“创建套卷 → 添加小题 → 拉取列表断言持久化”。
- #293：构造启用社区、有板块、有权限的环境，跑三种类型发帖测试；根据失败点修复。
- #294：直接请求统计接口确认是空数据还是报错；前端改为无条件渲染活跃度卡片，失败/无数据时显示占位与重试。
- 原则：不为了“看起来修了”而改动已正常代码；测试结果作为是否修改的依据。

### 9. 返回按钮统一为图标样式

- 全站“返回”统一使用 `<UIcon name="i-lucide-arrow-left" /> + 文字`，替换 `&larr;`/`←` 字符箭头。
- 涉及 `community/posts/[postId].vue`、`community/bookmarks.vue`、`problems/[id]/edit.vue`、`problems/new/objective.vue`、`problems/new/coding.vue` 等。

## Risks / Trade-offs

- [SSE `feature:disabled` 改动可能影响已连接私信流的清理] → 前端收到事件后必须同时关闭 EventSource 与 fallback timer，并在组件卸载时兜底清理。
- [ResizeObserver 动态折叠可能造成导航跳动] → 对计算过程做防抖，初始渲染先按当前宽度计算，避免 SSR/水合不一致。
- [#292/#293 若测试通过但 issue 现象仍存在] → 保留测试并补充人工复现步骤；不强行改代码，避免引入回归。
- [批量修改涉及多个 spec 文件，任务较大] → 按 issue 分组拆 tasks，每个 task 独立可验证，提交按 issue 拆分。
- [私信未读 SQL 改动影响现有已读语义] → 通过测试覆盖“自己发送不产生未读”“对方发送产生未读”“全部已读归零”三个场景。

## Migration Plan

- 本变更不涉及数据库 schema 变更，无数据迁移。
- 后端接口保持兼容：仅行为修正，不改变响应结构。
- 部署顺序：先合并 noj-core 与 noj-ui 同一 PR；前端依赖后端未读修正与 SSE 事件，需一起上线。
- 回滚策略：若私信/社区出现异常，可回滚对应 commit；无持久化变更，风险低。

## Open Questions

- #293 若复现后根因是“没有默认讨论板块”，是否需要新增板块种子/迁移？目前倾向在修复时补充默认板块或明确提示，等待复现结果确认。
- #286 动态“更多”菜单的展示形式（dropdown / popover / 独立“更多”按钮）可在实现时以 Nuxt UI 现有组件为准，优先 dropdown。