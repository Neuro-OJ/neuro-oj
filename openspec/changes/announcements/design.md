## Context

公告系统（issue #231）落地前需要定夺的关键点：

1. **数据落点**：独立 `announcements` 表 vs 复用 `systemSettings` 键值（`schema.ts:667`）。验收标准要求「置顶排序生效」+「公开列表分页」+「发布/下架」，KV 形态无法支撑多公告的分页、排序、单条状态管理。
2. **首页形态**：现有首页左栏「公告轮播」（`pages/index.vue:7-60`）是硬编码 3 条渐变卡片（`index.vue:105-121`，仅 title + description，aria-label="公告轮播"），是天然的公告展示位。
3. **推送链路**：`lib/event-bus.ts` 已有成熟的 Redis Pub/Sub + 本地 EventEmitter 机制（`Channels` 常量 + `publishEvent` + `onEvent`），`routes/sse.ts` 把 Redis 事件映射为 SSE 事件名（如 `submission:updated`、`queue:changed`、`stats:updated`）；前端 `useEventSource`（`composables/useEventSource.ts`）统一消费 SSE + 30s 轮询 fallback。

用户已拍板两个决策：① 首页轮播改为公告驱动 + 点击看全文；② 包含公开公告列表页 + 详情页。

## Goals / Non-Goals

**Goals:**
- 独立 `announcements` 表承载公告，置顶优先 + 分页查询，发布/下架状态管理
- 公开 API + 管理 API（admin CRUD、审计日志），`announcement:manage` 细粒度权限
- 首页轮播公告驱动（删除硬编码）、公开列表页 + 详情页、管理后台页
- SSE 全局广播 `announcement:updated`，前端实时刷新（轮询 fallback 兜底）

**Non-Goals:**
- 不做公告的定时发布/定时下架（本期仅手动发布/下架）
- 不做公告的阅读统计、已读状态
- 不做通知中心（铃铛）的公告聚合推送（SSE 横幅刷新已覆盖实时性诉求；社区通知中心保持现状）
- 不新增公告封面图/富文本字段（content 为 Markdown 文本，渐变背景按轮播下标循环预设色）

## Decisions

### D1: 数据落点 — 独立 announcements 表

`systemSettings` 是 KV 键值（单值 JSON），无法支撑「置顶排序 + 分页 + 单条发布/下架」的验收要求；独立表沿用既有 Drizzle 表风格（text 主键 uuid、ISO 8601 text 时间戳）：

- `id` TEXT PK（uuid）
- `title` TEXT NOT NULL
- `content` TEXT NOT NULL（Markdown）
- `is_pinned` BOOLEAN NOT NULL DEFAULT FALSE
- `is_active` BOOLEAN NOT NULL DEFAULT TRUE（下架 = false）
- `created_by` TEXT NOT NULL REFERENCES `users(id)`
- `created_at` TEXT NOT NULL、`updated_at` TEXT NOT NULL（ISO 8601）
- 索引：`idx_announcements_active_pinned_created` ON `(is_active, is_pinned, created_at)`（公开列表查询）

### D2: 公开列表排序与分页

- 公开列表仅返回 `is_active=true`；排序 `is_pinned DESC, created_at DESC`（置顶优先，置顶内部与未置顶内部均按最新在前）
- 分页沿用 `lib/pagination.ts` 的 `parsePagination` / `buildPaginationMeta`（page/per_page，默认 20）
- 响应 `{ data: Announcement[], meta: { page, per_page, total } }`，列表项不含 `content` 全文（仅标题 + 摘要字段，减载）；详情接口返回全文

### D3: API 契约

公开：
- `GET /api/v1/announcements`：仅 active，置顶优先 + 分页；列表项字段 `id / title / is_pinned / created_at / updated_at`（+ `excerpt` 摘要，content 截断前 120 字符）
- `GET /api/v1/announcements/:id`：active 公告详情（含 `content` 全文与 `created_by`）；非 active 返回 404

管理（`routes/admin.ts` 组级 adminMiddleware 下）：
- `GET /api/v1/admin/announcements`：全量列表（含未发布/已下架），分页 + 可选 `is_active` 筛选
- `POST /api/v1/admin/announcements`：创建（title、content、is_pinned、is_active），校验非空
- `PUT /api/v1/admin/announcements/:id`：更新（字段部分更新语义）；发布/下架统一为更新 `is_active`
- `DELETE /api/v1/admin/announcements/:id`：物理删除
- 所有写操作记录审计日志（复用 `logAudit`，action `announcement.create / announcement.update / announcement.delete`）

### D4: 权限 — announcement:manage

- `PERMISSION_DEFS`（`types/index.ts:144`）新增 `{ resource: "announcement", action: "manage", description: "管理公告" }`
- `ADMIN_DEFAULT_PERMISSIONS`（`seed-rbac.ts`）加入该项（admin 角色显式授权 + `admin:full_access` 通配双保险，与 `system:settings` 同模式）
- admin handler 内 `await assertPermission(c, "announcement:manage")` 细粒度检查（非 admin 且无该权限 → 403）

### D5: SSE 广播

- `Channels`（`lib/event-bus.ts`）新增全局频道 `noj:events:announcements`
- 服务层创建/更新/删除后 `publishEvent(Channels.announcements, JSON.stringify({ type: "announcement:updated" }))`（fire-and-forget，不阻塞写流程）
- 监听注册在**独立 SSE 端点 `GET /api/v1/announcements/events`**（`routes/announcements.ts` 内，位于 `/:id` 参数路由之前），收到事件后以 SSE 事件名 `announcement:updated` 向订阅该端点的客户端推送（与 `queue:changed` 同模式，data 仅作触发通知）
- **偏离说明（工程妥协）**：原计划在全局 SSE 端点（`routes/sse.ts`）注册监听，但 sse 实例挂载时带全局 `authMiddleware`，会拦截所有挂载在其后的公开路由（见 `app.ts` 挂载注释）。公告 SSE 端点因此注册在公告路由实例内、挂载于 sse 实例之前，行为等价（客户端订阅 `/api/v1/announcements/events` 即可收到广播），spec 文本（`specs/sse-endpoints/spec.md`）已同步此实现
- 前端 `useEventSource` 监听 `announcement:updated` → 重拉公告列表（轮播数据源）；页面加载拉取为 fallback

### D6: UI 形态

- **首页轮播**（`pages/index.vue`）：删除硬编码数组，改为 `GET /api/v1/announcements?per_page=5` 驱动；渲染标题 + 摘要（Markdown 纯文本剥离）；点击跳 `/announcements/[id]`；空态显示默认欢迎占位（保持现状文案）；渐变背景按轮播下标循环 3 个预设色（不新增 DB 字段）；SSE 收到 `announcement:updated` 后重拉
- **公开列表页** `/announcements`：置顶徽标 + 标题列表 + 分页（复用 `PaginationNav`），行点击进详情
- **详情页** `/announcements/[id]`：标题 + 发布时间 + 置顶徽标 + Markdown 全文（复用 `MarkdownRenderer`）
- **管理页** `pages/admin/announcements.vue`：`useAdminList` 分页列表（标题/置顶/发布状态/时间/操作），新建/编辑表单（标题 + Markdown 文本域 + 置顶开关 + 发布状态开关），发布/下架 = 编辑表单切换；`layouts/admin.vue` navGroups「内容与评测」组新增「公告管理」入口

### D7: 内容校验

- `title` 1–100 字符、`content` 1–50000 字符（与社区帖子同量级）；非法输入返回 400
- 列表摘要：Markdown 源码截断 120 字符（服务端计算，避免前端依赖）

## Risks

- SSE 广播依赖 Redis 可用：事件丢失由页面加载/轮询 fallback 兜底（与既有事件同机制，无新增风险）
- `is_pinned` 排序无固定 pin 时间字段：置顶公告之间按 `created_at` 排序，若运营需要手动排序可后续加 `pinned_at`（YAGNI，本期不做）
