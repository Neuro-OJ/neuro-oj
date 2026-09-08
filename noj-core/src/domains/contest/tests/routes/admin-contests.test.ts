import { assertEquals, assertNotEquals } from "jsr:@std/assert@^1";
import { eq } from "drizzle-orm";
import { createApp } from "../../../../app.ts";
import { getDb, resetDbForTest } from "../../../../shared/db/connection.ts";
import {
  auditLogs,
  problems,
  userRoles,
  users,
} from "../../../../shared/db/schema.ts";
import { signToken } from "../../../identity/index.ts";
import { initRedisForTest, jsonRequest } from "../../../../../tests/helper.ts";
import { ensureRbacSeeds } from "../../../system/index.ts";

// 测试进程通常没有本地 Redis；直接短路 JWT 撤销检查，避免 authMiddleware 503。
Deno.env.set("NOJ_BYPASS_JWT_REVOKE", "1");

await resetDbForTest();
await initRedisForTest();
await ensureRbacSeeds();

async function setupContestViaAdmin(): Promise<{
  app: ReturnType<typeof createApp>;
  adminId: string;
  adminToken: string;
  contestId: string;
}> {
  const db = getDb();
  const adminId = crypto.randomUUID();
  const problemId = crypto.randomUUID();
  const now = new Date().toISOString();
  const unique = `${Date.now()}-${crypto.randomUUID().slice(0, 8)}`;
  await db.insert(users).values({
    id: adminId,
    username: `ac-admin-${unique}`,
    email: `ac-admin-${unique}@example.com`,
    password_hash: "hash",
    created_at: now,
    updated_at: now,
  });
  await db.insert(userRoles).values({
    user_id: adminId,
    role_id: "admin",
  }).onConflictDoNothing();
  await db.insert(problems).values({
    id: problemId,
    title: "后台竞赛测试题",
    description: "测试题面",
    difficulty: "easy",
    runtime_config: {},
    number: 990001 + Math.floor(Math.random() * 1000),
    owner_id: adminId,
    type: "P",
    created_at: now,
    updated_at: now,
  });

  const app = createApp();
  const adminToken = await signToken({ sub: adminId, role: "admin" });
  const create = await jsonRequest(app, "/api/v1/admin/contest/contests", {
    method: "POST",
    token: adminToken,
    body: {
      title: `邀请赛-${unique}`,
      start_time: new Date(Date.now() - 60_000).toISOString(),
      end_time: new Date(Date.now() + 3_600_000).toISOString(),
      type: "kaggle",
      kind: "invite",
      password: "OLD-CODE-123",
      is_public: false,
      problems: [{
        problem_id: problemId,
        label: "A",
        sort_order: 0,
        score: 10000,
      }],
    },
  });
  assertEquals(create.status, 201);
  const contestId = (await create.json()).data.id;
  return { app, adminId, adminToken, contestId };
}

Deno.test({
  name: "admin contest route: kind 可转公开赛",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const { app, adminId, adminToken, contestId } =
      await setupContestViaAdmin();
    const res = await jsonRequest(
      app,
      `/api/v1/admin/contest/contests/${contestId}/kind`,
      {
        method: "PATCH",
        token: adminToken,
        body: { kind: "public" },
      },
    );
    assertEquals(res.status, 200);
    const body = await res.json();
    assertEquals(body.data.kind, "public");
    assertEquals(body.data.is_public, true);

    const db = getDb();
    const rows = await db.select().from(auditLogs).where(
      eq(auditLogs.admin_id, adminId),
    );
    assertEquals(
      rows.some((r) => r.action === "contest.create"),
      true,
    );
    assertEquals(
      rows.some((r) => r.action === "contest.kind_change"),
      true,
    );
  },
});

Deno.test({
  name: "admin contest route: reset-code 返回新邀请码",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const { app, adminId, adminToken, contestId } =
      await setupContestViaAdmin();
    const res = await jsonRequest(
      app,
      `/api/v1/admin/contest/contests/${contestId}/reset-code`,
      { method: "POST", token: adminToken },
    );
    assertEquals(res.status, 200);
    const body = await res.json();
    assertEquals(typeof body.data.code, "string");
    assertNotEquals(body.data.code, "");
    assertEquals(body.data.contest.has_password, true);

    const db = getDb();
    const rows = await db.select().from(auditLogs).where(
      eq(auditLogs.admin_id, adminId),
    );
    assertEquals(
      rows.some((r) => r.action === "contest.reset_code"),
      true,
    );
    assertEquals(
      rows.filter((r) => r.action === "contest.reset_code").length,
      1,
    );
  },
});
