## 1. 数据模型与迁移（noj-core）

- [x] 1.1 `db/schema.ts` 新增 `announcements` 表（id/title/content/is_pinned/is_active/created_by/created_at/updated_at + `idx_announcements_active_pinned_created` 索引），沿用既有 text 主键 / ISO 8601 风格（已随 b75a62c3 提交）
- [x] 1.2 `deno task db:generate` 生成 0035 迁移并执行 `deno task db:migrate`（本地 dev 库验证：announcements 表 + 索引 + announcement:manage 权限均已确认）

## 2. 权限注册（noj-core）

- [x] 2.1 `types/index.ts` 的 `PERMISSION_DEFS` 新增 `{ resource: "announcement", action: "manage", description: "管理公告" }`
- [x] 2.2 `seed-rbac.ts` 的 `ADMIN_DEFAULT_PERMISSIONS` 加入 `{ resource: "announcement", action: "manage" }`
- [x] 2.3 `types/audit-log.ts` `AuditAction`/`AuditDetail` 新增 `announcement.create/update/delete`；`schema.ts` audit CHECK 约束扩展（迁移 0036 由 `db:generate` 生成）

## 3. 服务层（services/announcements.ts）

- [x] 3.1 新增 `services/announcements.ts`：类型（AnnouncementSummary / AnnouncementDetail / AdminAnnouncementItem / Create/UpdateAnnouncementInput）+ `listPublicAnnouncements(page, perPage)`（仅 active，`is_pinned DESC, created_at DESC`，excerpt 截断 120 字符）+ `getPublicAnnouncement(id)`（非 active 抛 404）
- [x] 3.2 `createAnnouncement(input)` / `updateAnnouncement(id, input)` / `deleteAnnouncement(id)` / `listAdminAnnouncements(page, perPage, isActive?)`：字段校验（title 1–100、content 1–50000）、审计日志（`announcement.create/update/delete`）、操作者经 `getRequestContext()` 获取；细粒度权限 `assertPermission(c, "announcement:manage")` 在路由层 handler 内执行（与 community.ts 同模式，服务层不依赖 Hono Context）
- [x] 3.3 写操作成功后 `publishEvent(Channels.announcements, ...)` 广播变更

## 4. 路由与 SSE（noj-core）

- [x] 4.1 新增 `routes/announcements.ts` 公开路由：`GET /`（列表）、`GET /:id`（详情）；`app.ts` 挂载 `/api/v1/announcements`（必须在 sse 实例之前注册——sse 全局 authMiddleware 会拦截其后的路由）
- [x] 4.2 `routes/admin.ts` 追加：`GET/POST /announcements`、`PUT/DELETE /announcements/:id`（handler 内 `assertPermission(c, "announcement:manage")`）
- [x] 4.3 `lib/event-bus.ts` `Channels` 新增 `announcements` 全局频道；SSE 端点 `GET /api/v1/announcements/events`（注册在 `routes/announcements.ts` 内、`/:id` 之前，单路由挂 authMiddleware）→ SSE 事件 `announcement:updated`（与 `queue:changed` 同模式）

## 5. core 测试

- [x] 5.1 `tests/services/announcements.test.ts`：公告 CRUD（校验 400、审计、排序置顶优先、公开列表仅 active、excerpt 截断、非 active 详情 404、分页 meta）
- [x] 5.2 `tests/routes/announcements.test.ts`：公开路由（未登录 200、置顶排序、下架不可见、404）+ admin 路由（非 admin 403、发布/下架/删除全流程、分页 meta）
- [x] 5.3 seed 测试：`ensureRbacSeeds` 后 `announcement:manage` 存在且 admin 角色拥有

## 6. 前端：首页轮播（noj-ui）

- [x] 6.1 `pages/index.vue` 删除硬编码 `announcements` 数组，改为 `GET /api/v1/announcements?per_page=5` 驱动（标题 + 摘要，点击跳 `/announcements/[id]`，空态占位，渐变按下标循环预设色板）
- [x] 6.2 `useEventSource` 监听 `announcement:updated` → 重拉轮播数据（60s 轮询 fallback，登录用户启用）

## 7. 前端：公开公告页（noj-ui）

- [x] 7.1 新增 `pages/announcements/index.vue` 列表页（置顶徽标 + 分页 `PaginationNav`）
- [x] 7.2 新增 `pages/announcements/[id].vue` 详情页（`MarkdownRenderer` 渲染全文 + 404 占位）

## 8. 前端：管理后台（noj-ui）

- [x] 8.1 新增 `pages/admin/announcements.vue`（`useAdminList` 分页列表 + 新建/编辑表单 + 删除二次确认）
- [x] 8.2 `layouts/admin.vue` 侧边栏「内容与评测」分组新增「公告管理」入口

## 9. 全链路验证

- [x] 9.1 noj-core：`deno fmt` + `deno lint` + `deno task test` 全量通过（743 passed / 0 failed）
- [x] 9.2 noj-ui：`deno fmt` + `deno lint` + `nuxt build` 通过
- [ ] 9.3 noj-tests E2E 新增公告用例（`e2e/28_announcements.test.ts` 已编写：发布→公开可见→下架消失、非 admin 403、置顶排序、SSE 广播），`run-e2e.sh` 全量跑通**待执行**

## 10. OpenSpec 归档

- [ ] 10.1 `/opsx:archive` 归档变更（目录 `2026-08-08-announcements`）+ `/opsx:sync` 同步主规范（待 9.3 完成）
- [ ] 10.2 确认 GPG 签名后按项目规范提交（jj，中文 Conventional Commits，scope `core,ui`）
