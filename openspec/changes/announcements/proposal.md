## Why

现状无公告/站内广播能力：admin 页面与路由中均无 announcement 端点，竞赛/社区通知只覆盖自身事件；首页左栏「公告轮播」是硬编码数组（`noj-ui/pages/index.vue:105-121`，3 条写死数据），运营者无法发布维护通知、活动预告。对标 HydroOJ，系统广播是运营者的基础工具（issue #231）。

## What Changes

- **独立 `announcements` 表**：`id` / `title` / `content`（Markdown）/ `is_pinned` / `is_active` / `created_by` / `created_at` / `updated_at`，索引 `(is_active, is_pinned, created_at)` 支撑「置顶优先 + 最新在前」查询（Drizzle 迁移 0035）
- **公开 API**：`GET /api/v1/announcements`（仅 `is_active=true`，置顶优先 + 分页）、`GET /api/v1/announcements/:id`（详情，非 active 返回 404）
- **管理 API**：`GET/POST /api/v1/admin/announcements`、`PUT/DELETE /api/v1/admin/announcements/:id`；发布/下架统一为 PUT 更新 `is_active`；全部写操作记录审计日志
- **RBAC**：`PERMISSION_DEFS` 注册 `announcement:manage`，admin 默认权限含该项（`admin:full_access` 通配放行），handler 内 `assertPermission` 细粒度检查
- **SSE 广播**：`Channels` 新增全局频道 `noj:events:announcements`，发布/下架/更新后 `publishEvent`；SSE 端点映射 `announcement:updated` 事件，前端 `useEventSource` 监听后重拉（沿用 queue/stats 模式，页面加载拉取为 fallback）
- **UI**：首页轮播改公告驱动（删除硬编码数组，置顶优先取前 5 条，点击跳详情，空态占位）；新增公开列表页 `/announcements`（置顶标记 + 分页）与详情页 `/announcements/[id]`（Markdown 渲染）；新增管理后台页 `pages/admin/announcements.vue`（复用 `useAdminList`）+ 侧边栏入口

> **取舍说明**：issue #231 §3 的「通知中心（铃铛）聚合推送」本期**不做**（design.md Non-Goals 已列明，SSE 横幅刷新已覆盖实时性诉求），留待后续 PR。

## Capabilities

### New Capabilities

- `announcement-management`: 公告系统完整功能（数据模型、公开 API、管理 API、权限、UI 行为）

### Modified Capabilities

- `database-schema`: 新增 `announcements` 表
- `sse-endpoints`: 新增 `announcement:updated` 全局事件
- `admin-authorization`: 新增 `announcement:manage` 权限注册

## Impact

- **noj-core**：`db/schema.ts` + 新迁移、`types/index.ts`（PERMISSION_DEFS）、`services/seed-rbac.ts`（admin 默认权限）、新增 `services/announcements.ts`、新增 `routes/announcements.ts`、`routes/admin.ts`（管理端点）、`routes/sse.ts`（事件映射）、`lib/event-bus.ts`（Channels）、`app.ts`（挂载）
- **noj-ui**：`pages/index.vue`（轮播公告驱动）、新增 `pages/announcements/index.vue` 与 `pages/announcements/[id].vue`、新增 `pages/admin/announcements.vue`、`layouts/admin.vue`（侧边栏）
- **测试**：noj-core tests（services/announcements + routes/announcements + admin 权限守卫）、noj-tests E2E（发布→首页可见→下架消失、非 admin 403、置顶排序）
- **数据库**：一条建表迁移（0035），无数据迁移风险
