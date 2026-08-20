## Context

管理后台 `/admin` 共 13 个页面，当前全部为"登录时一次性加载 + 手动刷新"，没有任何轮询或 SSE 自动更新机制；而普通用户侧（`pages/queue.vue` 使用 SSE + 2s fallback 轮询、`pages/submissions/[id].vue` 使用 1.5s 轮询、`Navbar.vue` 使用 SSE）均有实时机制。审查发现后台还存在 4 个确定的功能性 bug（`admin/submissions.vue` 下拉空白、`categories.vue`/`judge-images.vue` 按钮文本字面量、`roles.vue` 系统角色可删除、`problem-new.vue` 缺 admin 守卫）、黑名单 100 条硬编码上限、community 待审列表无分页、多处交互反馈缺失。

技术基础：Nuxt 4 + Vue 3 + @nuxt/ui（UTable）。`useAdminList` 已封装分页/搜索（300ms 防抖）/`requestVersion` 防竞态；`useSubmissionPolling` 提供了"轮询 + 终态自动停止"的既有模式可参照。后端接口已具备所需能力：`GET /api/v1/admin/blacklist?page=&per_page=&keyword=`（分页 + 模糊搜索，`noj-core/src/routes/admin.ts:449-459`）、`GET /api/v1/problems?keyword=`（`noj-core/src/routes/problems.ts:85-86`）。

## Goals / Non-Goals

**Goals:**
- 修复 4 个确定的功能性 bug
- 建立通用轮询 composable（`usePolling`），为动态数据页面补自动更新：仪表盘队列统计、admin 提交列表、用户封禁状态、竞赛状态、社区待审
- 黑名单分页化（移除 100 条硬编码）、community 待审/举报分页 + 搜索防抖、problems 列表补搜索
- 补齐交互反馈：保存/删除错误处理、编辑 loading 态、删除后服务端重载、刷新防空页

**Non-Goals:**
- 不引入 SSE 或后端改动（轮询复用现有 REST 端点，后端零改动）
- 不重做后台整体 UI/布局/主题
- 不实现表格排序（后端接口普遍不支持 sort 参数，属另一变更）
- 不处理 `contest-edit/` 空目录（竞赛编辑走 `ContestFormModal.vue` 弹窗，非本次范围）

## Decisions

### D1: 自动更新采用"轮询"而非 SSE
- **选择**：通用 `usePolling` composable 驱动的前端轮询。
- **理由**：现有 SSE（`useEventSource`）面向后端已发布的公开频道（评测事件等），admin 数据没有对应事件源，引入 SSE 需后端新增频道/订阅机制，超出本次"前端修复"范围；轮询复用全部现有 REST 端点，与 `useSubmissionPolling` 既有模式一致，改动面最小。
- **备选**：SSE 事件推送（更实时、省带宽）→ 需要 noj-core 新增 admin 事件发布，成本高，留作后续优化。

### D2: 通用 `usePolling` composable 的行为契约
```ts
usePolling({
  intervalMs: MaybeRefOrGetter<number | null>, // null = 关闭轮询；支持动态变化（用户切换间隔时即时生效）
  fetcher: () => Promise<void> | void,  // 每次轮询执行（内部自行静默）
  immediate?: boolean,         // 是否立即执行一次
  stopWhen?: () => boolean,    // 返回 true 时自动停止
  active?: Ref<boolean>,       // 外部可暂停（如登录态）
})
```
行为：
- `setInterval` + `onUnmounted` 清理；页面隐藏（`visibilitychange`）时暂停、可见时恢复（浏览器对后台 tab 的 timer 节流不可靠，显式暂停更干净且省请求）
- 防重入：上一轮 `fetcher` 未完成则跳过本轮
- `intervalMs` 为响应式源：变化时重置定时器，变为 `null` 时停止（支持下拉框切换关闭）
- 返回 `{ start, stop, isPolling }` 供页面控制（如提交列表"全终态后停止"）

### D3: `useAdminList` 扩展 `polling` 选项
```ts
useAdminList<T>({ ..., polling?: { intervalMs: number; stopWhen?: () => boolean } })
```
- 轮询复用内部 `load()` 的静默模式（不置 `loading`，避免列表闪烁），沿用 `requestVersion` 防竞态——轮询响应不会覆盖用户刚触发的搜索/分页结果
- `stopWhen` 示例：admin 提交列表所有行均为终态（finished/error）时停止，出现新 pending 行（重测）后由页面重新 `start()`

### D4: 各页面默认轮询间隔（可由刷新控制条覆盖）
| 页面 | 数据 | 默认间隔 | 停止条件 |
|------|------|----------|----------|
| admin/index.vue | 评测队列统计（含 pending/judging） | 5s | 无（页面卸载即停） |
| admin/submissions.vue | 提交列表 | 3s | 全部行终态 |
| admin/users.vue | 用户列表（封禁 badge） | 30s | 无 |
| admin/contests.vue | 竞赛状态/人数 | 30s | 无 |
| admin/community.vue | 待审/举报数 | 30s | 无 |

间隔取舍：队列与提交是高变化数据用短间隔；用户/竞赛/社区为低频变化用 30s，控制 API 负载。上表为各页默认值，管理员可通过刷新控制条下拉框覆盖或关闭。

### D8: 刷新控制条 `RefreshControl.vue`
所有启用自动刷新的 admin 页面统一使用刷新控制条（纯 UI 组件，位于 `components/admin/RefreshControl.vue`，轮询逻辑由页面经 `usePolling` 管理，组件不持有数据）：

- **间隔选择下拉框**：`USelectMenu`，items 为 `关闭 / 5 秒 / 10 秒 / 30 秒 / 1 分钟`（`value: number | null`），`v-model` 绑定页面传入的 `intervalRef`；切换后 `usePolling` 响应式重置定时器，即时生效
- **手动刷新按钮**：`UButton` + `i-lucide-refresh-cw`（刷新中旋转动画），触发页面 `load()` 立即刷新
- **最近刷新时间**：展示"最近刷新：HH:mm:ss"（`toLocaleTimeString`），每次成功刷新更新；复用 `admin/index.vue:154` 已有的 `lastSuccessfulRefresh` 模式，抽为通用
- 布局：`PageHeader` 的 `#actions` 区域（与 `admin/index.vue:88-95` 一致），窄屏自动换行

设计依据（调研结论）：@nuxt/ui v4 无现成轮询/刷新组件，官方惯例即"USelectMenu 配 items + `useIntervalFn`（@vueuse/core，Nuxt 自带）+ 手动 refetch"；本项目已有 `useSubmissionPolling`（@vueuse 风格手写版）可对齐，不引入新依赖。

### D5: 黑名单与 community 列表分页
- `blacklist.vue` 接入 `useAdminList`（后端已支持 `page/per_page/keyword`），移除 `per_page: "100"` 硬编码，补分页控件与搜索框
- `community.vue` 待审/举报列表分页：先确认后端 `community` admin 接口是否支持分页参数；支持则直接接入，不支持则按现状保留 limit 并在 design 标注（实施时验证）

### D6: 交互反馈与刷新一致性
- `judge-images.vue` 删除后改为调用 `load()` 服务端重载（当前本地 filter 会与分页/轮询状态脱节）
- `users.vue` 操作（封禁/解封/改角色）后若 `currentPage > totalPages` 则回退到 `totalPages` 再加载，避免停在空页
- `settings.vue` 保存失败展示内联错误（catch + `extractApiError`）；`contests.vue`/`blacklist.vue` 删除补 try/catch + toast

### D7: 确定 bug 的修复方式
- `submissions.vue`：选项对象统一为 `{ label, value }`（与 `pages/submissions/index.vue:42-58` 对齐）
- `categories.vue:189`、`judge-images.vue:235`：补 `{{ }}` 插值
- `roles.vue:261`：`row.is_system` → `row.original.is_system`；`confirmDelete` 增加 `is_system` 拦截
- `problem-new.vue`：补 `middleware: "admin"` + `useRequireLogin()`（与 `problem-edit/[id].vue` 对齐）

## Risks / Trade-offs

- [轮询增加 API 请求量] → 页面隐藏暂停 + 终态自动停止 + 低频页 30s 间隔；admin 为低并发场景
- [轮询响应与用户操作竞态] → `requestVersion` 已保证旧响应不覆盖；轮询静默模式不打断 loading/操作
- [30s 间隔下数据可能短暂过期（用户列表封禁 badge）] → 可接受，30s 内一致性足够；到期时间以 badge title 展示
- [community 后端接口若不分页] → 降级：保留现有 limit 展示，分页列为后续后端变更（实施时验证后决定）
- [Nuxt SSR 环境 setInterval 泄漏] → 所有 admin 页均为 `ssr: false`，且 `onUnmounted` 清理，无泄漏路径

## Migration Plan

- 纯前端改动、无数据迁移、无后端部署；随常规 UI 发布即可
- 回滚策略：恢复 `pages/admin/*` 与 `composables/` 相关文件即可，无状态残留

## Open Questions

- `community.vue` 调用的后端 admin 待审/举报接口是否支持 `page/per_page`：**已验证不支持**（`GET /api/v1/community/posts` 为游标分页 cursor+limit，`GET /api/v1/community/admin/reports` 无分页参数，`GET /api/v1/community/admin/comments/pending` 仅 limit）→ 按设计 Non-Goal 降级处理：保留现有 limit 展示，分页留待后续后端变更。用户搜索防抖已实现（300ms）
