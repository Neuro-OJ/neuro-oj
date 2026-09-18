import { assertEquals } from "jsr:@std/assert@^1";
import { eq } from "drizzle-orm";
import { createApp } from "../../../../app.ts";
import { initRedisForTest, jsonRequest } from "../../../../../tests/helper.ts";
import { getDb, resetDbForTest } from "../../../../shared/db/connection.ts";
import { problems, userRoles, users } from "../../../../shared/db/schema.ts";
import { signToken } from "../../../identity/index.ts";
import { ensureRbacSeeds } from "../../../system/index.ts";
import { _resetProblemStatsCacheForTest } from "../../index.ts";

// 测试进程通常没有本地 Redis；短路 JWT 撤销检查，避免 authMiddleware 503。
Deno.env.set("NOJ_BYPASS_JWT_REVOKE", "1");

const hasEnv = !!Deno.env.get("JWT_SECRET");
const skipEnv = !hasEnv;

await resetDbForTest();
await initRedisForTest();
await ensureRbacSeeds();
const app = createApp();

/** 建一个普通用户并返回其 id 与 token（用于 owner / 非 owner 两种场景）。 */
async function createUserWithToken(): Promise<{ id: string; token: string }> {
  const db = getDb();
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  await db.insert(users).values({
    id,
    username: `stats_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    email: `${id}@test.local`,
    password_hash: "x",
    created_at: now,
    updated_at: now,
  });
  await db.insert(userRoles).values({ user_id: id, role_id: "user" })
    .onConflictDoNothing();
  const token = await signToken({ sub: id, role: "user" });
  return { id, token };
}

async function seedProblem(ownerId: string, number: number): Promise<string> {
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  await getDb().insert(problems).values({
    id,
    title: `统计路由测试题 ${number}`,
    description: "题面",
    difficulty: "easy",
    runtime_config: {},
    number,
    type: "U",
    visibility: "public",
    owner_id: ownerId,
    created_at: now,
    updated_at: now,
  });
  return id;
}

Deno.test({
  name: "problems-stats route: 公开统计匿名可读",
  ignore: skipEnv,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    _resetProblemStatsCacheForTest();
    const { id: ownerId } = await createUserWithToken();
    const problemId = await seedProblem(ownerId, 950001);
    try {
      const res = await jsonRequest(
        app,
        `/api/v1/problems/${problemId}/stats/public`,
      );
      assertEquals(res.status, 200);
      const body = await res.json();
      assertEquals(typeof body.data.submit_count, "number");
      assertEquals(body.data.acceptance_rate, 0);
      assertEquals(body.data.suppressed_reason, null);
    } finally {
      await getDb().delete(problems).where(eq(problems.id, problemId));
      await getDb().delete(users).where(eq(users.id, ownerId));
    }
  },
});

Deno.test({
  name: "problems-stats route: 深度统计未登录被拒",
  ignore: skipEnv,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const { id: ownerId } = await createUserWithToken();
    const problemId = await seedProblem(ownerId, 950002);
    try {
      const res = await jsonRequest(app, `/api/v1/problems/${problemId}/stats`);
      assertEquals(res.status === 401 || res.status === 403, true);
    } finally {
      await getDb().delete(problems).where(eq(problems.id, problemId));
      await getDb().delete(users).where(eq(users.id, ownerId));
    }
  },
});

Deno.test({
  name: "problems-stats route: 非 owner 普通用户被拒（403）",
  ignore: skipEnv,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const { id: ownerId } = await createUserWithToken();
    const { id: otherId, token: otherToken } = await createUserWithToken();
    const problemId = await seedProblem(ownerId, 950003);
    try {
      const res = await jsonRequest(
        app,
        `/api/v1/problems/${problemId}/stats`,
        { token: otherToken },
      );
      assertEquals(res.status, 403);
    } finally {
      await getDb().delete(problems).where(eq(problems.id, problemId));
      await getDb().delete(users).where(eq(users.id, ownerId));
      await getDb().delete(users).where(eq(users.id, otherId));
    }
  },
});

Deno.test({
  name: "problems-stats route: 题目 owner 可读深度统计",
  ignore: skipEnv,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    _resetProblemStatsCacheForTest();
    const { id: ownerId, token: ownerToken } = await createUserWithToken();
    const problemId = await seedProblem(ownerId, 950004);
    try {
      const res = await jsonRequest(
        app,
        `/api/v1/problems/${problemId}/stats`,
        { token: ownerToken },
      );
      assertEquals(res.status, 200);
      const body = await res.json();
      assertEquals(body.data.window_days, 90);
      assertEquals(typeof body.data.status_distribution, "object");
      assertEquals(Array.isArray(body.data.case_failure_distribution), true);
    } finally {
      await getDb().delete(problems).where(eq(problems.id, problemId));
      await getDb().delete(users).where(eq(users.id, ownerId));
    }
  },
});

Deno.test({
  name: "problems-stats route: window_days 非法值回退为 90",
  ignore: skipEnv,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    _resetProblemStatsCacheForTest();
    const { id: ownerId, token: ownerToken } = await createUserWithToken();
    const problemId = await seedProblem(ownerId, 950005);
    try {
      const res = await jsonRequest(
        app,
        `/api/v1/problems/${problemId}/stats?window_days=99999`,
        { token: ownerToken },
      );
      assertEquals(res.status, 200);
      const body = await res.json();
      assertEquals(body.data.window_days, 90);
    } finally {
      await getDb().delete(problems).where(eq(problems.id, problemId));
      await getDb().delete(users).where(eq(users.id, ownerId));
    }
  },
});

/**
 * C3 回归测试（2026-09-14 评审）。
 *
 * `/:id/stats/public` 此前调用 `resolveProblem(id)` 时**未传 viewer**，因此完全不
 * 触发访问校验：私有题统计匿名可读，且 200/404 的差异使其成为**存在性预言机**
 * （可按 display_id 枚举私有题）。兄弟 handler `/:id` 明确注释"无权限一律 404，
 * 防存在性探测"，本路由必须同口径。
 */
Deno.test({
  name: "problems-stats route(C3): 私有题公开统计匿名必须 404（不泄露存在性）",
  ignore: skipEnv,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    _resetProblemStatsCacheForTest();
    const { id: ownerId } = await createUserWithToken();
    const problemId = crypto.randomUUID();
    const now = new Date().toISOString();
    // U 型私有题：与题目详情路由同样应当对匿名不可见
    await getDb().insert(problems).values({
      id: problemId,
      title: "私有题 C3",
      description: "题面",
      difficulty: "easy",
      runtime_config: {},
      number: 950006,
      type: "U",
      visibility: "private",
      owner_id: ownerId,
      created_at: now,
      updated_at: now,
    });
    try {
      const res = await jsonRequest(
        app,
        `/api/v1/problems/${problemId}/stats/public`,
      );
      assertEquals(res.status, 404);
    } finally {
      await getDb().delete(problems).where(eq(problems.id, problemId));
      await getDb().delete(users).where(eq(users.id, ownerId));
    }
  },
});

Deno.test({
  name:
    "problems-stats route(C3): 私有题存在与不存在返回同一状态码（无预言机）",
  ignore: skipEnv,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    _resetProblemStatsCacheForTest();
    const { id: ownerId } = await createUserWithToken();
    const privateId = crypto.randomUUID();
    const now = new Date().toISOString();
    await getDb().insert(problems).values({
      id: privateId,
      title: "私有题 C3-预言机",
      description: "题面",
      difficulty: "easy",
      runtime_config: {},
      number: 950007,
      type: "U",
      visibility: "private",
      owner_id: ownerId,
      created_at: now,
      updated_at: now,
    });
    try {
      const existing = await jsonRequest(
        app,
        `/api/v1/problems/${privateId}/stats/public`,
      );
      const missing = await jsonRequest(
        app,
        `/api/v1/problems/${crypto.randomUUID()}/stats/public`,
      );
      // 二者必须不可区分：否则可据状态码枚举私有题
      assertEquals(existing.status, missing.status);
      assertEquals(existing.status, 404);
    } finally {
      await getDb().delete(problems).where(eq(problems.id, privateId));
      await getDb().delete(users).where(eq(users.id, ownerId));
    }
  },
});

Deno.test({
  name: "problems-stats route(C3): 私有题 owner 仍可读自己的公开统计",
  ignore: skipEnv,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    _resetProblemStatsCacheForTest();
    const { id: ownerId, token: ownerToken } = await createUserWithToken();
    const problemId = crypto.randomUUID();
    const now = new Date().toISOString();
    await getDb().insert(problems).values({
      id: problemId,
      title: "私有题 C3-owner",
      description: "题面",
      difficulty: "easy",
      runtime_config: {},
      number: 950008,
      type: "U",
      visibility: "private",
      owner_id: ownerId,
      created_at: now,
      updated_at: now,
    });
    try {
      const res = await jsonRequest(
        app,
        `/api/v1/problems/${problemId}/stats/public`,
        { token: ownerToken },
      );
      assertEquals(res.status, 200);
    } finally {
      await getDb().delete(problems).where(eq(problems.id, problemId));
      await getDb().delete(users).where(eq(users.id, ownerId));
    }
  },
});
