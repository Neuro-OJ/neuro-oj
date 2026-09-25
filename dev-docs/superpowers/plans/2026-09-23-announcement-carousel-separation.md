# 公告/轮播分离实施计划（A）

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把首页轮播与公告解耦（轮播改为独立可配置的 `carousel_slides`），并给公告提供双通道展示：首页常驻「公告」区块（全部 active 公告列表）+ 导航栏下方可关闭横幅（公告字段 `banner_text`，关闭仅存前端 localStorage）。

**Architecture:** 新增 `carousel_slides` 表与轮播管理 API/页面；`announcements` 加 `banner_text` 字段；前端首页轮播改读轮播接口、新增常驻公告区块、导航栏新增可关闭横幅。横幅 dismiss **纯前端 localStorage，绑公告 id**，无后端状态。

**Tech Stack:** Deno 2 + Hono + Drizzle（noj-core）、Nuxt 4 + Vue 3 + Nuxt UI（noj-ui）、PostgreSQL。

**Spec:** [`dev-docs/superpowers/specs/2026-09-23-legal-compliance-and-announcement-separation-design.md`](../../superpowers/specs/2026-09-23-legal-compliance-and-announcement-separation-design.md)

## Global Constraints

- 提交：jj 工作流，每任务结束 `jj describe -m "<type>(<scope>): 中文描述"` 后 `jj new`；全部 GPG 签名。
- 禁止手改 `_journal.json` / `deno.lock`；迁移由 `deno task db:generate` 生成，SQL 不带 `public.` 前缀。
- 新增列禁止无 `DEFAULT` 的 `NOT NULL`（三步式）；本计划 `banner_text` 可空。
- 域间经 `index.ts` 门面；中文注释、英文标识符；`AppError` 体系。
- noj-core 测试走 `deno task test:parallel`；前端用 `useApi()`，通用组件用 Nuxt UI。
- 新写端点须有限流证据或白名单。
- 图片上传复用既有 `StorageProvider`（含类型/尺寸校验），不重造。

---

## 文件结构总览

**新增（noj-core）**

- `src/shared/db/schema/catalog.ts` 或新建 `schema/carousel.ts` — `carousel_slides`
- `src/domains/catalog/services/carousel.ts`（或 system 域，视归属）
- `src/domains/catalog/routes/carousel.ts`（公开读）+ admin 写
- 迁移（生成）

**修改（noj-core）**

- `src/shared/db/schema-system.ts`（`announcements.banner_text`，与 L 计划 T1 同迁移或独立迁移）
- `src/domains/system/routes/announcements.ts`（新增 `/banner`）
- `schema-ddl.ts`、`app.ts`

**新增/修改（noj-ui）**

- `pages/admin/carousel.vue`
- `components/feature/Carousel.vue`、`components/feature/AnnouncementSection.vue`、`components/layout/AnnouncementBanner.vue`
- `pages/index.vue`（轮播改数据源 + 常驻区块）、`components/layout/Navbar.vue`（横幅）
- `composables/useCarousel.ts`、`composables/useAnnouncementDismiss.ts`

## 任务依赖

```
Task 1 (carousel_slides 迁移)
  → Task 2 (轮播 service + 公开读 + admin CRUD)
  → Task 3 (公告 banner_text + /banner 端点)
  → Task 4 (轮播管理页前端)
  → Task 5 (首页轮播改数据源 + 常驻公告区块)
  → Task 6 (导航栏可关闭横幅 + localStorage)
  → Task 7 (公告编辑表单加 banner_text)
  → Task 8 (e2e + Agent Note)
```

---

### Task 1: `carousel_slides` 迁移

**Files:**
- Create: `noj-core/src/shared/db/schema/carousel.ts`
- Modify: `noj-core/src/shared/db/schema.ts`（barrel）
- Modify: `noj-core/src/shared/db/schema-ddl.ts`
- Create: 迁移 SQL（`db:generate`）

**Interfaces:**
- Produces: 表 `carousel_slides`；Drizzle 导出 `carouselSlides`。

- [ ] **Step 1: 建表**（spec §3.1）：列 `id` / `kind`(`image`|`text`, CHECK) / `image_storage_url`(null) / `title`(null) / `subtitle`(null) / `gradient_key`(null) / `link_url`(null) / `sort_order`(int notNull default 0) / `is_enabled`(bool notNull default true) / `created_at` / `updated_at`。索引 `(is_enabled, sort_order)`。
- [ ] **Step 2: barrel 导出** + `schema-ddl.ts` 镜像。
- [ ] **Step 3: 生成迁移并检查**：`cd noj-core && deno task db:generate`，`grep 'public\.' drizzle/00XX_*.sql` 无输出。
- [ ] **Step 4: 门禁**：`deno task test:parallel` + `deno run -A scripts/check-schema-parity.ts`。
- [ ] **Step 5: 提交**
```bash
jj describe -m "feat(core): carousel_slides 轮播表迁移"
jj new
```

---

### Task 2: 轮播 service 与路由

**Files:**
- Create: `noj-core/src/domains/catalog/services/carousel.ts`
- Create: `noj-core/src/domains/catalog/routes/carousel.ts`（公开读）
- Create: `noj-core/src/domains/admin/routes/carousel.ts`（管理）
- Modify: `noj-core/src/domains/catalog/index.ts`、`admin/index.ts`、`app.ts`
- Test: `noj-core/src/domains/catalog/tests/services/carousel.test.ts`

**Interfaces:**
- Produces:
```ts
export type CarouselSlide = { id: string; kind: "image"|"text"; image_storage_url: string|null; title: string|null; subtitle: string|null; gradient_key: string|null; link_url: string|null; sort_order: number; is_enabled: boolean };
export async function listEnabledSlides(): Promise<CarouselSlide[]>;   // 公开：仅 enabled，按 sort_order
export async function listAllSlides(): Promise<CarouselSlide[]>;       // admin
export async function createSlide(input): Promise<string>;
export async function updateSlide(id, input): Promise<void>;
export async function deleteSlide(id): Promise<void>;
export async function reorderSlides(ids: string[]): Promise<void>;
```
- 端点：`GET /api/v1/carousel/slides`（公开）；`GET/POST/PATCH/DELETE /api/v1/admin/carousel/slides`、`POST /api/v1/admin/carousel/slides/reorder`。

- [ ] **Step 1: 写失败测试**：`listEnabledSlides` 过滤 disabled 且按 sort_order；CRUD 往返；reorder 生效。
- [ ] **Step 2: 跑测试确认失败**
- [ ] **Step 3: 实现 service**（`kind=image` 时校验 `image_storage_url` 必填；`kind=text` 时校验 title 非空）。
- [ ] **Step 4: 实现路由**（公开读无认证；管理路由 `assertPermission(c, "system:settings")` 或新增 `carousel:manage`——**沿用现有公告管理权限 `announcement:manage`**）。
- [ ] **Step 5: 挂载 app.ts 与 admin/index.ts**
- [ ] **Step 6: 跑测试确认通过 + 限流门禁** → **Step 7: 提交**
```bash
jj describe -m "feat(core): 轮播 slides 服务与公开/管理路由"
jj new
```

---

### Task 3: 公告 `banner_text` + `/banner` 端点

**Files:**
- Modify: `noj-core/src/shared/db/schema/system.ts`（若 L 计划 T1 未加，则此处加）
- Modify: `noj-core/src/domains/system/services/announcements.ts`
- Modify: `noj-core/src/domains/system/routes/announcements.ts`
- Test: `noj-core/src/domains/system/tests/routes/announcements.test.ts`

**Interfaces:**
- Produces:
```ts
export async function getLatestBannerAnnouncement(): Promise<{ id: string; public_id: string; banner_text: string } | null>;
```
- 端点：`GET /api/v1/announcements/banner` → `{ data: {...} | null }`（无用户态）。

- [ ] **Step 1: 写失败测试**：无带 `banner_text` 的 active 公告时返回 null；有则返回最新一条；**注册在 `/:id` 之前**避免被参数路由捕获。
- [ ] **Step 2: 跑测试确认失败**
- [ ] **Step 3: 实现**（`banner_text IS NOT NULL AND is_active` 按 `is_pinned DESC, created_at DESC` 取 1）。
- [ ] **Step 4: 跑测试确认通过** → **Step 5: 提交**
```bash
jj describe -m "feat(core): 公告横幅字段与 /announcements/banner 端点"
jj new
```

---

### Task 4: 轮播管理页前端

**Files:**
- Create: `noj-ui/pages/admin/carousel.vue`
- Create: `noj-ui/composables/useCarousel.ts`
- Test: 页面/逻辑测试

**Interfaces:**
- Consumes: Task 2 管理 API。
- Produces: `/admin/carousel`（列表 + 新建/编辑 + 排序 + 启停 + 图片上传）。

- [ ] **Step 1: 实现页面**：`definePageMeta({ ssr: false })`；用 `AdminTable`；新建/编辑用 `AdminFormModal`（`kind` 切换 image/text；image 走上传，text 填 title/subtitle/选 `gradient_key`；`link_url` 可选）。
- [ ] **Step 2: 排序**（上移/下移或拖拽，参考既有 `TrainingProblemManager` 的排序实现）。
- [ ] **Step 3: 跑 lint/test**：`cd noj-ui && deno task lint && deno task test`
- [ ] **Step 4: 提交**
```bash
jj describe -m "feat(ui): 轮播管理页"
jj new
```

---

### Task 5: 首页轮播改数据源 + 常驻公告区块

**Files:**
- Create: `noj-ui/components/feature/Carousel.vue`（从 `index.vue` 抽出轮播）
- Create: `noj-ui/components/feature/AnnouncementSection.vue`
- Modify: `noj-ui/pages/index.vue`
- Test: 组件测试

**Interfaces:**
- Consumes: `GET /api/v1/carousel/slides`、`GET /api/v1/announcements`。
- Produces: 首页 `Carousel`（slide 驱动，无 slide 默认占位）+ `AnnouncementSection`（全部 active 公告列表，title+excerpt+「点击查看详情」）。

- [ ] **Step 1: 抽 `Carousel.vue`**：数据源改为 slides；`kind=text` 用渐变、`kind=image` 渲染图片；`link_url` 为空则整卡不可点（保留现有暂停/圆点/无障碍属性）。
- [ ] **Step 2: 写 `AnnouncementSection.vue`**：常驻（无关闭按钮），列表渲染 `announcements`（分页/限量沿用既有），每条含「点击查看详情」超链接到公告详情。
- [ ] **Step 3: 改 `index.vue`**：用 `Carousel` 替换原轮播；在合适位置插入 `AnnouncementSection`。
- [ ] **Step 4: 跑 lint/test** → **Step 5: 提交**
```bash
jj describe -m "feat(ui): 首页轮播解耦与常驻公告区块"
jj new
```

---

### Task 6: 导航栏可关闭横幅（localStorage）

**Files:**
- Create: `noj-ui/components/layout/AnnouncementBanner.vue`
- Create: `noj-ui/composables/useAnnouncementDismiss.ts`
- Modify: `noj-ui/components/layout/Navbar.vue`
- Test: composable 与组件测试

**Interfaces:**
- Consumes: `GET /api/v1/announcements/banner`。
- Produces: `useAnnouncementDismiss()` → `{ isDismissed(id): boolean; dismiss(id): void }`（localStorage key `noj:announcement-dismissed`，值为公告 id 字符串数组）。

- [ ] **Step 1: 写 composable 测试**：`dismiss(id)` 后 `isDismissed(id)=true`；不同 id 独立；localStorage 持久。
- [ ] **Step 2: 实现 composable**（读写 localStorage，SSR 安全：`import.meta.client` 守卫）。
- [ ] **Step 3: 实现 `AnnouncementBanner.vue`**：取 `/banner`；若已 dismiss 则不渲染；文字 + 末尾固定超链接「点击查看详情」；关闭按钮 → `dismiss(id)`。
- [ ] **Step 4: 挂到 `Navbar.vue`** 导航栏下方。
- [ ] **Step 5: 写组件测试**：已 dismiss 不渲染；点击关闭后消失。
- [ ] **Step 6: 跑 lint/test** → **Step 7: 提交**
```bash
jj describe -m "feat(ui): 导航栏可关闭公告横幅（localStorage 绑公告 id）"
jj new
```

---

### Task 7: 公告编辑表单加 `banner_text`

**Files:**
- Modify: `noj-ui/pages/admin/announcements.vue`（公告管理页）
- Test: 页面/逻辑测试

**Interfaces:**
- Consumes: 既有公告管理 API（`announcement:manage`）。
- Produces: 表单新增 `banner_text` 输入（留空=不出横幅），随公告保存。

- [ ] **Step 1: 写测试**：`banner_text` 留空保存为 null；填写则保存并回显。
- [ ] **Step 2: 实现**（后端 `CreateAnnouncementInput`/`UpdateAnnouncementInput` 加 `banner_text?: string | null`，一并透传）。
- [ ] **Step 3: 跑 lint/test** → **Step 4: 提交**
```bash
jj describe -m "feat(ui,core): 公告支持横幅内容字段"
jj new
```

---

### Task 8: E2E 与 Agent Note

**Files:**
- Create: `noj-tests/e2e/xx_announcement_carousel.test.ts`
- Create: `.agents/notes/implemented/feature/2026-09-23-announcement-carousel-separation.md`

- [ ] **Step 1: E2E 剧本**：管理员建轮播 slide → 公开接口返回；首页/接口联动；建带 `banner_text` 的公告 → `/banner` 返回；关闭横幅后（模拟 localStorage）不再显示（前端断言或接口侧验证无用户态）。
- [ ] **Step 2: 跑 E2E**：`cd noj-tests && deno task test:domain cross-domain`。
- [ ] **Step 3: Agent Note** + `deno run -A scripts/verify-agent-note-format.ts`。
- [ ] **Step 4: 全量验收**：`cd noj-core && deno task test:parallel`、`deno run -A scripts/check-ci.ts`。
- [ ] **Step 5: 提交**
```bash
jj describe -m "test(e2e,docs): 公告/轮播分离剧本与 Agent Note"
jj new
```

---

## Self-Review

**Spec 覆盖**：§3.1 `carousel_slides`→T1；§3.2 `banner_text`→T3/T7；§4.5 `/banner`→T3；§5.5 首页与导航→T5/T6；
§5.6 管理端（轮播管理、公告表单）→T4/T7；"关闭绑公告 id + localStorage"→T6；§7/§8→T8。

**类型一致性**：`CarouselSlide` 字段在 T2 定义，T4/T5 引用一致；`useAnnouncementDismiss` 键名 `noj:announcement-dismissed` 在 T6 内一致。

**依赖 L 计划**：`announcements.banner_text` 的迁移若已在 L 计划 T1 添加，则本计划 T3 跳过建列步骤（只做 service/路由）；
两计划同批实施时以先落地的迁移为准，避免重复建列。
