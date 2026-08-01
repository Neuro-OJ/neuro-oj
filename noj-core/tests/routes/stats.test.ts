/**
 * 公开站点统计端点路由层测试。
 *
 * 依赖 PGlite 内存数据库（DATABASE_URL 未设置时自动启用，始终可用），
 * 测试前自动运行迁移并 seed（见 00_migrate_test.ts）。
 */
import { assertEquals, assertExists } from "jsr:@std/assert@^1";
import { createApp } from "../../src/app.ts";
import { resetDbForTest } from "../../src/db/connection.ts";
import { problems } from "../../src/db/schema.ts";
import { count } from "drizzle-orm";
import { getDb } from "../../src/db/connection.ts";

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
