## Why

Neuro OJ 当前存在一批已上报但尚未修复/未闭环的 issue：编辑器草稿清除无反馈、客观题缺少提交记录展示、私信未读与关闭逻辑异常、导航栏与返回按钮体验不一致、题单/组卷/社区/活跃度等功能存在“看起来已实现但仍有体验缺口”的问题。需要集中修复并补回归测试，避免这些问题在公测中继续影响核心刷题与社区流程。

## What Changes

- **#279 编辑器草稿清除**：`清除当前草稿` 增加确认弹窗；清除后立即清空本地草稿、恢复题目默认模板，并给出成功反馈。
- **#280 客观题提交记录**：在客观题作答页新增“提交记录”列表，展示每次提交时间、得分、逐题答案与正误；竞赛模式遵循后端防泄题规则。
- **#284 私信未读与侧栏刷新**：后端未读计数排除“自己发送的消息”；前端发送/标记已读/收到新消息后即时刷新会话列表与红点。
- **#285 私信关闭体验**：私信功能关闭后，SSE 端点发送一次性 `feature:disabled` 事件并关闭连接；前端停止轮询/SSE，只提示一次“站内私信功能已关闭”。
- **#286 导航栏响应式**：桌面导航在空间不足时优先将多余项收进“更多”下拉，再在窄屏折叠为侧边抽屉；避免导航文字换行/变列。
- **#291 题单管理补全**：新增题单编辑/改名 UI；验证并修复后台题单管理页卡死问题；为“加入题单”交互补回归测试。
- **#292 组卷保存小题**：先补充“创建套卷 → 添加小题 → 刷新后仍在”的回归测试；若复现保存失败则修复，若已可用则用测试锁定现状。
- **#293 社区发帖可靠性**：补发帖链路复现/测试；前端在板块为空、权限不足、功能关闭时给出明确错误提示，避免“点击无响应”。
- **#294 个人主页活跃度**：活跃度卡片在接口失败/无数据时不再整块消失，显示“暂无签到数据”占位与重试；优化展示 UI。
- **#308 返回按钮样式**：统一各页面“返回”为 `UIcon i-lucide-arrow-left` + 文字样式。

## Capabilities

### New Capabilities

- `editor-draft-clear`: 代码编辑器草稿清除交互与反馈（#279）。
- `objective-submission-history`: 客观题提交记录的前端展示（#280）。
- `ui-navigation`: 导航栏响应式折叠与全站返回按钮样式统一（#286、#308）。

### Modified Capabilities

- `private-messaging`: 未读计数排除自己发送的消息；私信关闭时 SSE 发送 `feature:disabled` 事件（#284、#285）。
- `message-ui`: 发送/已读后即时刷新会话列表；私信关闭时停止轮询并一次性提示（#284、#285）。
- `objective-questions`: 明确“套卷创建后添加小题并持久化展示”的回归场景，确保组卷保存闭环（#292）。
- `training-plans`: 前端题单页面增加编辑/改名能力，后台管理页稳定性补测试（#291）。
- `community-content`: 发帖失败/板块为空/权限不足时提供明确错误反馈，避免无响应（#293）。
- `checkin`: 个人主页活跃度卡片在无数据/接口失败时显示占位与重试，不整块隐藏（#294）。

## Impact

- **noj-core**：`services/messages.ts`、`routes/conversations.ts`；`services/community/*`；`services/objective/*`；`services/trainings.ts`；`services/checkin.ts` 及相关测试。
- **noj-ui**：`components/editor/*`、`components/objective/ObjectiveAnswerForm.vue`、`components/layout/Navbar.vue`、`components/feature/ChatSidebar.vue`、`pages/messages/index.vue`、`pages/community/*`、`pages/trainings/*`、`pages/users/[id].vue`、多处返回按钮页面。
- **OpenSpec**：新增 3 个 capability spec，修改 6 个现有 capability spec。
- **测试**：noj-core 服务/路由测试、noj-ui 组件/交互测试、必要时浏览器级复现。