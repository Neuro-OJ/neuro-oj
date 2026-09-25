/**
 * `resetDbForTest()` 的表覆盖回归测试（2026-09-24 评审）。
 *
 * 评审实测：`ALL_TABLES` 长期漏登记 5 张表（`carousel_slides`、
 * `objective_questions`、`objective_submissions`、`self_tests`、`sse_events`），
 * 导致 `resetDbForTest()` 的 TRUNCATE 漏表、同进程用例相互污染；而
 * schema parity / 迁移门禁都看不到该名单遗漏。
 *
 * 本文件必须 `disableTestTransactionForFile()`——preload 的事务包装下
 * `resetDbForTest()` 退化为「清内存缓存」，无法验证 TRUNCATE 表清单。
 * 静态守护（`ALL_TABLES` ↔ DDL/Drizzle 交叉核对）在
 * `tests/db/schema.test.ts`，此处补功能性验证（真正插入 → reset → 断言清空）。
 *
 * 选取的表均为**无外键依赖**的叶子表，避免构造 problems/users 前置数据，
 * 同时足以覆盖「该表确实在 TRUNCATE 清单里」这一断言。
 */
import { assertEquals } from "jsr:@std/assert@^1";
import {
  disableTestTransactionForFile,
  getDb,
  resetDbForTest,
} from "../../src/shared/db/connection.ts";
import { carouselSlides, sseEvents } from "../../src/shared/db/schema.ts";

disableTestTransactionForFile();

Deno.test({
  name: "resetDbForTest: carousel_slides 会被清空（2026-09-24 评审回归）",
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    await resetDbForTest();
    const db = getDb();
    const now = new Date().toISOString();

    await db.insert(carouselSlides).values({
      id: crypto.randomUUID(),
      kind: "text",
      title: "reset-probe",
      sort_order: 0,
      is_enabled: true,
      created_at: now,
      updated_at: now,
    });
    assertEquals((await db.select().from(carouselSlides)).length, 1);

    await resetDbForTest();

    assertEquals(
      (await db.select().from(carouselSlides)).length,
      0,
      "resetDbForTest 后 carousel_slides 必须为空（否则跨用例污染）",
    );
  },
});

Deno.test({
  name: "resetDbForTest: sse_events 会被清空（同批补登记的表）",
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
    const now = new Date().toISOString();
    await db.insert(carouselSlides).values({
      id: crypto.randomUUID(),
      kind: "image",
      title: "t",
      image_storage_url: "noj-storage://probe.png",
      sort_order: 1,
      is_enabled: false,
      created_at: now,
      updated_at: now,
    });
    await resetDbForTest();
    assertEquals((await db.select().from(carouselSlides)).length, 0);
  },
});
