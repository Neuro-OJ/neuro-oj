## 1. 修复确定的 bug

- [ ] 1.1 修复 `pages/admin/submissions.vue`：语言/状态筛选选项对象统一为 `{ label, value }`（对齐 `pages/submissions/index.vue`），修复下拉空白
- [ ] 1.2 修复 `pages/admin/categories.vue` 按钮文本缺失 `{{ }}` 插值（`editingCategory ? '保存' : '创建'`）
- [ ] 1.3 修复 `pages/admin/judge-images.vue` 按钮文本缺失 `{{ }}` 插值（`editingItem ? '保存' : '新增'`）
- [ ] 1.4 修复 `pages/admin/roles.vue`：删除按钮改用 `row.original.is_system`，`confirmDelete` 增加系统角色删除拦截
- [ ] 1.5 修复 `pages/admin/problem-new.vue`：补 `middleware: "admin"` 与 `useRequireLogin()`

## 2. 通用轮询机制

- [ ] 2.1 新建 `composables/usePolling.ts`：intervalMs（支持响应式动态变化，null=关闭）/ fetcher / immediate / stopWhen / active 选项，页面隐藏暂停（visibilitychange）、onUnmounted 清理、防重入、返回 start/stop/isPolling
- [ ] 2.2 扩展 `composables/useAdminList.ts`：新增 `polling?: { intervalMs; stopWhen? }` 选项，轮询走静默 load（不置 loading），沿用 requestVersion 防竞态
- [ ] 2.3 新建 `components/admin/RefreshControl.vue`：`USelectMenu` 间隔下拉（关闭/5s/10s/30s/1min，v-model 绑 intervalRef）+ 手动刷新按钮（`i-lucide-refresh-cw` 旋转动画）+ 最近刷新时间展示（"最近刷新：HH:mm:ss"）；纯 UI 组件，轮询由页面 `usePolling` 管理

## 3. 动态数据页面接入自动更新

- [ ] 3.1 `pages/admin/index.vue`：评测队列统计接入 5s 默认轮询，接入 `RefreshControl`（间隔切换即时生效、可关闭、手动刷新、最近刷新时间），保留原有刷新按钮逻辑并入控制条
- [ ] 3.2 `pages/admin/submissions.vue`：列表 3s 默认轮询（全部行终态自动停止，重测后恢复），接入 `RefreshControl`
- [ ] 3.3 `pages/admin/users.vue`：30s 默认低频轮询（封禁 badge 到期自动消失），接入 `RefreshControl`
- [ ] 3.4 `pages/admin/contests.vue`：30s 默认轮询竞赛状态与人数，接入 `RefreshControl`
- [ ] 3.5 `pages/admin/community.vue`：30s 默认轮询待审/举报数据，接入 `RefreshControl`

## 4. 列表体验补齐

- [ ] 4.1 `pages/admin/blacklist.vue`：接入 `useAdminList` 分页 + 搜索框，移除 `per_page: 100` 硬编码（后端已支持 `page/per_page/keyword`）
- [ ] 4.2 `pages/admin/community.vue`：待审/举报列表分页（验证后端接口分页支持，不支持则记录降级）；用户搜索加防抖
- [ ] 4.3 `pages/admin/problems.vue`：补搜索框（后端 `GET /api/v1/problems?keyword=` 已支持）

## 5. 交互反馈与刷新一致性

- [ ] 5.1 `pages/admin/settings.vue`：saveSetting 加 try/catch + 内联错误提示，保存成功清除错误
- [ ] 5.2 `pages/admin/contests.vue`：removeContest 加 try/catch + toast，openEdit 加 loading 态
- [ ] 5.3 `pages/admin/blacklist.vue`：confirmDelete 加 try/catch + toast
- [ ] 5.4 `pages/admin/judge-images.vue`：删除后改为服务端 `load()` 重载而非本地 filter
- [ ] 5.5 `pages/admin/users.vue`：操作（封禁/解封/改角色）后若当前页超出总页数则回退到最后一页再加载

## 6. 验证与提交

- [ ] 6.1 运行 `deno lint` + `deno fmt`（noj-ui），修复所有告警
- [ ] 6.2 运行 Nuxt 类型检查 / build 通过（`nuxt build` 或 `npx nuxi typecheck`）
- [ ] 6.3 逐页冒烟：4 个 bug 修复点、各轮询页面（仪表盘 5s / 提交 3s 终态停止 / 用户 30s）、刷新控制条（间隔切换即时生效、关闭停轮询、手动刷新、最近刷新时间更新）、黑名单分页、搜索防抖
- [ ] 6.4 确认 GPG 签名就绪后按项目规范提交（jj，中文 Conventional Commits，scope `ui`）
