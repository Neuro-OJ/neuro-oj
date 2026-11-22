/**
 * `resetDbForTest()` 的表覆盖回归测试（2026-09-24 评审）。
 *
 * 评审实测：`ALL_TABLES` 长期漏登记多张表（`objective_submissions`、`self_tests`、`sse_events`），
 * 导致 `resetDbForTest()` 的 TRUNCATE 漏表、同进程用例相互污染；而
 * schema parity / 迁移门禁都看不到该名单遗漏。
 *
 * 这里直接验证真实 PostgreSQL 中「插入 → reset → 断言清空」的行为，避免仅依赖
 * 静态表名清单。
 *
 * 选取的表均为**无外键依赖**的叶子表，避免构造 problems/users 前置数据，
 * 同时足以覆盖「该表确实在 TRUNCATE 清单里」这一断言。
 */
import { assertEquals } from "jsr:@std/assert@^1";
import { getDb } from "../../src/shared/db/connection.ts";
import { resetDbForTest } from "../helpers/db.ts";
import { sseEvents } from "../../src/shared/db/schema.ts";
Deno.test({
  name: "resetDbForTest: sse_events 会被清空（2026-09-24 评审回归）",
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    await resetDbForTest();
    const db = getDb();
    await db.insert(sseEvents).values({
      channel: "probe-channel",
      payload: { probe: true },
      created_at: new Date().toISOString(),
    });
    assertEquals((await db.select().from(sseEvents)).length, 1);

    await resetDbForTest();

    assertEquals((await db.select().from(sseEvents)).length, 0);
  },
});

Deno.test({
  name: "resetDbForTest: TRUNCATE 语句整体有效（无不存在表名/无静默失败）",
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    // 若 ALL_TABLES 含 DDL 不存在的表名，TRUNCATE 会整体失败并被 catch
    // 静默吞掉——表现为「reset 实际什么也没清」。上面两条用真实插入 →
    // 清空的断言把这种静默失败变成红灯。
    await resetDbForTest();
    const db = getDb();
    await db.insert(sseEvents).values({
      channel: "probe-truncate",
      payload: { probe: true },
      created_at: new Date().toISOString(),
    });
    await resetDbForTest();
    assertEquals((await db.select().from(sseEvents)).length, 0);
  },
});
