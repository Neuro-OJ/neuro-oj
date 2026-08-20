## Purpose

定义 Neuro OJ 公告管理功能规范，包括公告数据模型、公开 API、管理 API、RBAC 权限以及前后端公告页面。

## Requirements

### Requirement: 公告数据模型

系统 SHALL 提供 `announcements` 表持久化公告，表结构 SHALL 包含：

- `id` TEXT PRIMARY KEY（uuid）
- `title` TEXT NOT NULL（1–100 字符）
- `content` TEXT NOT NULL（Markdown，1–50000 字符）
- `is_pinned` BOOLEAN NOT NULL DEFAULT FALSE
- `is_active` BOOLEAN NOT NULL DEFAULT TRUE（false = 已下架）
- `created_by` TEXT NOT NULL REFERENCES `users(id)`
- `created_at` TEXT NOT NULL（ISO 8601）
- `updated_at` TEXT NOT NULL（ISO 8601）

表 SHALL 建索引 `(is_active, is_pinned, created_at)` 支撑公开列表查询，通过 Drizzle 迁移（0035）创建。

#### Scenario: 迁移创建公告表

- **WHEN** 执行 `deno task db:migrate`（或启动期自动迁移）
- **THEN** `announcements` 表创建成功，索引存在，无存量数据

#### Scenario: 创建公告必填校验

- **WHEN** 请求 title 为空或超过 100 字符、content 为空或超过 50000 字符
- **THEN** 系统返回 HTTP 400，不落库

### Requirement: 公开公告列表 API

系统 SHALL 提供 `GET /api/v1/announcements`，返回**仅 `is_active=true`** 的公告，排序 SHALL 为 `is_pinned DESC, created_at DESC`（置顶优先，同组内最新在前），支持分页（`page` / `per_page`，默认 20，沿用 `lib/pagination.ts`）。

响应 SHALL 为 `{ data: AnnouncementSummary[], meta: { page, per_page, total } }`。列表项 SHALL 包含 `id`、`title`、`is_pinned`、`created_at`、`updated_at` 与 `excerpt`（content Markdown 源码截断 120 字符），**不**包含 `content` 全文。接口无需认证。

#### Scenario: 置顶公告排最前

- **WHEN** 系统存在 1 条置顶公告（较旧）与 1 条未置顶公告（较新）
- **THEN** 列表第一项为置顶公告（`is_pinned=true`），即使其 `created_at` 更早

#### Scenario: 已下架公告不可见

- **WHEN** 某公告 `is_active=false`（下架）
- **THEN** 公开列表不包含该公告，且列表 `total` 不统计它

#### Scenario: 分页生效

- **WHEN** 客户端请求 `GET /api/v1/announcements?page=2&per_page=5`
- **THEN** 返回第 2 页数据，`meta` 中 `page=2`、`per_page=5`、`total` 为 active 公告总数

#### Scenario: 未登录可访问

- **WHEN** 未携带任何认证信息的客户端请求公开列表
- **THEN** 响应 200 + 数据（公开接口，无需 JWT）

### Requirement: 公开公告详情 API

系统 SHALL 提供 `GET /api/v1/announcements/:id`，返回单个 active 公告的完整信息：`id`、`title`、`content`（Markdown 全文）、`is_pinned`、`created_at`、`updated_at`、`created_by`。非 active 或不存在的公告 SHALL 返回 404。

#### Scenario: 查看已发布公告详情

- **WHEN** 客户端请求某 active 公告的详情
- **THEN** 响应 200 + 完整字段（含 `content` 全文）

#### Scenario: 已下架公告详情返回 404

- **WHEN** 客户端请求某 `is_active=false` 公告的详情
- **THEN** 响应 404 Not Found

### Requirement: 管理公告 API

系统 SHALL 提供管理端点（受 `authMiddleware` + `adminMiddleware` 组级保护）：

- `GET /api/v1/admin/announcements`：全量列表（含未发布/已下架），分页，可选 `is_active` 筛选，列表项含 `content` 全文
- `POST /api/v1/admin/announcements`：创建公告，body `{ title, content, is_pinned?, is_active? }`（缺省 `is_pinned=false`、`is_active=true`）
- `PUT /api/v1/admin/announcements/:id`：更新公告（部分更新语义）；**发布/下架统一为更新 `is_active`**（下架 = `is_active: false`）
- `DELETE /api/v1/admin/announcements/:id`：物理删除

所有写操作（创建/更新/删除）SHALL 记录审计日志（action 分别为 `announcement.create` / `announcement.update` / `announcement.delete`，复用既有审计机制）。创建时 `created_by` SHALL 写入当前操作者用户 id。

#### Scenario: 管理员发布公告

- **WHEN** admin 调用 `POST /api/v1/admin/announcements`（合法 body）
- **THEN** 响应 201 + 创建的公告，`is_active=true`，审计日志新增 `announcement.create` 记录

#### Scenario: 管理员下架公告

- **WHEN** admin 调用 `PUT /api/v1/admin/announcements/:id`，body `{ is_active: false }`
- **THEN** 更新成功，该公告 `is_active=false`，公开列表不再返回；审计日志新增 `announcement.update` 记录

#### Scenario: 管理员删除公告

- **WHEN** admin 调用 `DELETE /api/v1/admin/announcements/:id`
- **THEN** 删除成功（204），审计日志新增 `announcement.delete` 记录

#### Scenario: 更新不存在的公告

- **WHEN** admin 调用 `PUT /api/v1/admin/announcements/:id`，id 不存在
- **THEN** 响应 404 Not Found

### Requirement: 公告管理权限

系统 SHALL 在 `PERMISSION_DEFS` 注册 `announcement:manage`（resource=`announcement`, action=`manage`，description「管理公告」），并在 `seed-rbac.ts` 的 admin 角色默认权限中加入该项（`ensurePermissions()` 幂等插入，ON CONFLICT DO NOTHING）。

管理端点 handler SHALL 调用 `assertPermission(c, "announcement:manage")`：持有 `admin:full_access`（通配放行）或显式拥有该权限的用户放行，其余返回 403。

#### Scenario: admin 管理公告

- **WHEN** 持有 `admin:full_access` 的用户调用管理端点
- **THEN** 权限检查通过（通配放行），操作正常执行

#### Scenario: 非 admin 写操作被拒

- **WHEN** 普通用户调用 `POST /api/v1/admin/announcements`
- **THEN** 响应 403 Forbidden（adminMiddleware 或 assertPermission 拦截）

#### Scenario: 权限种子幂等

- **WHEN** 已存在 `announcement:manage` 权限的数据库上再次执行 `ensureRbacSeeds()`
- **THEN** 不产生重复权限行

### Requirement: 首页公告轮播（UI）

系统 SHALL 将首页（`pages/index.vue`）左栏公告轮播改为公告驱动：删除硬编码公告数组，拉取 `GET /api/v1/announcements?per_page=5` 渲染轮播项（标题 + 摘要），点击轮播项跳转 `/announcements/[id]` 详情页。

- 轮播背景渐变 SHALL 按轮播下标循环使用预设色板（不依赖公告数据）
- 公告列表为空时 SHALL 显示默认欢迎占位（保留现「正式上线」等静态文案语义）
- 收到 SSE `announcement:updated` 事件后 SHALL 重新拉取轮播数据

#### Scenario: 首页展示运营公告

- **WHEN** 运营者发布公告（含置顶），任意用户访问首页
- **THEN** 轮播展示该公告（置顶优先），点击跳转详情页

#### Scenario: 无公告时显示占位

- **WHEN** 系统无任何 active 公告
- **THEN** 轮播区显示默认欢迎占位文案，不报错

#### Scenario: SSE 触发轮播刷新

- **WHEN** 首页打开期间管理员发布/下架公告（SSE 连接在线）
- **THEN** 收到 `announcement:updated` 后轮播数据刷新（新公告出现 / 下架公告消失）；SSE 不可用时页面刷新后仍显示最新数据（fallback）

### Requirement: 公开公告页面（UI）

系统 SHALL 提供公开公告列表页 `/announcements` 与详情页 `/announcements/[id]`：

- 列表页 SHALL 展示置顶徽标（`is_pinned`）、标题、发布时间，支持分页（复用 `PaginationNav`），行点击进入详情页
- 详情页 SHALL 展示标题、发布时间、置顶徽标与 Markdown 全文（复用 `MarkdownRenderer`），使用公开列表/详情 API

#### Scenario: 浏览全部公告

- **WHEN** 任意用户访问 `/announcements`
- **THEN** 展示 active 公告分页列表，置顶公告带徽标

#### Scenario: 查看公告全文

- **WHEN** 任意用户访问 `/announcements/<id>`（id 为 active 公告）
- **THEN** 页面渲染 Markdown 全文

### Requirement: 管理后台公告页（UI）

系统 SHALL 提供管理后台公告管理页 `pages/admin/announcements.vue`（`definePageMeta({ layout: "admin", middleware: "admin" })`，与既有 admin 页一致）：

- 列表 SHALL 展示标题、置顶状态、发布状态、创建/更新时间，支持分页（复用 `useAdminList`）
- 提供新建与编辑表单（标题 + Markdown 文本域 + 置顶开关 + 发布状态开关），保存调用管理 API
- 支持删除（二次确认）
- `layouts/admin.vue` 侧边栏 SHALL 新增「公告管理」入口（内容与评测分组）

#### Scenario: 运营者管理公告

- **WHEN** 管理员在后台创建公告并保存
- **THEN** 列表出现新公告（发布状态按表单开关）；编辑切换发布状态即发布/下架
