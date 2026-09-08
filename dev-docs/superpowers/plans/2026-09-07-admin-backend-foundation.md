# Admin 后端基础实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** 建立 `domains/admin` 统一门面域骨架，提供统一审计封装与乐观锁基础，为后续 sub domain 迁移打地基。

**Architecture:** 在 noj-core 新增 `domains/admin` 域，先承接现有 admin 路由组合；新增 `admin-audit` 统一审计入口和 `admin-version` 乐观锁工具。API 路径暂不改变，后续 sub domain 迁移计划再切换。

**Tech Stack:** Deno 2、Hono、Drizzle ORM、postgres.js、Deno test

**Spec:** `dev-docs/superpowers/specs/2026-09-07-admin-ui-redesign-design.md`

## Global Constraints

- 所有代码标识符使用英文，注释/提交信息使用中文。
- 禁止修改 `_journal.json`；迁移只能通过 `deno task db:generate` 追加。
- 禁止手动修改 `deno.lock`。
- 测试必须通过 `deno task` 运行，不要直接手拼 `deno test`。
- 搜索代码使用 `rg`，不要使用 `grep`。
- 提交必须使用 jj 且带 GPG 签名（仓库已配置 `signing.sign-all = true`）。

---

### Task 1: 创建 admin 域骨架并切换 app 挂载

**Files:**
- Create: `noj-core/src/domains/admin/index.ts`
- Modify: `noj-core/src/app.ts:5`（import admin）
- Modify: `noj-core/src/app.ts:75`（`app.route("/api/v1/admin", admin)` 保持不动，仅 import 来源变化）
- Delete: `noj-core/src/routes/admin/index.ts`

**Interfaces:**
- Consumes: 现有 `identityAdminRouter`、`catalogAdminRouter`、`submissionAdminRouter`、`queryAdminRouter`、`contestAdminRouter`、`systemAdminRouter`、`gatewayAdminRouter`。
- Produces: `adminRouter`（默认导出），挂载前缀 `/api/v1/admin`。

- [x] **Step 1: 创建 `domains/admin/index.ts`**

将旧 `routes/admin/index.ts` 内容迁移到新路径，并修正相对导入路径：

```ts
/**
 * 管理端路由组合入口（barrel）。
 *
 * 提供（挂载前缀 /api/v1/admin，见 app.ts）：
 * - /users、/problems、/submissions、/contests、/judge-images、
 *   /dashboard/stats、/settings、/blacklist、/audit-logs、/roles、/permissions、
 *   /announcements、/trainings、/llm/...
 *
 * 组级守卫：所有 admin 端点均需认证 + 管理员权限，在此统一挂载。
 * 例外：公告与题单管理端点已抽至独立 router，使用各自的细粒度权限。
 * 此处必须跳过对应路径，否则组级通配 use 会先于独立 router 拦截请求。
 */
import { Hono } from "hono";
import type { AuthEnv } from "../identity/index.ts";
import {
  adminMiddleware,
  authMiddleware,
} from "../identity/index.ts";
import { identityAdminRouter } from "../identity/routes/index.ts";
import { catalogAdminRouter } from "../catalog/routes/index.ts";
import { submissionAdminRouter } from "../submission/routes/index.ts";
import { queryAdminRouter } from "../query/routes/index.ts";
import { contestAdminRouter } from "../contest/routes/index.ts";
import { systemAdminRouter } from "../system/routes/index.ts";
import { gatewayAdminRouter } from "../gateway/routes/index.ts";

const router = new Hono<AuthEnv>();

const FINE_GRAINED_ADMIN_PREFIXES = [
  "/api/v1/admin/announcements",
  "/api/v1/admin/trainings",
  "/api/v1/admin/problems/review",
] as const;

router.use("*", authMiddleware, async (c, next) => {
  if (
    FINE_GRAINED_ADMIN_PREFIXES.some((prefix) => c.req.path.startsWith(prefix))
  ) {
    return next();
  }
  return await adminMiddleware(c, next);
});

router.route("/", identityAdminRouter);
router.route("/", catalogAdminRouter);
router.route("/", submissionAdminRouter);
router.route("/", queryAdminRouter);
router.route("/", contestAdminRouter);
router.route("/", systemAdminRouter);
router.route("/", gatewayAdminRouter);

export default router;
```

- [x] **Step 2: 更新 `app.ts` 的 import**

将：

```ts
import admin from "./routes/admin/index.ts";
```

改为：

```ts
import admin from "./domains/admin/index.ts";
```

- [x] **Step 3: 删除旧文件**

```bash
rm noj-core/src/routes/admin/index.ts
```

- [x] **Step 4: 运行现有 admin 路由测试确认无回归**

Run: `cd noj-core && deno task test:smoke`
Expected: 通过；若 smoke 不含 admin 路由，则运行 `deno task test -- --filter "admin route"` 或对应域测试。

- [x] **Step 5: 提交**

```bash
jj commit -m "refactor(core): 建立 admin 域骨架并切换挂载"
```

---

### Task 2: 新增统一审计封装

**Files:**
- Create: `noj-core/src/domains/admin/types/admin-audit.ts`
- Create: `noj-core/src/domains/admin/services/admin-audit.ts`
- Test: `noj-core/src/domains/admin/tests/services/admin-audit.test.ts`

**Interfaces:**
- Consumes: `logAudit` from `../system/services/audit-log.ts`（实际路径 `../../system/services/audit-log.ts`）、`AuditAction`/`AuditDetail` from `../../system/types/audit-log.ts`。
- Produces:
  - `interface AuditMeta { action: AuditAction; target?: (c: Context) => { type: string; id: string } | undefined; buildDetail: (c: Context, res: Response) => AuditDetail }`
  - `registerAudit(method: string, pathPattern: string, meta: AuditMeta): void`
  - `getAuditMeta(method: string, path: string): AuditMeta | undefined`
  - `adminAudit(c: Context, action: AuditAction, detail: AuditDetail, target?: { type: string; id: string }): Promise<void>`
  - `withAudit(meta: AuditMeta): (handler: (c: Context) => Promise<Response>) => (c: Context) => Promise<Response>`

- [x] **Step 1: 写失败测试**

创建 `noj-core/src/domains/admin/tests/services/admin-audit.test.ts`：

```ts
import { assertEquals, assertExists } from "jsr:@std/assert@^1";
import { Hono } from "hono";
import { getDb, resetDbForTest } from "../../../../shared/db/connection.ts";
import { auditLogs, users } from "../../../../shared/db/schema.ts";
import { enterTestContext, leaveTestContext } from "../../../system/index.ts";
import { adminAudit, registerAudit, withAudit } from "../../services/admin-audit.ts";
import type { AuditMeta } from "../../types/admin-audit.ts";

const hasDb = true;
const hasEnv = !!Deno.env.get("JWT_SECRET");
const skip = !hasDb || !hasEnv;

const TEST_CTX = {
  actorId: "admin-audit-test-admin",
  actorIp: "10.1.1.1",
  actorRole: "admin",
};

async function clean() {
  await resetDbForTest();
  leaveTestContext();
  const db = getDb();
  const now = new Date().toISOString();
  await db.insert(users).values({
    id: TEST_CTX.actorId,
    username: "admin-audit-test",
    email: "admin-audit-test@example.com",
    password_hash: "",
    created_at: now,
    updated_at: now,
  }).onConflictDoNothing();
  await db.delete(auditLogs);
}

Deno.test({
  name: "admin-audit: withAudit 在成功响应后写入审计",
  ignore: skip,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await clean();
    enterTestContext(TEST_CTX);

    const meta: AuditMeta = {
      action: "users.ban",
      target: () => ({ type: "user", id: "target-1" }),
      buildDetail: () => ({ action: "users.ban", reason: "spam", until: null }),
    };
    registerAudit("PATCH", "/api/v1/admin/identity/users/:id/ban", meta);

    const app = new Hono();
    app.patch("/api/v1/admin/identity/users/:id/ban", withAudit(meta)(async (c) => {
      return c.json({ ok: true }, 200);
    }));

    const res = await app.request(
      "http://localhost/api/v1/admin/identity/users/target-1/ban",
      { method: "PATCH" },
    );
    assertEquals(res.status, 200);

    const db = getDb();
    const rows = await db.select().from(auditLogs);
    assertEquals(rows.length, 1);
    assertEquals(rows[0].admin_id, TEST_CTX.actorId);
    assertEquals(rows[0].action, "users.ban");
    assertEquals(rows[0].target_type, "user");
    assertEquals(rows[0].target_id, "target-1");
    assertExists(rows[0].id);
  },
});

Deno.test({
  name: "admin-audit: adminAudit 直接写入审计",
  ignore: skip,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await clean();
    enterTestContext(TEST_CTX);

    await adminAudit(
      {} as never,
      "users.unban",
      { action: "users.unban" },
      { type: "user", id: "target-2" },
    );

    const db = getDb();
    const rows = await db.select().from(auditLogs);
    assertEquals(rows.length, 1);
    assertEquals(rows[0].action, "users.unban");
  },
});
```

- [x] **Step 2: 运行测试确认失败**

Run: `cd noj-core && deno task test -- --filter "admin-audit"`
Expected: FAIL（模块不存在）。

- [x] **Step 3: 创建类型文件 `types/admin-audit.ts`**

```ts
import type { Context } from "hono";
import type { AuditAction, AuditDetail } from "../../system/types/audit-log.ts";

export interface AuditMeta {
  action: AuditAction;
  target?: (c: Context) => { type: string; id: string } | undefined;
  buildDetail: (c: Context, res: Response) => AuditDetail;
}
```

- [x] **Step 4: 创建服务文件 `services/admin-audit.ts`**

```ts
import type { Context } from "hono";
import { logAudit } from "../../system/services/audit-log.ts";
import type { AuditAction, AuditDetail } from "../../system/types/audit-log.ts";
import type { AuditMeta } from "../types/admin-audit.ts";

const registry = new Map<string, AuditMeta>();

export function registerAudit(
  method: string,
  pathPattern: string,
  meta: AuditMeta,
): void {
  registry.set(`${method} ${pathPattern}`, meta);
}

export function getAuditMeta(
  method: string,
  path: string,
): AuditMeta | undefined {
  return registry.get(`${method} ${path}`);
}

export async function adminAudit(
  _c: Context,
  action: AuditAction,
  detail: AuditDetail,
  target?: { type: string; id: string },
): Promise<void> {
  await logAudit(action, detail, target);
}

export function withAudit(meta: AuditMeta) {
  return (
    handler: (c: Context) => Promise<Response>,
  ) => async (c: Context): Promise<Response> => {
    const res = await handler(c);
    if (res.status >= 200 && res.status < 300) {
      const detail = meta.buildDetail(c, res);
      const target = meta.target?.(c);
      await adminAudit(c, meta.action, detail, target);
    }
    return res;
  };
}
```

- [x] **Step 5: 运行测试确认通过**

Run: `cd noj-core && deno task test -- --filter "admin-audit"`
Expected: PASS。

- [x] **Step 6: 提交**

```bash
jj commit -m "feat(core): 新增 admin 统一审计封装"
```

---

### Task 3: 新增乐观锁基础

**Files:**
- Create: `noj-core/src/domains/admin/services/admin-version.ts`
- Create: `noj-core/src/domains/admin/middleware/admin-version.ts`
- Test: `noj-core/src/domains/admin/tests/middleware/admin-version.test.ts`

**Interfaces:**
- Consumes: `AppError` from `../../../shared/base/errors.ts`（实际路径 `../../shared/base/errors.ts`）。
- Produces:
  - `class VersionConflictError extends AppError`
  - `readVersion(c: Context): string | undefined`
  - `assertVersion(current: string | null | undefined, expected: string | undefined): void`
  - `adminVersionMiddleware(getCurrentVersion: (c: Context) => Promise<string | null | undefined>): MiddlewareHandler`

- [x] **Step 1: 写失败测试**

创建 `noj-core/src/domains/admin/tests/middleware/admin-version.test.ts`：

```ts
import { assertEquals } from "jsr:@std/assert@^1";
import { Hono } from "hono";
import { AppError } from "../../../../shared/base/errors.ts";
import { adminVersionMiddleware, assertVersion, readVersion } from "../../middleware/admin-version.ts";
import { VersionConflictError } from "../../services/admin-version.ts";

Deno.test({
  name: "admin-version: readVersion 从 If-Match 读取并去引号",
  fn: async () => {
    const app = new Hono();
    app.get("/test", (c) => {
      return c.json({ version: readVersion(c) });
    });
    const res = await app.request("http://localhost/test", {
      headers: { "If-Match": '"2026-09-07T00:00:00.000Z"' },
    });
    const body = await res.json();
    assertEquals(body.version, "2026-09-07T00:00:00.000Z");
  },
});

Deno.test({
  name: "admin-version: assertVersion 不匹配时抛 VersionConflictError",
  fn: () => {
    let threw = false;
    try {
      assertVersion("old", "new");
    } catch (e) {
      threw = e instanceof VersionConflictError;
    }
    assertEquals(threw, true);
  },
});

Deno.test({
  name: "admin-version: adminVersionMiddleware 版本不匹配返回 409",
  fn: async () => {
    const app = new Hono();
    app.onError((err, c) => {
      if (err instanceof AppError) {
        return c.json(
          { error: err.message, code: err.code, ...(err.meta ?? {}) },
          err.statusCode,
        );
      }
      return c.json({ error: "internal" }, 500);
    });
    app.patch(
      "/resource/:id",
      adminVersionMiddleware(async () => "current-version"),
      (c) => c.json({ ok: true }, 200),
    );
    const res = await app.request("http://localhost/resource/1", {
      method: "PATCH",
      headers: { "If-Match": "stale-version" },
    });
    assertEquals(res.status, 409);
    const body = await res.json();
    assertEquals(body.code, "VERSION_CONFLICT");
  },
});
```

- [x] **Step 2: 运行测试确认失败**

Run: `cd noj-core && deno task test -- --filter "admin-version"`
Expected: FAIL（模块不存在）。

- [x] **Step 3: 创建服务文件 `services/admin-version.ts`**

```ts
import { AppError } from "../../shared/base/errors.ts";

export class VersionConflictError extends AppError {
  constructor(current: unknown) {
    super(
      "资源已被其他管理员修改，请刷新后重试",
      409,
      "VERSION_CONFLICT",
      { current },
    );
    this.name = "VersionConflictError";
  }
}

export function assertVersion(
  current: string | null | undefined,
  expected: string | undefined,
): void {
  if (expected && current !== expected) {
    throw new VersionConflictError(current);
  }
}
```

- [x] **Step 4: 创建中间件文件 `middleware/admin-version.ts`**

```ts
import type { Context, MiddlewareHandler } from "hono";
import { assertVersion } from "../services/admin-version.ts";

export function readVersion(c: Context): string | undefined {
  const header = c.req.header("If-Match");
  if (header) {
    return header.replace(/^"|"$/g, "");
  }
  return undefined;
}

export function adminVersionMiddleware(
  getCurrentVersion: (c: Context) => Promise<string | null | undefined>,
): MiddlewareHandler {
  return async (c, next) => {
    const expected = readVersion(c);
    if (expected) {
      const current = await getCurrentVersion(c);
      assertVersion(current, expected);
    }
    await next();
  };
}
```

- [x] **Step 5: 运行测试确认通过**

Run: `cd noj-core && deno task test -- --filter "admin-version"`
Expected: PASS。

- [x] **Step 6: 提交**

```bash
jj commit -m "feat(core): 新增 admin 乐观锁基础"
```

---

## Self-Review

- **Spec coverage:** 本计划覆盖 spec 第 1 节（admin 域骨架）和第 3/4 节的基础工具（审计封装、乐观锁工具）；sub domain 路由迁移、缺失 `updated_at` 补列、前端组件与页面迁移由后续计划承担。
- **Placeholder scan:** 所有步骤均包含实际代码或明确命令，无 TBD/TODO。
- **Type consistency:** `AuditMeta`、`withAudit`、`adminVersionMiddleware` 等签名在任务间一致；测试中使用的导入路径与创建文件路径一致。
