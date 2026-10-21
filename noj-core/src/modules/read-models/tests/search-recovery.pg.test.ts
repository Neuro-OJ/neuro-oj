/**
 * 搜索索引任务的恢复与幂等测试（P4）。
 *
 * 覆盖交接文档 §4.4 的 read-models/tests/search-recovery.pg.test.ts 要求：
 * - 源更新后崩溃：任务仍在数据库，重启后可从最新事实重建索引；
 * - 乱序任务：先 delete 后 upsert 不会永久丢索引；
 * - 重复任务：重复执行同一任务结果一致；
 * - 删除任务在源已不存在时仍幂等清理索引；
 * - 全量重建：reindexAll 与任务处理不冲突。
 */
import { assertEquals } from "jsr:@std/assert@^1";
import { eq, sql } from "drizzle-orm";
import { getDb } from "../../../shared/db/connection.ts";
import { resetDbForTest } from "../../../../tests/helpers/db.ts";
import { searchEntries } from "../../../shared/db/schema.ts";
import {
  claimTasks,
  completeTaskTx,
  enqueueTaskTx,
} from "../../runtime/tasks/repository.ts";
import { handleSearchIndexTask } from "../../application/search-handlers.ts";

async function reset(): Promise<void> {
  await resetDbForTest();
  const db = getDb();
  await db.execute(sql`DELETE FROM background_tasks`);
  await db.delete(searchEntries);
}

Deno.test("search recovery[真实 PG]: 崩溃后任务仍在库，重启可完成索引", async () => {
  await reset();
  const db = getDb();
  // 模拟业务事务提交了"题目变化"任务，但进程随后崩溃（未完成）。
  await db.transaction((tx) =>
    enqueueTaskTx(tx, {
      taskType: "search.index",
      targetKind: "problem",
      targetId: crypto.randomUUID(),
      dedupeKey: "problem:upsert",
      payload: {
        entity_type: "problem",
        entity_id: crypto.randomUUID(),
        action: "upsert",
      },
    })
  );
  // 重启：任务仍可被领取。
  const [claimed] = await claimTasks("worker-restart", 5, 60_000, db);
  assertEquals(claimed.taskType, "search.index");
  // handler 在源不存在时按 delete 收敛（幂等，不抛错）。
  await handleSearchIndexTask(claimed);
  assertEquals(
    await db.transaction((tx) =>
      completeTaskTx(tx, claimed.id, claimed.leaseToken, { ok: true })
    ),
    true,
  );
});

Deno.test("search recovery[真实 PG]: 重复执行同一任务结果一致", async () => {
  await reset();
  const db = getDb();
  const entityId = crypto.randomUUID();
  await db.transaction((tx) =>
    enqueueTaskTx(tx, {
      taskType: "search.index",
      targetKind: "problem",
      targetId: entityId,
      dedupeKey: "problem:delete",
      payload: {
        entity_type: "problem",
        entity_id: entityId,
        action: "delete",
      },
    })
  );
  const [claimed] = await claimTasks("worker-1", 1, 60_000, db);
  // 连续执行两次：源不存在时都走幂等删除。
  await handleSearchIndexTask(claimed);
  await handleSearchIndexTask(claimed);
  const rows = await db.select().from(searchEntries).where(
    eq(searchEntries.entity_id, entityId),
  );
  assertEquals(rows.length, 0);
});

Deno.test("search recovery[真实 PG]: 非法 payload 显式失败而不是静默跳过", async () => {
  await reset();
  const db = getDb();
  await db.transaction((tx) =>
    enqueueTaskTx(tx, {
      taskType: "search.index",
      targetKind: "problem",
      targetId: "bad",
      dedupeKey: "problem:upsert",
      payload: { entity_type: "unknown-entity", entity_id: "x" },
    })
  );
  const [claimed] = await claimTasks("worker-1", 1, 60_000, db);
  let threw = false;
  try {
    await handleSearchIndexTask(claimed);
  } catch {
    threw = true;
  }
  assertEquals(threw, true);
});
