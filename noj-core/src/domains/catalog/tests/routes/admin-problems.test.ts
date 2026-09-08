import { assertEquals } from "jsr:@std/assert@^1";
import { and, eq } from "drizzle-orm";
import { createApp } from "../../../../app.ts";
import { getDb, resetDbForTest } from "../../../../shared/db/connection.ts";
import {
  permissions,
  problems,
  rolePermissions,
  roles,
  userRoles,
  users,
} from "../../../../shared/db/schema.ts";
import { signToken } from "../../../identity/index.ts";
import { createProblem } from "../../index.ts";
import { initRedisForTest, jsonRequest } from "../../../../../tests/helper.ts";
import { ensureRbacSeeds } from "../../../system/index.ts";
import { ROOT_USER_ID } from "../../../../shared/base/constants.ts";

// 测试进程通常没有本地 Redis；直接短路 JWT 撤销检查，避免 authMiddleware 503。
Deno.env.set("NOJ_BYPASS_JWT_REVOKE", "1");

await resetDbForTest();
await initRedisForTest();
await ensureRbacSeeds();

const VALID_RUNTIME_CONFIG = {
  evaluator: {
    image: "noj-evaluator-python",
    command: "python3 /workspace/evaluate.py",
    time_limit_ms: 5000,
    memory_limit_mb: 512,
  },
  solution: {
    image: "noj-solution-python",
    call_timeout_ms: 2000,
    memory_limit_mb: 512,
  },
};

async function createTestUser(username: string): Promise<{
  id: string;
  token: string;
}> {
  const db = getDb();
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  await db.insert(users).values({
    id,
    username,
    email: `${id}@test.local`,
    password_hash: "x",
    created_at: now,
    updated_at: now,
  });
  await db.insert(userRoles).values({
    user_id: id,
    role_id: "user",
  }).onConflictDoNothing();
  const token = await signToken({ sub: id, role: "user" });
  return { id, token };
}

async function createAdminUser(username: string): Promise<string> {
  const db = getDb();
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  await db.insert(users).values({
    id,
    username,
    email: `${id}@test.local`,
    password_hash: "x",
    created_at: now,
    updated_at: now,
  });
  await db.insert(userRoles).values({
    user_id: id,
    role_id: "admin",
  }).onConflictDoNothing();
  return await signToken({ sub: id, role: "admin" });
}

async function createUProblem(opts: {
  ownerId: string;
  visibility?: "public" | "private";
}): Promise<{ id: string; displayId: string }> {
  // 以 root 创建规避 CLI 场景敏感字段 fail-closed，再改为测试 owner。
  const created = await createProblem({
    title: `评定测试题 ${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    description: "测试描述",
    difficulty: "easy",
    type: "U",
    runtime_config: VALID_RUNTIME_CONFIG,
  }, ROOT_USER_ID);
  const db = getDb();
  await db.update(problems).set({
    owner_id: opts.ownerId,
    visibility: opts.visibility ?? "public",
    updated_at: new Date().toISOString(),
  }).where(eq(problems.id, created.id));
  return { id: created.id, displayId: created.display_id };
}

Deno.test({
  name: "admin problem review: 非管理员调用评定队列返回 403",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const { token } = await createTestUser(`review-normal-${Date.now()}`);
    const app = createApp();
    const res = await jsonRequest(
      app,
      "/api/v1/admin/catalog/problems/review",
      {
        method: "POST",
        token,
        body: { problem_ids: ["x"], action: "to_public" },
      },
    );
    assertEquals(res.status, 403);
  },
});

Deno.test({
  name: "admin problem review: 拥有 problem:create_p 的评委可访问评定队列",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const db = getDb();
    const now = new Date().toISOString();
    const reviewerId = crypto.randomUUID();
    const unique = `reviewer-${Date.now()}`;
    await db.insert(users).values({
      id: reviewerId,
      username: unique,
      email: `${reviewerId}@test.local`,
      password_hash: "x",
      created_at: now,
      updated_at: now,
    });
    const roleId = crypto.randomUUID();
    await db.insert(roles).values({
      id: roleId,
      name: unique,
      description: "评定评委",
      created_at: now,
      updated_at: now,
    });
    const [createPPerm] = await db.select({ id: permissions.id })
      .from(permissions)
      .where(
        and(
          eq(permissions.resource, "problem"),
          eq(permissions.action, "create_p"),
        ),
      )
      .limit(1);
    if (createPPerm) {
      await db.insert(rolePermissions).values({
        role_id: roleId,
        permission_id: createPPerm.id,
      });
    }
    await db.insert(userRoles).values({
      user_id: reviewerId,
      role_id: roleId,
    });
    const token = await signToken({ sub: reviewerId, role: "user" });
    const app = createApp();
    const res = await jsonRequest(
      app,
      "/api/v1/admin/catalog/problems/review?queue=p",
      {
        token,
      },
    );
    assertEquals(res.status, 200);
    const body = await res.json();
    assertEquals(Array.isArray(body.data), true);
  },
});

Deno.test({
  name: "admin problem review: owner 可通过 PUT visibility 转 public",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const { id: ownerId, token } = await createTestUser(
      `owner-public-${Date.now()}`,
    );
    const problem = await createUProblem({ ownerId, visibility: "private" });
    const app = createApp();
    const res = await jsonRequest(
      app,
      `/api/v1/problems/${problem.displayId}/visibility`,
      {
        method: "PUT",
        token,
        body: { visibility: "public" },
      },
    );
    assertEquals(res.status, 200);
    const body = await res.json();
    assertEquals(body.data.visibility, "public");

    const db = getDb();
    const [row] = await db.select({ visibility: problems.visibility })
      .from(problems)
      .where(eq(problems.id, problem.id))
      .limit(1);
    assertEquals(row?.visibility, "public");
  },
});

Deno.test({
  name: "admin problem review: 管理员批量 U→P 成功",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const adminToken = await createAdminUser(`admin-review-${Date.now()}`);
    const { id: ownerId } = await createTestUser(`owner-top-${Date.now()}`);
    const problem = await createUProblem({ ownerId, visibility: "public" });
    const app = createApp();
    const res = await jsonRequest(
      app,
      "/api/v1/admin/catalog/problems/review",
      {
        method: "POST",
        token: adminToken,
        body: { problem_ids: [problem.id], action: "to_p" },
      },
    );
    assertEquals(res.status, 200);
    const body = await res.json();
    assertEquals(body.data.updated, 1);

    const db = getDb();
    const [row] = await db.select({
      type: problems.type,
      visibility: problems.visibility,
    }).from(problems).where(eq(problems.id, problem.id)).limit(1);
    assertEquals(row?.type, "P");
    assertEquals(row?.visibility, "public");
  },
});

Deno.test({
  name: "admin problem review: owner 不能通过 visibility 设回 private",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const { id: ownerId, token } = await createTestUser(
      `owner-private-${Date.now()}`,
    );
    const problem = await createUProblem({ ownerId, visibility: "public" });
    const app = createApp();
    const res = await jsonRequest(
      app,
      `/api/v1/problems/${problem.displayId}/visibility`,
      {
        method: "PUT",
        token,
        body: { visibility: "private" },
      },
    );
    assertEquals(res.status, 403);
  },
});
