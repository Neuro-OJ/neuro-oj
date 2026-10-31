import { assertEquals } from "jsr:@std/assert@^1";
import { eq } from "drizzle-orm";
import { resetDbForTest } from "../../../../../../tests/helpers/db.ts";
import {
  assertSearchEventPublished,
  hasSearchIndexTask,
} from "../../../../../../tests/helper/search-events.ts";
import { getDb } from "../../../../../shared/db/connection.ts";
import { backgroundTasks } from "../../../../../shared/db/schema.ts";
import {
  cleanupSucceededSearchTasks,
  enqueueSearchIndexTask,
} from "../../../../application/search-tasks.ts";

await resetDbForTest();

Deno.test({
  name: "search task: enqueueSearchIndexTask 登记 search.index 任务",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const id = `p-${crypto.randomUUID()}`;
    await enqueueSearchIndexTask("problem", id, "upsert");
    await assertSearchEventPublished("problem", id, "upsert");
  },
});

Deno.test({
  name: "search task: 同一实体多次登记不合并，保证后续变更不被旧任务吞掉",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const id = `p-${crypto.randomUUID()}`;
    await enqueueSearchIndexTask("problem", id, "upsert");
    await enqueueSearchIndexTask("problem", id, "upsert");
    const rows = await getDb().select({ id: backgroundTasks.id }).from(
      backgroundTasks,
    ).where(eq(backgroundTasks.target_id, id));
    assertEquals(rows.length, 2);
  },
});

Deno.test({
  name: "search task: 传入业务事务时随事务回滚",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const id = `p-${crypto.randomUUID()}`;
    await getDb().transaction(async (tx) => {
      await enqueueSearchIndexTask("problem", id, "upsert", tx);
      tx.rollback();
    }).catch(() => {});
    assertEquals(await hasSearchIndexTask("problem", id, "upsert"), false);
  },
});

Deno.test({
  name: "search task: 传入业务事务时随事务提交",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const id = `p-${crypto.randomUUID()}`;
    await getDb().transaction(async (tx) => {
      await enqueueSearchIndexTask("problem", id, "upsert", tx);
    });
    assertEquals(await hasSearchIndexTask("problem", id, "upsert"), true);
  },
});

Deno.test({
  name: "search task: 保留清理只删除过期的已成功搜索任务",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const db = getDb();
    const now = new Date().toISOString();
    const old = new Date(Date.now() - 8 * 86400 * 1000).toISOString();
    const base = {
      target_kind: "problem",
      dedupe_key: "",
      payload: {},
      available_at: now,
      created_at: now,
      updated_at: now,
    };
    const tag = crypto.randomUUID();
    await db.insert(backgroundTasks).values([
      {
        ...base,
        id: `old-ok-${tag}`,
        task_type: "search.index",
        target_id: `old-ok-${tag}`,
        status: "succeeded",
        finished_at: old,
      },
      {
        ...base,
        id: `new-ok-${tag}`,
        task_type: "search.index",
        target_id: `new-ok-${tag}`,
        status: "succeeded",
        finished_at: now,
      },
      {
        ...base,
        id: `old-failed-${tag}`,
        task_type: "search.index",
        target_id: `old-failed-${tag}`,
        status: "failed",
        finished_at: old,
      },
      {
        ...base,
        id: `old-dispatch-${tag}`,
        task_type: "evaluation.dispatch",
        target_kind: "submission",
        target_id: `old-dispatch-${tag}`,
        status: "succeeded",
        finished_at: old,
      },
    ]);

    await cleanupSucceededSearchTasks(7);

    const remaining = new Set(
      (await db.select({ id: backgroundTasks.id }).from(backgroundTasks))
        .map((row) => row.id),
    );
    assertEquals(remaining.has(`old-ok-${tag}`), false);
    assertEquals(remaining.has(`new-ok-${tag}`), true);
    assertEquals(remaining.has(`old-failed-${tag}`), true);
    assertEquals(remaining.has(`old-dispatch-${tag}`), true);
  },
});
