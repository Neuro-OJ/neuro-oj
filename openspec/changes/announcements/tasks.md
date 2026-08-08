## 1. 数据模型与迁移（noj-core）

- [ ] 1.1 `db/schema.ts` 新增 `announcements` 表（id/title/content/is_pinned/is_active/created_by/created_at/updated_at + `idx_announcements_active_pinned_created` 索引），沿用既有 text 主键 / ISO 8601 风格
- [ ] 1.2 `deno task db:generate` 生成 0035 迁移并执行 `deno task db:migrate`（本地 dev 库验证）

## 2. 权限注册（noj-core）

- [ ] 2.1 `types/index.ts` 的 `PERMISSION_DEFS` 新增 `{ resource: "announcement", action: "manage", description: "管理公告" }`
- [ ] 2.2 `seed-rbac.ts` 的 `ADMIN_DEFAULT_PERMISSIONS` 加入 `{ resource: "announcement", action: "manage" }`

## 3. 服务层（services/announcements.ts）

- [ ] 3.1 新增 `services/announcements.ts`：类型（AnnouncementSummary / CreateAnnouncementInput / UpdateAnnouncementInput）+ `listPublicAnnouncements(page, perPage)`（仅 active，`is_pinned DESC, created_at DESC`，excerpt 截断 120 字符）+ `getPublicAnnouncement(id)`（非 active 抛 404）
- [ ] 3.2 `createAnnouncement(c, input)` / `updateAnnouncement(c, id, input)` / `deleteAnnouncement(c, id)` / `listAdminAnnouncements(c, page, perPage, isActive?)`：字段校验（title 1–100、content 1–50000）、`assertPermission(c, "announcement:manage")`、审计日志（`announcement.create/update/delete`）
- [ ] 3.3 写操作成功后 `publishEvent(Channels.announcements, ...)` 广播变更

## 4. 路由与 SSE（noj-core）

- [ ] 4.1 新增 `routes/announcements.ts` 公开路由：`GET /`（列表）、`GET /:id`（详情）；`app.ts` 挂载 `/api/v1/announcements`
- [ ] 4.2 `routes/admin.ts` 追加：`GET/POST /announcements`、`PUT/DELETE /announcements/:id`（handler 内 `assertPermission(c, "announcement:manage")`）
- [ ] 4.3 `lib/event-bus.ts` `Channels` 新增 `announcements` 全局频道；`routes/sse.ts` 注册监听 → SSE 事件 `announcement:updated`（全局广播，与 `queue:changed` 同模式）

## 5. core 测试

- [ ] 5.1 `tests/services/`：公告 CRUD（校验 400、权限 403、审计、排序置顶优先、公开列表仅 active、excerpt 截断、非 active 详情 404、分页 meta）
- [ ] 5.2 `tests/routes/`：公开路由（未登录 200、置顶排序、下架不可见、404）+ admin 路由（非 admin 403、发布/下架/删除全流程、审计日志断言）
- [ ] 5.3 seed 测试：`ensureRbacSeeds` 后 `announcement:manage` 存在且 admin 角色拥有

## 6. 前端：首页轮播（noj-ui）

- [ ] 6.1 `pages/index.vue` 删除硬编码 `announcements` 数组，改为 `GET /api/v1/announcements?per_page=5` 驱动（标题 + 摘要，点击跳 `/announcements/[id]`，空态占位，渐变按下标循环预设色板）
- [ ] 6.2 `useEventSource` 监听 `announcement:updated` → 重拉轮播数据

## 7. 前端：公开公告页（noj-ui）

- [ ] 7.1 新增 `pages/announcements/index.vue` 列表页（置顶徽标 + 分页 `PaginationNav`）
- [ ] 7.2 新增 `pages/announcements/[id].vue` 详情页（`MarkdownRenderer` 渲染全文）

## 8. 前端：管理后台（noj-ui）

- [ ] 8.1 新增 `pages/admin/announcements.vue`（`useAdminList` 分页列表 + 新建/编辑表单 + 删除二次确认）
- [ ] 8.2 `layouts/admin.vue` 侧边栏「内容与评测」分组新增「公告管理」入口

## 9. 全链路验证

- [ ] 9.1 noj-core：`deno fmt` + `deno lint` + `deno task test` 全量通过
- [ ] 9.2 noj-ui：`deno fmt` + `deno lint` + `nuxt build` 通过
- [ ] 9.3 noj-tests E2E 新增公告用例：admin 发布 → 公开列表/首页可见 → 下架消失；非 admin 写 403；置顶排序生效；SSE `announcement:updated` 广播；`run-e2e.sh` 全量跑通

## 10. OpenSpec 归档

- [ ] 10.1 `/opsx:archive` 归档变更（目录 `2026-08-08-announcements`）+ `/opsx:sync` 同步主规范
- [ ] 10.2 确认 GPG 签名后按项目规范提交（jj，中文 Conventional Commits，scope `core,ui`）
