# 法律合规功能集实施计划（L）

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为 NOJ 交付 PIPL 所需的「告知—同意—行权」闭环：注册硬门槛同意、政策版本化与变更弹窗、个人信息导出、删除/更正请求通道、合规运营页与部署文档。

**Architecture:** 新增自包含 `domains/legal/` 域（拥有 3 张法律表与同意判定），经门面向 `identity` 提供同意能力（依赖方向 `identity → legal`）。前端新增 admin 合规页（复用社区配置页草稿/未保存模式），公开政策页与全局变更弹窗。政策版本不可变、只追加；重新同意**仅对 `is_material` 版本**判定。TSA 为可选 Provider，默认关闭。

**Tech Stack:** Deno 2 + Hono + Drizzle（noj-core）、Nuxt 4 + Vue 3 + Nuxt UI（noj-ui）、PostgreSQL。

**Spec:** [`dev-docs/superpowers/specs/2026-09-23-legal-compliance-and-announcement-separation-design.md`](../../superpowers/specs/2026-09-23-legal-compliance-and-announcement-separation-design.md)

## Global Constraints

- 提交：jj 工作流，每任务结束 `jj describe -m "<type>(<scope>): 中文描述"` 后 `jj new`；type ∈ feat/fix/docs/refactor/test/chore，scope ∈ core/ui/judge/root；全部提交 GPG 签名（已配置 `signing.backend=gpg`）。
- 禁止手改 `noj-core/drizzle/meta/_journal.json`、`deno.lock`、`Cargo.lock`；迁移由 `deno task db:generate` 生成。
- 迁移 SQL 不带 `public.` schema 前缀；新增列禁止 `NOT NULL` 无 `DEFAULT`（三步式）。
- 域间导入只经 `domains/<domain>/index.ts` 门面；`shared/` 不反向依赖 `domains/`。
- 中文注释/文档/提交描述，英文标识符；错误用 `AppError` 体系。
- noj-core 测试必须走 `deno task test:parallel`（优先）或 `deno task test`；禁止手拼 `deno test`。
- 前端业务代码禁止直接 `$fetch`，统一 `useApi()`；通用组件用 Nuxt UI（`U*`）。
- 新写端点必须有限流证据或白名单（`scripts/check-write-rate-limits.ts`）。
- 非平凡变更在 `.agents/notes/implemented/` 新增 Agent Note，并经 `verify-agent-note-format.ts`。
- 时间戳列为 ISO 8601 文本（`new Date().toISOString()`），与既有表一致。

---

## 文件结构总览

**新增（noj-core）**

- `src/shared/db/schema/legal.ts` — `legal_documents` / `legal_document_versions` / `user_consents` / `data_requests`
- `src/domains/legal/{index.ts, routes/{documents.ts,admin.ts}, services/{documents.ts,consent.ts,data-requests.ts,tsa.ts}, types.ts, tests/...}`
- `src/domains/identity/services/me-data-export.ts` — 个人信息导出
- 迁移 `noj-core/drizzle/00XX_*.sql`（生成）

**修改（noj-core）**

- `src/shared/db/schema.ts`（barrel 导出 legal）
- `src/shared/db/schema-ddl.ts`（PGlite 镜像）
- `src/shared/config/settings-registry.ts`（`legal` category + `legal_*` / `tsa_*`）
- `src/app.ts`（挂载 legalRouter）
- `src/domains/identity/types/permissions.ts` + `system/services/seed/seed-rbac.ts`（`legal:manage`）
- `src/domains/identity/routes/auth.ts`（register 校验 + /me 注入 legal）
- `src/domains/identity/services/auth/auth-register.ts`（同意写入）
- `src/domains/admin/index.ts`（挂载 admin legal）
- `src/domains/system/routes/index.ts` + `services/…`（移除 data_policy_*，迁移到 legal_*）

**新增/修改（noj-ui）**

- `pages/admin/legal.vue`、`pages/legal/privacy.vue`、`pages/legal/terms.vue`
- `components/legal/LegalConsentModal.vue`
- `pages/register.vue`（复选框）、`components/layout/FooterBar.vue`（备案 + 链接）
- `composables/useLegal.ts`

**文档**

- `noj-docs/docs/operators/legal-compliance.md`

## 任务依赖

```
Task 1 (迁移+schema)
  → Task 2 (legal 域 service: documents/consent)
  → Task 3 (权限 legal:manage)
  → Task 4 (公开路由)
  → Task 5 (注册硬门槛 + 同意写入)
  → Task 6 (/me 注入 legal + 同意端点)
  → Task 7 (配置项 legal_* / tsa_* + data_policy 迁移)
  → Task 8 (admin 路由：文档/版本/请求管理)
  → Task 9 (TSA provider)
  → Task 10 (数据导出)
  → Task 11 (data_requests)
  → Task 12 (admin 合规页前端)
  → Task 13 (公开政策页 + 页脚)
  → Task 14 (注册页复选框)
  → Task 15 (变更弹窗)
  → Task 16 (doc: legal-compliance.md)
  → Task 17 (e2e + Agent Note)
```

---

### Task 1: 数据迁移——法律表与既有表改动

**Files:**
- Modify: `noj-core/src/shared/db/schema/legal.ts`（新建）
- Modify: `noj-core/src/shared/db/schema.ts`（barrel）
- Modify: `noj-core/src/shared/db/schema/system.ts`（`announcements.banner_text`）
- Modify: `noj-core/src/shared/db/schema-ddl.ts`（PGlite 镜像）
- Create: `noj-core/drizzle/00XX_*.sql`（`db:generate` 生成）

**Interfaces:**
- Produces: 表 `legal_documents` / `legal_document_versions` / `user_consents` / `data_requests`；
  Drizzle 导出 `legalDocuments` / `legalDocumentVersions` / `userConsents` / `dataRequests`；`announcements.banner_text: string | null`。

- [ ] **Step 1: 新建 `schema/legal.ts`**

按 spec §3.1 定义四张表（`pgTable`、列类型、CHECK、UNIQUE、FK）。关键约束：
`legal_documents.kind IN ('privacy','terms')`；`data_requests.kind IN ('delete','correct')`、
`status IN ('pending','processing','resolved','rejected')`；`UNIQUE(legal_documents.kind)`、
`UNIQUE(legal_document_versions.document_id, version)`、`UNIQUE(user_consents.user_id, document_kind, version)`。
表用 `publicIdColumn` 仅当 spec 要求公开 id（本组表不要求，用普通 text PK）。
时间列一律 `text("...").notNull()`，ISO 8601。

- [ ] **Step 2: barrel 导出**

`src/shared/db/schema.ts` 追加 `export * from "./legal.ts";`。

- [ ] **Step 3: `announcements` 加 `banner_text`**

在 `schema/system.ts` 的 `announcements` 表 `content` 之后加：
`banner_text: text("banner_text"),`（可空，无 CHECK）。

- [ ] **Step 4: 生成迁移并检查**

Run: `cd noj-core && deno task db:generate`
Expected: 生成新 SQL；`grep 'public\.' drizzle/00XX_*.sql` 无输出；`_journal.json` 自动更新（勿手改）。

- [ ] **Step 5: 同步 `schema-ddl.ts`**

PGlite 镜像加四张表与 `banner_text` 列（与迁移逐字对齐，供 `check-schema-parity` 校验）。

- [ ] **Step 6: 跑迁移与一致性门禁**

Run: `cd noj-core && deno task test:parallel` 与 `deno run -A scripts/check-schema-parity.ts`
Expected: 全绿。

- [ ] **Step 7: 提交**

```bash
jj describe -m "feat(core): 法律合规表迁移（legal_documents/versions/user_consents/data_requests + banner_text）"
jj new
```

---

### Task 2: legal 域——文档与同意服务

**Files:**
- Create: `noj-core/src/domains/legal/types.ts`
- Create: `noj-core/src/domains/legal/services/documents.ts`
- Create: `noj-core/src/domains/legal/services/consent.ts`
- Create: `noj-core/src/domains/legal/index.ts`
- Test: `noj-core/src/domains/legal/tests/services/documents.test.ts`、`consent.test.ts`

**Interfaces:**
- Produces:
```ts
// documents.ts
export type LegalKind = "privacy" | "terms";
export type LegalDocument = { version: number; content: string; content_hash: string; is_material: boolean };
export async function getCurrentDocument(kind: LegalKind): Promise<LegalDocument | null>;
export async function getRequiredConsentVersion(kind: LegalKind): Promise<number>; // 最近 is_material 版本；无则 0
export async function listVersions(kind: LegalKind): Promise<{ version: number; published_at: string; is_material: boolean; change_summary: string | null }[]>;
export async function publishVersion(kind: LegalKind, content: string, changeSummary: string | null, isMaterial: boolean, userId: string): Promise<number>;
export function hashContent(content: string): string; // 规范化后 SHA-256
// consent.ts
export async function getUserConsent(userId: string, kind: LegalKind): Promise<{ version: number; agreed_at: string } | null>;
export async function recordConsent(userId: string, kind: LegalKind, version: number, hash: string, ip: string | null, ua: string | null): Promise<void>;
export async function recordConsentsForRegistration(userId: string, ip: string | null, ua: string | null): Promise<void>; // 事务内写 privacy+terms 当前版本
```

- [ ] **Step 1: 写失败测试（documents）**

覆盖：无文档时 `getCurrentDocument` 返回 null；`publishVersion` 后 version 递增、`content_hash` 稳定（同内容同 hash）；`getRequiredConsentVersion` 只认 `is_material`（非重大版本发布后返回值不变）。

- [ ] **Step 2: 跑测试确认失败**
Run: `cd noj-core && deno task test -- documents.test.ts`
Expected: FAIL（模块不存在）。

- [ ] **Step 3: 实现 `documents.ts`**

`hashContent`：对 content 做规范化（统一换行 `\r\n→\n`、去尾部空白）后 SHA-256（用 `crypto.subtle` 或既有 hash 工具）。
`getCurrentDocument` 按 `current_version` 取版本行；`getRequiredConsentVersion` 取 `is_material=true` 的 `MAX(version)`。
`publishVersion` 在事务内：`current_version+1` → 插入版本行（含 hash）→ 更新 `legal_documents.current_version`；若 `is_material` 且 TSA 启用则调 `tsa.ts`（Task 9 留接口，本任务先不实现调用）。

- [ ] **Step 4: 写失败测试（consent）+ 实现**

覆盖：`recordConsent` 幂等（重复同 version 不报错/不重复计数）；`getUserConsent` 取 `MAX(version)`；
`recordConsentsForRegistration` 一次写两条。

- [ ] **Step 5: 门面 `index.ts` 导出上述符号**

- [ ] **Step 6: 跑测试确认通过 + 导出 JSDoc**
Run: `cd noj-core && deno task test -- documents.test.ts consent.test.ts` 与 `deno run -A scripts/verify-export-jsdoc.ts`
Expected: PASS。

- [ ] **Step 7: 提交**
```bash
jj describe -m "feat(core): legal 域文档与同意服务（哈希、版本、同意记录）"
jj new
```

---

### Task 3: RBAC 新增 `legal:manage`

**Files:**
- Modify: `noj-core/src/domains/identity/types/permissions.ts`
- Modify: `noj-core/src/domains/system/services/seed/seed-rbac.ts`
- Test: `noj-core/src/domains/identity/tests/services/rbac.test.ts`

**Interfaces:**
- Produces: 权限字符串 `legal:manage`；root/admin 自动获得。

- [ ] **Step 1: 写失败测试**
```ts
Deno.test({ name: "rbac: 默认角色具备 legal:manage", ignore: !hasDbEnv(), sanitizeResources: false, sanitizeOps: false, async fn() {
  await resetDbForTest();
  await ensureRbacSeeds();
  assert((await getUserPermissions(adminUserId)).has("legal:manage"));
}});
```
- [ ] **Step 2: 跑测试确认失败**
- [ ] **Step 3: 实现**：`PERMISSION_DEFS` 加 `{ resource: "legal", action: "manage", description: "法律与合规管理" }`；`seed-rbac.ts` 给 root/admin 授予（default 用户不授予）。
- [ ] **Step 4: 跑测试确认通过** → **Step 5: 提交**
```bash
jj describe -m "feat(core): RBAC 新增 legal:manage 权限"
jj new
```

---

### Task 4: legal 公开路由

**Files:**
- Create: `noj-core/src/domains/legal/routes/documents.ts`
- Create: `noj-core/src/domains/legal/routes/index.ts`
- Modify: `noj-core/src/app.ts`
- Test: `noj-core/src/domains/legal/tests/routes/documents.test.ts`

**Interfaces:**
- Consumes: Task 2 服务。
- Produces: `GET /api/v1/legal/documents`、`GET /api/v1/legal/documents/:kind/versions`。

- [ ] **Step 1: 写失败测试**：`GET /legal/documents` 返回 `{ data: { privacy, terms } }`（未发布时各为 null）；`:kind` 非法返回 400。
- [ ] **Step 2: 跑测试确认失败**
- [ ] **Step 3: 实现路由**（无认证，只读；`:kind` 白名单校验）。
- [ ] **Step 4: app.ts 挂载**：`app.route("/api/v1", legalRouter);`
- [ ] **Step 5: 跑测试确认通过**（含 `check-write-rate-limits`——只读端点无需限流）→ **Step 6: 提交**
```bash
jj describe -m "feat(core): legal 公开文档路由"
jj new
```

---

### Task 5: 注册硬门槛 + 同意写入

**Files:**
- Modify: `noj-core/src/domains/identity/types/auth.ts`（`RegisterInput` 加 `accepted_legal: boolean`）
- Modify: `noj-core/src/domains/identity/routes/auth.ts`
- Modify: `noj-core/src/domains/identity/services/auth/auth-register.ts`
- Test: `noj-core/src/domains/identity/tests/routes/auth.test.ts`、`tests/services/auth-register.test.ts`

**Interfaces:**
- Consumes: `legal.recordConsentsForRegistration`（Task 2）。
- Produces: register 不接受 `accepted_legal !== true`；成功后 `user_consents` 有 2 行。

- [ ] **Step 1: 写失败测试**
```ts
Deno.test("auth: 注册缺 accepted_legal 返回 400", async () => {
  const res = await jsonRequest(app, "POST", "/api/v1/auth/register",
    { username: "u_legal1", email: "l1@example.test", password: "Password1" });
  assertEquals(res.status, 400);
});
Deno.test("auth: 注册成功后写入两条同意记录", async () => {
  // 发布 privacy/terms 各一版（测试夹具），注册带 accepted_legal:true，
  // 断言 user_consents 两行、version = 当前版本、ip 非空
});
```
- [ ] **Step 2: 跑测试确认失败**
- [ ] **Step 3: 实现**：路由层校验 `accepted_legal === true` 否则 `BadRequestError("必须同意服务条款与隐私政策")`；
  `registerUser(input, clientIp, ua)` 在**用户插入同一 `db.transaction` 内**调
  `recordConsentsForRegistration(id, clientIp, ua)`（同事务传入 `tx`，避免部分写入）。
- [ ] **Step 4: 跑测试确认通过** → **Step 5: 提交**
```bash
jj describe -m "feat(core): 注册强制同意并写入同意记录"
jj new
```

---

### Task 6: `/auth/me` 注入 legal 状态 + 同意端点

**Files:**
- Modify: `noj-core/src/domains/identity/routes/auth.ts`
- Create: `noj-core/src/domains/legal/routes/consent.ts`
- Modify: `noj-core/src/domains/legal/routes/index.ts`
- Test: `noj-core/src/domains/legal/tests/routes/consent.test.ts`

**Interfaces:**
- Produces: `/auth/me` 的 `data.legal`（见 spec §4.4）；`POST /api/v1/legal/consent` body `{ kind }`。

- [ ] **Step 1: 写失败测试**
  - 未同意时 `/me` 返回 `legal.privacy.needs_consent=true`；
  - 发布 `is_material` 新版本后，已同意旧版的用户 `needs_consent=true`；发布**非重大**版本后 `needs_consent=false`；
  - `POST /legal/consent` 写记录并使 `needs_consent=false`；未登录 401；非法 kind 400。
- [ ] **Step 2: 跑测试确认失败**
- [ ] **Step 3: 实现**：`/me` 组装 `legal`（对两种 kind 各查 `getRequiredConsentVersion` + `getUserConsent`）；
  consent 路由 `authMiddleware` + `enforceRateLimit`（复用 `hardening-rate-limit` 的通用函数，键 `legal-consent:user:<id>`）。
- [ ] **Step 4: 登记限流门禁**：确保新写端点被 `check-write-rate-limits` 识别（如该脚本要求注释标记，按既有格式加）。
- [ ] **Step 5: 跑测试确认通过 + 门禁** → **Step 6: 提交**
```bash
jj describe -m "feat(core): /auth/me 注入法律同意状态并新增同意端点"
jj new
```

---

### Task 7: 配置项 `legal_*` / `tsa_*` + `data_policy_*` 迁移

**Files:**
- Modify: `noj-core/src/shared/config/settings-registry.ts`（加 `legal` category 与条目）
- Modify: `noj-ui/pages/admin/settings.vue`（`CATEGORY_LABEL` 加 `legal: "法律与合规"`）
- Modify: `noj-core/src/domains/system/routes/index.ts`（`/data-policy` 改读 `legal_*`）
- Create: `noj-core/drizzle/00XX_*.sql`（若需要数据迁移：旧 `data_policy_*` → `legal_*`）

**Interfaces:**
- Produces: 配置键 `legal_operator_name` / `legal_contact` / `legal_icp_number` / `legal_icp_url` / `legal_police_number` / `legal_police_url` / `legal_third_parties` / `tsa_provider` / `tsa_url` / `tsa_root_cert`。

- [ ] **Step 1: 注册配置项**（`type`：多为 string；`legal_third_parties` 为 text；`tsa_provider` default `"disabled"`；scope `runtime`；`is_secret` 仅 `tsa_root_cert` 视需要）。
- [ ] **Step 2: 数据迁移**：迁移 SQL `INSERT ... SELECT` 把 `data_policy_contact → legal_contact`、`data_policy_deployment → legal_operator_name`（存在才迁），并删除旧键行。
- [ ] **Step 3: `/data-policy` 端点改读新键**（保持响应结构 `{ contact, deployment }` 兼容前端，映射自 `legal_contact` / `legal_operator_name`）。
- [ ] **Step 4: 登记校验**：`deno task check:env`（`.env.example` 若含相关键需同步）、`deno run -A scripts/check-config-usage.ts`。
- [ ] **Step 5: 跑测试**：`deno task test:parallel`（settings 相关）。
- [ ] **Step 6: 提交**
```bash
jj describe -m "feat(core): legal/tsa 配置项与 data_policy 键迁移"
jj new
```

---

### Task 8: admin legal 路由（文档发布 / 版本 / 请求管理）

**Files:**
- Create: `noj-core/src/domains/legal/routes/admin.ts`
- Modify: `noj-core/src/domains/admin/index.ts`
- Test: `noj-core/src/domains/legal/tests/routes/admin.test.ts`

**Interfaces:**
- Consumes: Task 2、Task 11。
- Produces:
  - `GET /api/v1/admin/legal/documents/:kind`
  - `POST /api/v1/admin/legal/documents/:kind/versions` body `{ content, change_summary?, is_material }`
  - `GET /api/v1/admin/legal/data-requests`、`PATCH /api/v1/admin/legal/data-requests/:id`

- [ ] **Step 1: 写失败测试**：非 `legal:manage` 访问 403；发布版本后 `current_version` 递增；非法 kind 400。
- [ ] **Step 2: 跑测试确认失败**
- [ ] **Step 3: 实现**：管理路由用 `assertPermission(c, "legal:manage")`（参考 `admin/routes/system.ts` 的公告管理模式）；发布调 `publishVersion`。
- [ ] **Step 4: 挂载**：`admin/index.ts` 加 `router.route("/legal", legalAdminRouter);`。
- [ ] **Step 5: 跑测试确认通过 + 限流门禁** → **Step 6: 提交**
```bash
jj describe -m "feat(core): admin legal 路由（发布/版本/请求管理）"
jj new
```

---

### Task 9: TSA 可选 Provider

**Files:**
- Create: `noj-core/src/domains/legal/services/tsa.ts`
- Modify: `noj-core/src/domains/legal/services/documents.ts`（`publishVersion` 调用）
- Test: `noj-core/src/domains/legal/tests/services/tsa.test.ts`

**Interfaces:**
- Produces:
```ts
export type TsaResult = { provider: string; token: string; chain: string } | null;
export async function timestampHash(hashHex: string): Promise<TsaResult>;
```
- `tsa_provider=disabled` → 直接返回 null；`freetsa`/`digicert` 用内置 URL；`custom` 用 `tsa_url` + `tsa_root_cert`。
- RFC 3161 请求（`certReq=true` 以带回证书链）；失败返回 null 并记录 warn，**不抛**。

- [ ] **Step 1: 写失败测试**（用 mock fetch）：disabled 返回 null；成功解析 token+chain；网络错误返回 null 且不抛。
- [ ] **Step 2: 跑测试确认失败**
- [ ] **Step 3: 实现** RFC 3161 请求/解析（`sha256` messageImprint，`Content-Type: application/timestamp-query`）。
- [ ] **Step 4: `publishVersion` 接线**：`is_material` 且 provider≠disabled 时打戳，结果写 `tsa_*` 列；失败置 null。
- [ ] **Step 5: 跑测试确认通过** → **Step 6: 提交**
```bash
jj describe -m "feat(core): 可选 TSA Provider（RFC 3161，只戳政策版本）"
jj new
```

---

### Task 10: 个人信息导出

**Files:**
- Create: `noj-core/src/domains/identity/services/me-data-export.ts`
- Modify: `noj-core/src/domains/identity/routes/users.ts`（或 auth，取决于 `/me` 路由归属）
- Test: `noj-core/src/domains/identity/tests/routes/data-export.test.ts`

**Interfaces:**
- Produces: `GET /api/v1/me/data-export` → JSON `{ account, submissions, community, consents, exported_at }`。

- [ ] **Step 1: 写失败测试**：未登录 401；返回含 `consents`；不泄漏他人数据。
- [ ] **Step 2: 跑测试确认失败**
- [ ] **Step 3: 实现**：聚合查询（用户自身行）；`Content-Disposition: attachment`；限流（`enforceRateLimit`，键 `data-export:user:<id>`，低频）。
- [ ] **Step 4: 跑测试确认通过 + 限流门禁** → **Step 5: 提交**
```bash
jj describe -m "feat(core): 个人信息导出端点（PIPL 查阅/复制权）"
jj new
```

---

### Task 11: 删除/更正请求通道

**Files:**
- Create: `noj-core/src/domains/legal/services/data-requests.ts`
- Create: `noj-core/src/domains/legal/routes/data-requests.ts`
- Modify: `noj-core/src/domains/legal/routes/index.ts`
- Test: `noj-core/src/domains/legal/tests/services/data-requests.test.ts`、`routes/data-requests.test.ts`

**Interfaces:**
- Produces:
```ts
export async function createDataRequest(userId, kind, targetType, targetId, detail): Promise<string>;
export async function listUserDataRequests(userId): Promise<DataRequest[]>;
export async function listAllDataRequests(status?): Promise<DataRequest[]>;
export async function updateDataRequestStatus(id, status, handledBy, resolution): Promise<void>;
```
- 端点：`POST/GET /api/v1/me/data-requests`。

- [ ] **Step 1: 写失败测试**：创建后能查到（仅本人）；状态机非法转换拒绝；未登录 401。
- [ ] **Step 2: 跑测试确认失败**
- [ ] **Step 3: 实现**（状态机 `pending→processing→resolved|rejected`）。
- [ ] **Step 4: 跑测试确认通过 + 限流门禁** → **Step 5: 提交**
```bash
jj describe -m "feat(core): 删除/更正请求通道"
jj new
```

---

### Task 12: admin 合规页前端

**Files:**
- Create: `noj-ui/pages/admin/legal.vue`
- Create: `noj-ui/composables/useLegal.ts`
- Modify: `noj-ui/middleware/admin.ts`（如按路径细分权限则加 legal）
- Test: `noj-ui/tests/...`（组件/逻辑测试，按既有 UI 测试模式）

**Interfaces:**
- Consumes: Task 8 管理 API、Task 7 配置 API。
- Produces: `/admin/legal`，7 个 Tab（隐私政策/服务条款/备案与主体/第三方服务/内容审查/留存期限/TSA）。

- [ ] **Step 1: 写草稿逻辑测试**：本地草稿 + `hasUnsaved` 计算（对齐 `admin/community.vue` 的 `hasUnsaved`/`saveAll`/`discardAll` 模式）。
- [ ] **Step 2: 实现页面**：`definePageMeta({ ssr: false })`；Tab 内 markdown 编辑（复用 `MarkdownRenderer` 预览）；发布确认弹框 + 「标记为重大变更」；**不做 preset**。
- [ ] **Step 3: 内容审查/留存 Tab** 仅聚合既有设置项（只读跳转或内联编辑，按既有 settings 页模式）。
- [ ] **Step 4: 跑 UI 测试/构建**：`cd noj-ui && deno task lint && deno task test`
- [ ] **Step 5: 提交**
```bash
jj describe -m "feat(ui): 法律与合规管理页"
jj new
```

---

### Task 13: 公开政策页 + 页脚

**Files:**
- Create: `noj-ui/pages/legal/privacy.vue`、`noj-ui/pages/legal/terms.vue`
- Modify: `noj-ui/pages/data-policy.vue`（重定向或改造）
- Modify: `noj-ui/components/layout/FooterBar.vue`
- Test: 页面测试

**Interfaces:**
- Consumes: `GET /api/v1/legal/documents`。
- Produces: `/legal/privacy`、`/legal/terms` 渲染 markdown；页脚显示备案（未配置不渲染）+ 条款链接。

- [ ] **Step 1: 写测试**：未配置备案时不渲染备案节点；链接指向 `/legal/privacy`。
- [ ] **Step 2: 实现**：用 `useAsyncData` 取文档，`MarkdownRenderer` 渲染；`/data-policy` 重定向到 `/legal/privacy`。
- [ ] **Step 3: 跑 lint/test** → **Step 4: 提交**
```bash
jj describe -m "feat(ui): 公开隐私政策/服务条款页与页脚备案展示"
jj new
```

---

### Task 14: 注册页同意复选框

**Files:**
- Modify: `noj-ui/pages/register.vue`
- Modify: `noj-ui/composables/useAuth.ts`（`register` 透传 `accepted_legal`）
- Test: 页面测试

**Interfaces:**
- Produces: 未勾选时提交按钮禁用；请求体含 `accepted_legal: true`。

- [ ] **Step 1: 写测试**：未勾选提交不触发请求；勾选后可提交。
- [ ] **Step 2: 实现**：复选框 + 文案
  `☐ 我已年满 14 周岁，或在监护人陪同下已阅读并同意《服务条款》与《隐私政策》`
  （链接到 `/legal/terms`、`/legal/privacy`）。
- [ ] **Step 3: 跑 lint/test** → **Step 4: 提交**
```bash
jj describe -m "feat(ui): 注册页法律同意复选框（含未成年人提示）"
jj new
```

---

### Task 15: 政策变更弹窗

**Files:**
- Create: `noj-ui/components/legal/LegalConsentModal.vue`
- Modify: `noj-ui/layouts/default.vue`（挂载）
- Modify: `noj-ui/composables/useAuth.ts`（读取 `user.legal`）
- Test: 组件测试

**Interfaces:**
- Consumes: `/auth/me` 的 `data.legal`、`POST /api/v1/legal/consent`。
- Produces: `legal.needs_consent && is_material` 时弹不可关闭弹窗。

- [ ] **Step 1: 写测试**：`needs_consent=false` 不渲染；`=true` 且 `is_material` 渲染且无关闭按钮；点击同意调用端点。
- [ ] **Step 2: 实现**：展示文档名、版本区间、`change_summary`；「我已知悉并同意」→ `POST /legal/consent` → 刷新 `fetchUser()`。
- [ ] **Step 3: 跑 lint/test** → **Step 4: 提交**
```bash
jj describe -m "feat(ui): 政策重大变更同意弹窗"
jj new
```

---

### Task 16: 部署文档 legal-compliance.md

**Files:**
- Create: `noj-docs/docs/operators/legal-compliance.md`
- Modify: `noj-docs/docs/operators/index.md`（加链接）

**Interfaces:**
- Produces: 覆盖 spec §6 全部小节，含「可能收集的信息」清单 + 免责声明 + `llm_usage` 必要性声明。

- [ ] **Step 1: 写文档**（照 spec §6 / §6.1 结构；信息清单从代码实据，逐表列数据与第三方接收方）。
- [ ] **Step 2: 校验**：`deno run -A scripts/verify-md-links.ts`
- [ ] **Step 3: 提交**
```bash
jj describe -m "docs(root): 部署者法律合规指导（含信息收集清单与免责声明）"
jj new
```

---

### Task 17: E2E 与 Agent Note

**Files:**
- Create: `noj-tests/e2e/xx_legal_compliance.test.ts`
- Create: `.agents/notes/implemented/feature/2026-09-23-legal-compliance.md`

- [ ] **Step 1: E2E 剧本**：注册（不勾选→400；勾选→成功且库有同意）；发重大新版→登录用户 `/me` `needs_consent=true`→同意后 false；非重大版本不触发。
- [ ] **Step 2: 跑 E2E**：`cd noj-tests && deno task test:domain cross-domain`（或按 E2E_TESTING.md）。
- [ ] **Step 3: 写 Agent Note**（Problem/Decision/Alternatives/Consequences）并校验：
  `deno run -A scripts/verify-agent-note-format.ts`
- [ ] **Step 4: 全量验收**：`cd noj-core && deno task test:parallel`、`deno run -A scripts/check-ci.ts`
- [ ] **Step 5: 提交**
```bash
jj describe -m "test(e2e,docs): 法律合规剧本与 Agent Note"
jj new
```

---

## Self-Review

**Spec 覆盖**：§3 数据模型→T1；§4.1 域→T2/T3；§4.2 公开读→T4；§4.3 注册→T5；§4.4 状态/重新同意→T6；
§4.5 横幅→（属 A 计划）；§4.6 导出→T10；§4.7 请求→T11；§4.8 TSA→T9；§4.9 横切→各任务门禁；
§3.3 配置→T7；§5.1 admin 页→T12；§5.2/5.3 公开页与注册→T13/T14；§5.4 弹窗→T15；§6 文档→T16；§7/§8→T17。
M1 页脚备案→T13；M6 主体信息→T7/T13；M4 留存聚合→T12（内容审查/留存 Tab）。

**类型一致性**：`getRequiredConsentVersion`/`getUserConsent`/`recordConsent`/`publishVersion` 在 T2 定义，T4/T6/T8/T9 引用一致；
`LegalKind` 统一 `"privacy" | "terms"`。

**未决**：`check-write-rate-limits` 的注释标记格式以执行时脚本要求为准（T6/T10/T11 中已列为显式步骤）。
