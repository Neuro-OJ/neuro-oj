## Context

Neuro OJ 目前后端（noj-core）已具备完整的 admin API 层（含 `authMiddleware` + `adminMiddleware`），但前端（noj-ui）完全没有管理界面。管理员只能通过 curl 等工具调用 API 进行管理操作。

前端基于 Nuxt 3 + Vue 3 + Tailwind CSS，使用文件系统路由。现有用户认证通过 `useAuth` composable 管理，JWT token 存于 localStorage，通过 `server/api/[...slug].ts` 反向代理到 noj-core。

本次变更为纯前端功能增强，后端只需补充一个用户列表端点。

## Goals / Non-Goals

**Goals:**
- 提供一套完整的管理后台 UI，覆盖用户管理、题目管理、分类管理、提交审核
- 只有 role 为 `admin` 的用户可访问管理页面
- 非管理员在导航中看不到管理入口
- 遵循现有前端代码风格和模式

**Non-Goals:**
- 不引入新的权限模型（仅 `user` / `admin` 双层）
- 不修改现有公共页面路由和行为
- 不涉及后端评测相关功能的变更
- 不实现题目导入/导出（属于路线图后续阶段）

## Decisions

### 决策 1：独立管理布局 vs 共用默认布局
**选择：** 新建 `layouts/admin.vue` 独立布局。
- 管理后台需要侧边栏导航，与前台顶栏导航差异大
- 独立布局可避免在 default.vue 中增加大量条件判断
- 侧边栏对多层级管理页面导航更高效

### 决策 2：Nuxt 路由守卫实现方式
**选择：** 使用 `middleware/admin.ts`（Nuxt 页面中间件）。
- 在 `pages/admin/` 目录下页面中通过 `definePageMeta({ middleware: 'admin' })` 声明
- Nuxt 中间件在路由切换时自动执行，支持 loading 状态等待
- 相比在布局中手动守卫，中间件方式更声明式、更可测试

### 决策 3：API 数据获取方式
**选择：** 管理页面使用 `ssr: false` + `$fetch`（手动带 token）+ `watch` pattern。
- 管理端点是受保护 API，需要 `Authorization: Bearer` 请求头
- SSR 下无法访问 localStorage 中的 token，因此全页禁用 SSR：`definePageMeta({ ssr: false })`
- 使用 `watch` 等待 `useAuth().loading` 完成、token 就绪后再发起请求
- 现有 `settings.vue` 和 `submissions/[id].vue` 均采用此模式

### 决策 4：共享组件粒度
**选择：** 只提取 `AdminTable` 和 `AdminModal` 两个高频复用组件。
- 管理页面多为「列表 + 弹窗/表单」模式
- 避免过度抽象——每个页面的表单内容差异大，不适合通用化
- 表格组件支持列配置、加载态、空态、操作列插槽
- 分页组件直接复用已有的 `components/PaginationNav.vue`

### 决策 5：表单数据提交
**选择：** 使用 `$fetch` 发起 API 请求，与 `settings.vue` 的 `handleSave()` 模式一致。
- 创建/编辑操作：`$fetch(url, { method: "POST"|"PUT", headers: { Authorization: "Bearer ..." }, body })`
- 删除操作：`$fetch(url, { method: "DELETE", headers: { Authorization: "Bearer ..." } })`
- 前端做基础字段验证（必填、格式），业务错误由 API 返回后展示

### 决策 6：仪表盘数据来源
**选择：** 复用现有 API 的分页统计组装仪表盘数据，不新增专门端点。
- 用户数：`GET /api/v1/admin/users` → `pagination.total`（新增端点）
- 题目数：`GET /api/v1/problems` → `total`（已有公开端点）
- 提交数：`GET /api/v1/admin/submissions` → `pagination.total`（已有管理端点）
- 队列状态：`GET /api/v1/queue` → `stats`（已有公开端点）
- 页面加载时并行发起多个请求，各自独立处理加载/错误状态

### 决策 7：移动端适配策略
**选择：** 侧边栏在小屏幕上默认收起，通过汉堡菜单切换。
- 管理后台主要面向桌面端操作，但需保证移动端基本可用
- 内容区在小屏幕下方侧边栏之上，保持可读性

## Risks / Trade-offs

| 风险 | 缓解措施 |
|------|---------|
| `useAuth().loading` 时序导致中间件误判 | 中间件内 await 或 watch loading 为 false 后再做判断 |
| 管理页面 token 过期 | 大多数页面使用 `$fetch`，401 时 `useAuth().logout()` 自动跳转登录 |
| 题目表单复杂度高（Markdown + 分类多选） | 复用现有 `MarkdownRenderer` 组件和样式模式 |
| 与 future 管理员 API 变更耦合 | 所有 API 调用集中在页面层面，API 响应变化时只需修改对应页面 |
