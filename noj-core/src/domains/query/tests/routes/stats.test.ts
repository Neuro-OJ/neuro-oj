/**
 * 公开站点统计端点路由层测试。
 *
 * 依赖 PGlite 内存数据库（DATABASE_URL 未设置时自动启用，始终可用），
 * 测试前自动运行迁移并 seed（见 00_migrate_test.ts）。
 */
import { assertEquals, assertExists } from "jsr:@std/assert@^1";
import { createApp } from "../../../../app.ts";
import { resetDbForTest } from "../../../../shared/db/connection.ts";
import {
  evaluationAttempts,
  problems,
  submissions,
  users,
} from "../../../../shared/db/schema.ts";
import { count, eq } from "drizzle-orm";
import { getDb } from "../../../../shared/db/connection.ts";

const skipDb = false; // PGlite 内存数据库始终可用

Deno.test({
  name: "stats route: GET /api/v1/stats 公开返回统计数字",
  ignore: skipDb,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await resetDbForTest();
    const app = createApp();
    const res = await app.request("/api/v1/stats");
    assertEquals(res.status, 200);
    const body = await res.json();
    assertExists(body.data);
    assertEquals(typeof body.data.problems, "number");
    assertEquals(typeof body.data.submissions, "number");
    assertEquals(typeof body.data.users, "number");
    assertEquals(typeof body.data.accepted, "number");
    // 非负数
    for (const key of ["problems", "submissions", "users", "accepted"]) {
      assertEquals(body.data[key] >= 0, true);
    }
  },
});

Deno.test({
  name: "stats route: 统计与数据库实际行数一致（种子数据）",
  ignore: skipDb,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await resetDbForTest();
    const app = createApp();
    const res = await app.request("/api/v1/stats");
    const body = await res.json();

    const db = getDb();
    const [{ n: problemCount }] = await db.select({ n: count() }).from(
      problems,
    );
    assertEquals(body.data.problems, Number(problemCount));
  },
});

Deno.test({
  name: "stats route: accepted 读有效成绩投影（不读 evaluation_results）",
  ignore: skipDb,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await resetDbForTest();
    const db = getDb();
    const now = new Date().toISOString();
    const userId = crypto.randomUUID();
    const problemId = crypto.randomUUID();
    await db.insert(users).values({
      id: userId,
      username: `stats-accepted-${userId.slice(0, 8)}`,
      email: `${userId}@test.noj`,
      password_hash: "hash",
      created_at: now,
      updated_at: now,
    });
    await db.insert(problems).values({
      id: problemId,
      title: "统计通过数题",
      description: "d",
      type: "P",
      number: 96000 + (Date.now() % 1000),
      owner_id: "0",
      difficulty: "easy",
      created_at: now,
      updated_at: now,
    });
    // 先插提交再插尝试（尝试对提交有外键），最后回填有效成绩指针
    await db.insert(submissions).values([
      {
        id: "stats-accepted-s1",
        user_id: userId,
        problem_id: problemId,
        language: "python3",
        code: "print(1)",
        version_origin: "legacy_unknown",
        is_valid: true,
        is_accepted: true,
        created_at: now,
      },
      {
        // 有结果但投影未通过 → 不计入 accepted
        id: "stats-accepted-s2",
        user_id: userId,
        problem_id: problemId,
        language: "python3",
        code: "print(2)",
        version_origin: "legacy_unknown",
        is_valid: true,
        is_accepted: false,
        created_at: now,
      },
    ]);
    await db.insert(evaluationAttempts).values({
      id: "stats-accepted-a1",
      submission_id: "stats-accepted-s1",
      problem_id: problemId,
      sequence: 0,
      source: "initial",
      state: "finished",
      result_kind: "graded",
      result_status: "finished",
      score: 10000,
      accepted: true,
      created_at: now,
    });
    await db.update(submissions).set({
      effective_attempt_id: "stats-accepted-a1",
    }).where(eq(submissions.id, "stats-accepted-s1"));

    const app = createApp();
    const res = await app.request("/api/v1/stats");
    assertEquals(res.status, 200);
    const body = await res.json();
    assertEquals(body.data.accepted, 1);
    assertEquals(body.data.submissions, 2);
  },
});
