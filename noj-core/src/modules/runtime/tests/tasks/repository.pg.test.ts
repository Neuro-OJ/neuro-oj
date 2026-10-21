/**
 * 后台任务仓库真实 PostgreSQL 测试（P4）。
 *
 * 覆盖交接文档 §4.4 要求的不变量：
 * - 事务回滚不留下任务；
 * - 并发同键只产生一条；
 * - 两个领取者互斥；
 * - 过期租约可回收（并计入失败次数）；
 * - 旧 token 无法续租/完成/失败；
 * - 人工重试与领取竞争正确。
 */
import { assertEquals } from "jsr:@std/assert@^1";
import { sql } from "drizzle-orm";
import { getDb } from "../../../../shared/db/connection.ts";
import { backgroundTasks } from "../../../../shared/db/schema.ts";
import { resetDbForTest } from "../../../../../tests/helpers/db.ts";
import {
  claimTasks,
  completeTaskTx,
  enqueueTaskTx,
  failTaskTx,
  getTaskById,
  readTaskHealth,
  renewTaskLease,
  requeueFailedTaskTx,
} from "../../tasks/repository.ts";

const TYPE = "search.index" as const;

async function reset(): Promise<void> {
  await resetDbForTest();
  const db = getDb();
  // resetDbForTest 已 truncate 全库；显式再清一次，避免并行用例互相干扰。
  await db.execute(sql`DELETE FROM background_tasks`);
}

Deno.test("task repository[真实 PG]: 事务回滚不留下任务", async () => {
  await reset();
  const db = getDb();
  try {
    await db.transaction(async (tx) => {
      await enqueueTaskTx(tx, {
        taskType: TYPE,
        targetKind: "problem",
        targetId: "p-rollback",
        dedupeKey: "reindex",
      });
      throw new Error("模拟业务失败");
    });
  } catch {
    // 预期回滚
  }
  const health = await readTaskHealth(db);
  assertEquals(health.ready, 0);
  assertEquals(health.leased, 0);
  assertEquals(health.failed, 0);
});

Deno.test("task repository[真实 PG]: 并发同键只产生一条任务", async () => {
  await reset();
  const db = getDb();
  const results = await Promise.all(
    Array.from({ length: 6 }, () =>
      db.transaction((tx) =>
        enqueueTaskTx(tx, {
          taskType: TYPE,
          targetKind: "problem",
          targetId: "p-dedupe",
          dedupeKey: "reindex",
        })
      )),
  );
  const created = results.filter((result) => result.created);
  assertEquals(created.length, 1);
  assertEquals(new Set(results.map((r) => r.taskId)).size, 1);
});

Deno.test("task repository[真实 PG]: 两个领取者互斥且各自拿到不同任务", async () => {
  await reset();
  const db = getDb();
  await db.transaction(async (tx) => {
    await enqueueTaskTx(tx, {
      taskType: TYPE,
      targetKind: "problem",
      targetId: "p-a",
      dedupeKey: "reindex",
    });
    await enqueueTaskTx(tx, {
      taskType: TYPE,
      targetKind: "problem",
      targetId: "p-b",
      dedupeKey: "reindex",
    });
  });
  const [first, second] = await Promise.all([
    claimTasks("worker-1", 5, 60_000, db),
    claimTasks("worker-2", 5, 60_000, db),
  ]);
  const all = [...first, ...second];
  assertEquals(all.length, 2);
  assertEquals(new Set(all.map((task) => task.id)).size, 2);
});

Deno.test("task repository[真实 PG]: 旧 token 无法续租/完成/失败", async () => {
  await reset();
  const db = getDb();
  await db.transaction((tx) =>
    enqueueTaskTx(tx, {
      taskType: TYPE,
      targetKind: "problem",
      targetId: "p-token",
      dedupeKey: "reindex",
    })
  );
  const [claimed] = await claimTasks("worker-1", 1, 60_000, db);
  assertEquals(claimed.leaseToken.length > 0, true);

  assertEquals(
    await renewTaskLease(claimed.id, "bogus-token", 60_000, db),
    null,
  );
  assertEquals(
    await db.transaction((tx) =>
      completeTaskTx(tx, claimed.id, "bogus-token", {})
    ),
    false,
  );
  assertEquals(
    (await db.transaction((tx) =>
      failTaskTx(tx, claimed.id, "bogus-token", "x")
    )).recorded,
    false,
  );
  // 正确 token 仍可完成
  assertEquals(
    await db.transaction((tx) =>
      completeTaskTx(tx, claimed.id, claimed.leaseToken, { ok: true })
    ),
    true,
  );
  const row = await getTaskById(claimed.id, db);
  assertEquals(row?.status, "succeeded");
});

Deno.test("task repository[真实 PG]: 过期租约可回收并计入失败次数", async () => {
  await reset();
  const db = getDb();
  await db.transaction((tx) =>
    enqueueTaskTx(tx, {
      taskType: TYPE,
      targetKind: "problem",
      targetId: "p-expire",
      dedupeKey: "reindex",
    })
  );
  // 领取后立刻把租约改成过去时间，模拟 worker 崩溃。
  const [claimed] = await claimTasks("worker-1", 1, 60_000, db);
  await db.execute(
    sql`UPDATE background_tasks SET lease_expiry = '2000-01-01T00:00:00.000Z' WHERE id = ${claimed.id}`,
  );

  const [reclaimed] = await claimTasks("worker-2", 1, 60_000, db);
  assertEquals(reclaimed.id, claimed.id);
  assertEquals(reclaimed.failureCount, 1);
  assertEquals(reclaimed.leaseToken !== claimed.leaseToken, true);
});

Deno.test("task repository[真实 PG]: 连续失败 20 次转终态且可人工重试", async () => {
  await reset();
  const db = getDb();
  await db.transaction((tx) =>
    enqueueTaskTx(tx, {
      taskType: TYPE,
      targetKind: "problem",
      targetId: "p-fail",
      dedupeKey: "reindex",
    })
  );
  let lastTerminal = false;
  for (let i = 0; i < 20; i++) {
    const [claimed] = await claimTasks("worker-1", 1, 60_000, db);
    if (!claimed) break;
    const outcome = await db.transaction((tx) =>
      failTaskTx(tx, claimed.id, claimed.leaseToken, `失败 ${i}`)
    );
    lastTerminal = outcome.terminal;
    if (!outcome.terminal) {
      // 退避会把 available_at 推到未来：直接清掉等待，便于下一次领取。
      await db.execute(
        sql`UPDATE background_tasks SET available_at = '2000-01-01T00:00:00.000Z' WHERE id = ${claimed.id}`,
      );
    }
  }
  assertEquals(lastTerminal, true);

  const [failed] = await db.select().from(backgroundTasks);
  assertEquals(failed.status, "failed");
  assertEquals(failed.failure_count, 20);

  // 终态失败不会被普通领取拿到。
  assertEquals((await claimTasks("worker-3", 5, 60_000, db)).length, 0);

  // 人工重试后重新可领取，且失败计数清零。
  assertEquals(
    await db.transaction((tx) => requeueFailedTaskTx(tx, failed.id)),
    true,
  );
  const [reclaimed] = await claimTasks("worker-4", 1, 60_000, db);
  assertEquals(reclaimed.id, failed.id);
  assertEquals(reclaimed.failureCount, 0);
});
