## Why

管理后台（`/admin`）13 个页面全部为"登录时一次性加载 + 手动刷新"，没有任何轮询/SSE 自动更新机制（而普通用户页如 `queue.vue`、`submissions/[id].vue` 均有实时机制），导致评测队列统计、提交状态、封禁到期等动态数据长期过期；同时存在 4 个确定的功能性 bug（下拉空白、按钮文本字面量、系统角色可删除、建题页缺守卫）以及多项列表体验与交互反馈缺陷，后台整体不像一个正经好用的后台。

## What Changes

- 修复 `admin/submissions.vue` 语言/状态下拉选项渲染空白（选项定义用 `header`、模板渲染 `opt.label` 字段错位）
- 修复 `admin/categories.vue`、`admin/judge-images.vue` 按钮文本缺失 `{{ }}` 插值（显示源码字面量）
- 修复 `admin/roles.vue` 系统角色删除按钮未禁用（`row.is_system` → `row.original.is_system`）且 `confirmDelete` 无 `is_system` 拦截
- 修复 `admin/problem-new.vue` 缺失 `middleware: "admin"` 与 `useRequireLogin()` 页面守卫
- 新增通用轮询机制（`composables/usePolling.ts`），为动态数据页面补自动更新：
  - 仪表盘评测队列统计：5s 轮询
  - admin 提交列表 pending/judging 状态：3s 轮询，全终态自动停止
  - 用户列表封禁状态：30s 低频轮询（封禁到期 badge 自动消失）
  - 竞赛状态/人数、社区待审/举报：30s 轮询
- 新增"刷新控制条"（`components/admin/RefreshControl.vue`），所有启用自动刷新的页面提供：
  - 轮询间隔选择下拉框（关闭 / 3s / 5s / 10s / 30s / 1min，切换即时生效）
  - 手动刷新按钮
  - 最近一次成功刷新时间展示（100ms 精度相对时间，如 `1.0s`）
- 社区预设前端化：`admin/community.vue` 预设选择改存 localStorage（`noj:community:preset`），应用预设仅更新前端页面配置草稿，不再调用后端 preset API；移除对 `POST /api/v1/community/admin/preset/:name` 的依赖
- 未保存变更明确标识：
  - `admin/community.vue` 配置区草稿化：开关/数字本地编辑 + 统一"保存更改"/"放弃更改" + 未保存 badge
  - `admin/settings.vue` 顶部增加"有未保存的更改（N 项）"标识（复用现有 drafts/isDirty 机制）
- `admin/blacklist.vue` 分页化，移除 `per_page: 100` 硬编码上限
- `admin/community.vue` 待审/举报列表分页，用户搜索加防抖
- `admin/problems.vue` 补搜索（后端接口支持时）
- 交互反馈补齐：`settings.vue` 保存错误内联提示、`contests.vue` 删除错误处理与编辑 loading 态、`blacklist.vue` 删除错误处理、`judge-images.vue` 删除后服务端重载、`users.vue` 操作后刷新防空页
- 列表页操作后刷新一致性：避免删除后停留在空页

## Capabilities

### New Capabilities

- `admin-auto-refresh`: 后台管理页面动态数据自动更新机制（轮询），定义轮询间隔、间隔可配置、终态自动停止、页面不可见时暂停、静默刷新不打断用户操作、最近刷新时间展示等行为

### Modified Capabilities

- `admin-dashboard`: 统计数据刷新从"仅手动刷新按钮"升级为"自动轮询 + 手动刷新并存"
- `admin-submission-management`: 新增提交列表对 pending/judging 进行中的提交自动更新状态的需求
- `admin-system-settings`: 新增保存失败时内联错误反馈的需求
- `admin-ui-interaction-resilience`: 新增自动刷新（轮询）静默不打断用户操作的需求；新增未保存变更明确标识的需求
- `community-configuration`: 社区配置预设行为变更——从"后端事务化预设 + 审计"改为"前端本地应用 + localStorage 记忆选择"

> 注：`admin-ip-blacklist` 的分页 + 搜索需求已存在于现有 spec（`admin-ip-blacklist/spec.md`），当前仅前端实现缺口（`per_page=100` 硬编码），属实现补齐，无需求变化，故不列 delta。

## Impact

- **noj-ui**（仅前端改动）：
  - `pages/admin/*`：index / users / submissions / problems / audit-logs / blacklist / categories / community / contests / judge-images / roles / settings / problem-new
  - `composables/`：新增 `usePolling.ts`，扩展 `useAdminList.ts`（polling 选项）
  - `components/admin/`：视需要
- **noj-core**：无后端改动（轮询复用现有 REST 端点）；若 `GET /api/v1/problems` 不支持 `keyword` 则 problems.vue 搜索项降级为仅分页
- **依赖**：无新增依赖
