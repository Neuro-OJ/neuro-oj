# Agent Note: 管理后台登录态刷新被踢回登录页与列表恒空

Status: implemented

## Problem

管理员登录后访问 `/admin` 及其子页面存在两类缺陷，且都只在浏览器整页加载/刷新时暴露：

1. **刷新即被踢回 `/login`。** 带有效 `noj:token` + `noj:session` 直接请求
   `/admin/users`，服务端返回 `302 → /login`（`curl` 实测），浏览器只能渲染登录页。
   根因是**路由中间件在 SSR 阶段读到未就绪的认证状态**：
   - `useAuth()` 在 SSR 用 `useAsyncData('auth:me', ...)` 拉取 `/api/v1/auth/me`；
   - 该 `data` 在守卫执行时仍是 `undefined`（要等渲染阶段才 resolve），
     而初始化里的 `watch(..., { immediate: true })` 立即把 `user = null`、
     `loading = false`；
   - `middleware/admin.ts` 的 `useAuthReady(loading)` 见到 `loading === false` 即刻返回，
     于是把已登录用户判为未登录 → `navigateTo('/login')`，服务端 302。

   SSR 期间的诊断埋点证实：`isLoggedIn=false user=false loading=false session=true`
   ——可读 session cookie 明明存在，用户对象却是空。

2. **面板显示「No data」，尽管 API 有数据。** `/admin/users` 的
   `GET /api/v1/admin/identity/users` 返回 200 + 完整 JSON，但表格渲染
   `User management / No data`。根因是共享组件 `components/admin/AdminTable.vue`
   仍按 **Nuxt UI v2 API** 编写，而项目已迁移到 Nuxt UI v4：
   - `:rows="items"` —— v4 的 `UTable` 只认 `data`，`rows` 不是 prop，被当作普通属性丢弃，
     `data` 恒为 `[]` → 表格永远空（12 个管理页面全部受影响）；
   - `#default="{ row, column }"` —— v4 的插槽分发在 `columns[].cell` 上，
     `#cell` 这类具名插槽根本不会被调用；
   - `UPagination :page-count/:model-value/@update:model-value` —— v4 的 prop 是
     `page` / `items-per-page` / `total`，事件是 `@update:page`，传入的 `page-count`
     使 `total = pageCount * itemsPerPage = 10`；且 `currentPage` 是 `UseAdminList`
     的 `Ref`，模板里没有自动解包，`currentPage ?? 1` 恒为 Ref 对象；
   - `@select="(row) => emit('row-click', row)"` —— v4 的 `onSelect` 签名是
     `(event, row)`，且 `row` 是 tanstack Row 而非原始数据。

   同一处 v2 残留还在 `AdminConfirmDialog` / `AdminEditPanel` / `AdminDetailDrawer`
   三个弹窗包装组件里：`<UModal :model-value="open" @update:model-value="...">`，
   v4 的 `UModal` prop/事件是 `open` / `@update:open`，因此弹窗既打不开也收不到关闭事件。
   （这三处目前无调用方，属潜在缺陷，一并修正。）

3. 修复过程中又暴露出第三处「有数据却显示不出来」：`/admin/audit-logs` 的表格
   单元格对可空字段做了非空断言——`(row.admin_id as string).slice(0, 8)`。
   审计日志里系统自动事件（`auth.register` / `auth.login_success` / `llm_provider.create`）
   的 `admin_id` 为 `null`，渲染函数抛
   `TypeError: Cannot read properties of null (reading 'slice')`；由于单元格是在
   `UTable` 内部渲染的，异常让**整张表**卸载，页面表现为「API 有数据但表格空白」
   （实测 `tbody tr=0`，控制台 Vue warn `Unhandled error during execution of render function`）。

## Decision

**1. `useAuth()` 新增可 await 的 `ensureAuthReady()`，路由守卫统一改用它。**
- 语义：`user` 已就绪 → 直接返回；无 `noj:session` → 未登录；有 session 但用户未就绪
  → 拉取 `/api/v1/auth/me`（SSR 复用同一个 `useAsyncData('auth:me')` 实例，
  渲染阶段的初始化因此**不会重复请求**；客户端由浏览器自带 Cookie）。
- 401 → 视为未登录；网络错误/超时/5xx → 退回 `noj:session` 快照（真实鉴权始终由后端执行，
  与 NOJ-209「仅在明确 401 时登出」的取舍一致），避免后端抖动时把已登录用户踢出。
- SSR 需要「复用同一个 `useAsyncData` 实例 + 不提前 resolve」两个条件同时成立，
  因此 SSR 初始化只在挂载时注册一次，并且回填改为「数据而非错误先到」：
  `watch([data, error], ([v, e]) => { if (v === undefined && e === undefined) return; ... })`，
  不再用 `immediate` 抢先写空值。

**2. `middleware/admin.ts`、`middleware/auth.ts` 改用 `await ensureAuthReady()`**
（取代 `useAuthReady(loading)` 的 5s 超时轮询）。`auth` 与 `admin` 守卫都能在
SSR 拿到真实登录态，`/my/problems`、`/trainings/mine`、`/set-password` 等
同类页面同样受益。`composables/useAuthReady.ts` 保留（不再被守卫使用）。

**3. `AdminTable.vue` 迁移到 Nuxt UI v4 API**：
- `UTable :data` + `:get-row-id`；
- 由 `columns` 生成列定义，`cell` 渲染函数把单元格委托回组件对外的
  `#cell` / `#actions` 插槽（未提供插槽时回退原始值），12 个管理页面的插槽写法无需改动；
- `UPagination :page :items-per-page="1" :total="totalPages" :show-edges @update:page`；
- `onSelect(event, row)` 正确取出 `row.original` 再 `emit('row-click')`。
- 空态由外层 `items.length === 0` 判断负责，不再依赖 v2 的 `UTable` 空态插槽。

**4. 三个弹窗包装组件的 `UModal` 改用 `:open` / `@update:open`。**

**5. `pages/admin/audit-logs.vue` 单元格判空**：`admin_id` 为 `null` 时显示「系统」，
`target_type`/`target_id` 判空，并让未知 action（`auth.*`、`llm_provider.*` 等）
回退显示原始 action 名而不是 `undefined`。

## Alternatives considered

- **admin 守卫继续在 SSR 跳过（`if (import.meta.server) return`）。**
  改动最小，但会放弃管理后台的服务端拦截：未登录/非管理员会先拿到 200 的 HTML 外壳
  再由客户端跳转，登录页出现「闪一下后台布局」，且服务端不再有任何访问控制。
  选择修好状态等待，而不是削弱守卫。
- **在 `useAuth()` 里把 SSR 初始化改成 `await`（顶层 `await api.get('/auth/me')`）。**
  会违反仓库「SSR 数据获取必须走 `useAsyncData`」的约定，且 `useAuth` 并非同步 setup
  上下文时无法 await。保留 `useAsyncData` 并让守卫 await 它。
- **让守卫直接 `await useAsyncData('auth:me', ...)`。** 会因 Nuxt 的
  `_asyncData[key]._deps++` 引用计数在每次守卫调用时累积，且 `immediate: false`
  在该重载下不受支持（会真的发请求）。改为在 `useAuth()` 内部封装，
  保证「同 key 同 fetcher」的实例复用。
- **`AdminTable` 改为让各页面直接写 `UTable`。** 会复制 12 份加载/错误/空态/分页样板，
  正是 #473 要消除的重复。保留包装组件，只把内部的 v2 用法换成 v4。
- **把审计日志单元格的 `as string` 断言全量替换为 `?.`。** 只修 `?.` 会让
  `(row.target_id as string)?.slice()` 仍可能抛出并显示 `undefined:undefined`；
  改为显式的判空 + 展示文案（「系统」/「—」）。

## Consequences

- 带有效会话整页加载/刷新 `/admin/*` 返回 200（实测 `/admin`、`/admin/users`、
  `/admin/roles`、`/admin/audit-logs`、`/admin/settings` 均为 200，不再 302）；
  匿名与「只有伪造 session、无 token」的请求仍 302 到 `/login`，非管理员仍静默回首页；
  `/my/problems`、`/trainings/mine`、`/set-password` 等同类受保护页面一并恢复。
- 管理面板真正渲染数据。19 个 `/admin/*` 页面全量巡检：无重定向、无渲染异常，
  有数据的页面均出真实行（`/admin/users` 2 行、`/admin/roles` 2 行、
  `/admin/audit-logs` 20 行、`/admin/settings` 118 行、`/admin/llm/providers` 1 行）。
  仅存的 dev 模式告警是预先存在的 hydration mismatch（改动前在 `/login` 上同样出现），
  与本次修复无关。
- 回归防护：
  - `noj-ui/tests/components/AdminTable.spec.ts`（7 例，vitest）用与 v4 契约一致的
    `UTable` 桩件锁住「行数据必须经 `data` 传入」——把 `:data` 改回 `:rows` 时 4 例失败；
  - `noj-tests/e2e/browser/20_admin_panel.test.ts`（2 例，Playwright）覆盖
    「刷新 /admin/* 保持登录 + 表格有数据行 + 无未捕获异常」；回归到旧实现时两例均失败，
    修复后连续 3 次运行稳定通过。
- 弹窗包装组件与 Nuxt UI v4 的 prop/事件契约一致（当前无调用方，属预防性修正）。
- 未做（记录备查）：
  - `composables/useAuthReady.ts` 已无生产调用方，本次保留以避免扩大改动面；
  - `useAdminList` 驱动的 `blacklist`、`announcements` 两页因本地库无数据，仅验证到
    空态分支，未验证真实行渲染（同一 `AdminTable` 路径已由 users/roles/audit-logs 覆盖）；
  - `AdminTable` 的 `sort` 事件仍然只有列头点击、无排序实现（改动前即如此，
    且没有任何管理页消费该事件），排序能力未纳入本次修复；
  - 浏览器 E2E 的失败诊断产物写在 `noj-tests/test-results/`，该目录未加入 `.gitignore`
    （本次已手动清理，属既有约定之外的小隐患）。
