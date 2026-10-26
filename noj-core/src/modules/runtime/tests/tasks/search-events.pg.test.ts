import { assertEquals } from "jsr:@std/assert@^1";
import { sql } from "drizzle-orm";
import { getDb } from "../../../../shared/db/connection.ts";
import { resetDbForTest } from "../../../../../tests/helpers/db.ts";
import { enqueueSearchIndexTaskTx } from "../../../application/search-tasks.ts";
import { claimTasks, completeTaskTx } from "../../tasks/repository.ts";

Deno.test("search task[真实 PG]: 后续发布不被已完成或正在执行的旧事件吞掉", async () => {
  await resetDbForTest();
  const db = getDb();
  const enqueue = (version: string) =>
    db.transaction((tx) =>
      enqueueSearchIndexTaskTx(tx, "problem", "same-problem", "upsert", version)
    );
  const first = await enqueue("v1");
  assertEquals((await enqueue("v1")).taskId, first.taskId);
  const [claimed] = await claimTasks("index-worker", 1, 60_000, db);
  const second = await enqueue("v2");
  assertEquals(second.created, true);
  assertEquals(second.taskId === first.taskId, false);
  await db.transaction((tx) =>
    completeTaskTx(tx, claimed.id, claimed.leaseToken, {})
  );
  const third = await enqueue("v3");
  assertEquals(third.created, true);
  const rows = await db.execute(
    sql`SELECT status FROM background_tasks ORDER BY dedupe_key`,
  );
  assertEquals(
    Array.from(rows as unknown as { status: string }[]).map((row) =>
      row.status
    ),
    ["succeeded", "pending", "pending"],
  );
});
