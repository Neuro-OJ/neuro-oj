import { assertEquals } from "jsr:@std/assert@^1";
import { and, eq } from "drizzle-orm";
import { initRedisForTest } from "../lib/helper.ts";
import { createApp } from "../../src/app.ts";
import { createUserToken, jsonRequest } from "../lib/helper.ts";
import { getDb } from "./../../src/shared/db/connection.ts";
import { auditLogs } from "./../../src/shared/db/schema.ts";
import {
  permissions,
  problems,
  problemTags,
  rolePermissions,
  roles,
  tags,
  userRoles,
  users,
} from "./../../src/shared/db/schema.ts";
import { signToken } from "../../src/lib/jwt.ts";
import { ensureRbacSeeds } from "../../src/domains/system/index.ts";

const hasEnv = !!Deno.env.get("JWT_SECRET");
const skip = !hasEnv;

// 模块级 bootstrap：确保表已创建（PGlite 模式）
import { resetDbForTest } from "./../../src/shared/db/connection.ts";
await resetDbForTest();
await initRedisForTest();

const ts = Date.now();

Deno.test({
  name: "tags route: GET /api/v1/tags 返回标签列表（含 problem_count）",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const app = createApp();
    const res = await jsonRequest(app, "/api/v1/tags");
    assertEquals(res.status, 200);

    const body = await res.json();
    assertEquals(Array.isArray(body.data), true);
    for (const item of body.data) {
      assertEquals(typeof item.id, "string");
      assertEquals(typeof item.name, "string");
      assertEquals(typeof item.kind, "string");
      assertEquals(typeof item.problem_count, "number");
    }
  },
});

Deno.test({
  name: "tags route: POST /api/v1/tags 未登录返回 401",
  ignore: skip,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const app = createApp();
    const res = await jsonRequest(app, "/api/v1/tags", {
      method: "POST",
      body: { name: "新标签", kind: "problem" },
    });
    assertEquals(res.status, 401);
  },
});

Deno.test({
  name:
    "tags route: POST /api/v1/tags 默认用户返回 403（tag:manage 默认仅 admin）",
  ignore: skip,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const app = createApp();
    const token = await createUserToken("user");

    const res = await jsonRequest(app, "/api/v1/tags", {
      method: "POST",
      body: { name: `测试标签-${ts}`, kind: "problem" },
      token,
    });
    assertEquals(res.status, 403);
  },
});

Deno.test({
  name: "tags route: POST /api/v1/tags admin 创建成功 201",
  ignore: skip,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const app = createApp();
    const token = await createUserToken("admin");
    const name = `测试标签-${ts}`;

    const res = await jsonRequest(app, "/api/v1/tags", {
      method: "POST",
      body: { name, kind: "algorithm" },
      token,
    });
    assertEquals(res.status, 201);
    const body = await res.json();
    assertEquals(body.data.name, name);
    assertEquals(body.data.kind, "algorithm");

    // 清理
    const db = getDb();
    await db.delete(tags).where(eq(tags.name, name));
  },
});

Deno.test({
  name: "tags route: POST /api/v1/tags 非法 kind 返回 400",
  ignore: skip,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const app = createApp();
    const token = await createUserToken("admin");

    const res = await jsonRequest(app, "/api/v1/tags", {
      method: "POST",
      body: { name: `非法标签-${ts}`, kind: "unknown" },
      token,
    });
    assertEquals(res.status, 400);
  },
});

Deno.test({
  name: "tags route: DELETE /api/v1/tags 不存在的标签返回 404",
  ignore: skip,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const app = createApp();
    const token = await createUserToken("admin");

    const res = await jsonRequest(app, "/api/v1/tags/nonexistent-id", {
      method: "DELETE",
      token,
    });
    assertEquals(res.status, 404);
  },
});

Deno.test({
  name: "tags route: merge 缺少 target_id 返回 400",
  ignore: skip,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const app = createApp();
    const token = await createUserToken("admin");

    const res = await jsonRequest(app, "/api/v1/tags/nonexistent/merge", {
      method: "POST",
      body: {},
      token,
    });
    assertEquals(res.status, 400);
  },
});

Deno.test({
  name: "tags route: 自定义角色授予 tag:manage 后可写（RBAC 可配置）",
  ignore: skip,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const db = getDb();
    await ensureRbacSeeds();

    // 1. 创建自定义角色并授予 tag:manage
    const roleId = `tag-manager-role-${ts}`;
    await db.insert(roles).values({
      id: roleId,
      name: `tag-manager-${ts}`,
      description: "",
      is_system: false,
      is_default: false,
      parent_id: null,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    }).onConflictDoNothing({ target: roles.id });

    const permRows = await db
      .select()
      .from(permissions)
      .where(
        and(
          eq(permissions.resource, "tag"),
          eq(permissions.action, "manage"),
        ),
      )
      .limit(1);
    if (permRows.length === 0) return; // 权限未 seed（不应发生），跳过
    await db.insert(rolePermissions).values({
      role_id: roleId,
      permission_id: permRows[0].id,
    }).onConflictDoNothing();

    // 2. 创建用户并关联自定义角色
    const userId = crypto.randomUUID();
    const now = new Date().toISOString();
    await db.insert(users).values({
      id: userId,
      username: `tagop_${ts}`,
      email: `tagop_${ts}@test.local`,
      password_hash: "x",
      must_change_password: false,
      created_at: now,
      updated_at: now,
    }).onConflictDoNothing({ target: users.id });
    await db.insert(userRoles).values({
      user_id: userId,
      role_id: roleId,
    }).onConflictDoNothing();

    // 3. 签发 token 调用写接口
    const token = await signToken({ sub: userId, role: "user" });
    const app = createApp();
    const name = `角色标签-${ts}`;
    const res = await jsonRequest(app, "/api/v1/tags", {
      method: "POST",
      body: { name, kind: "problem" },
      token,
    });
    assertEquals(res.status, 201);

    // C1 回归守卫：真实 HTTP 流程（runWithContext）必须写审计，且 actor 为调用者
    const auditRows = await db
      .select()
      .from(auditLogs)
      .where(eq(auditLogs.action, "tags.create"))
      .limit(10);
    assertEquals(
      auditRows.some((r) => r.admin_id === userId),
      true,
      "真实 HTTP 流程应写入 tags.create 审计（RequestContext 注入）",
    );

    // 4. 清理（先删审计行：admin_id FK 阻止直接删用户）
    await db.delete(auditLogs).where(eq(auditLogs.admin_id, userId));
    await db.delete(problemTags);
    await db.delete(tags).where(eq(tags.name, name));
    await db.delete(userRoles).where(eq(userRoles.user_id, userId));
    await db.delete(rolePermissions).where(
      eq(rolePermissions.role_id, roleId),
    );
    await db.delete(users).where(eq(users.id, userId));
    await db.delete(roles).where(eq(roles.id, roleId));
  },
});

Deno.test({
  name: "tags route: 题目按标签筛选命中",
  ignore: skip,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const db = getDb();
    const app = createApp();
    const adminToken = await createUserToken("admin");

    // 创建标签 + 题目 + 关联
    const tagName = `筛选题标签-${ts}`;
    const tagRes = await jsonRequest(app, "/api/v1/tags", {
      method: "POST",
      body: { name: tagName, kind: "problem" },
      token: adminToken,
    });
    assertEquals(tagRes.status, 201);
    const tagId = (await tagRes.json()).data.id;

    const problemId = crypto.randomUUID();
    const now = new Date().toISOString();
    await db.insert(problems).values({
      id: problemId,
      title: `筛选测试题-${ts}`,
      description: "描述",
      difficulty: "easy",
      runtime_config: null,
      is_objective: false,
      number: 900000 + (ts % 10000),
      owner_id: "0",
      type: "P",
      created_at: now,
      updated_at: now,
    });
    await db.insert(problemTags).values({
      problem_id: problemId,
      tag_id: tagId,
    });

    // 按标签筛选命中
    const res = await jsonRequest(app, `/api/v1/problems?tag=${tagId}`);
    assertEquals(res.status, 200);
    const body = await res.json();
    const ids = (body.data as { id: string }[]).map((p) => p.id);
    assertEquals(ids.includes(problemId), true);
    // 列表项只含题目标签
    const items = body.data as Array<{ id: string; tags: { kind: string }[] }>;
    const item = items.find((p) => p.id === problemId);
    assertEquals(item !== undefined, true);
    if (item) {
      for (const t of item.tags) {
        assertEquals(t.kind, "problem");
      }
    }

    // 清理
    await db.delete(problemTags).where(eq(problemTags.problem_id, problemId));
    await db.delete(problems).where(eq(problems.id, problemId));
    await db.delete(tags).where(eq(tags.id, tagId));
  },
});
