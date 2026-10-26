import { assert, assertEquals } from "jsr:@std/assert@^1";
import { sql } from "drizzle-orm";
import { getDb } from "../../../../shared/db/connection.ts";
import { resetDbForTest } from "../../../../../tests/helpers/db.ts";
import { TASK_TYPES, type TaskHandlerMap } from "../../tasks/contracts.ts";
import {
  claimTasks,
  completeTaskTx,
  enqueueTaskTx,
  failTaskTx,
  getTaskById,
  renewTaskLease,
  rescheduleTaskTx,
} from "../../tasks/repository.ts";
import { startTaskWorker } from "../../tasks/worker.ts";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => resolve = done);
  return { promise, resolve };
}
function handlers(run: TaskHandlerMap["search.index"]): TaskHandlerMap {
  return Object.fromEntries(
    TASK_TYPES.map((type) => [type, run]),
  ) as unknown as TaskHandlerMap;
}
const delay = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));
async function bounded(promise: Promise<void>) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error("worker 未在限时内推进")),
          5000,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

Deno.test("task lease[真实 PG]: 过期未回收 token 不能续租、完成或记失败", async () => {
  await resetDbForTest();
  const db = getDb();
  await db.transaction((tx) =>
    enqueueTaskTx(tx, {
      taskType: "search.index",
      targetKind: "problem",
      targetId: "expired",
      dedupeKey: "event-1",
    })
  );
  const [task] = await claimTasks("old", 1, 60_000, db);
  await db.execute(
    sql`UPDATE background_tasks SET lease_expiry='2000-01-01T00:00:00.000Z' WHERE id=${task.id}`,
  );
  assertEquals(
    await renewTaskLease(task.id, task.leaseToken, 60_000, db),
    null,
  );
  assertEquals(
    await db.transaction((tx) => completeTaskTx(tx, task.id, task.leaseToken)),
    false,
  );
  assertEquals(
    await db.transaction((tx) =>
      rescheduleTaskTx(tx, task.id, task.leaseToken, {
        __task_control: "reschedule",
        availableAt: new Date().toISOString(),
        payload: { stale: true },
      })
    ),
    false,
  );
  assertEquals(
    await db.transaction((tx) =>
      failTaskTx(tx, task.id, task.leaseToken, "stale")
    ),
    { recorded: false, terminal: false },
  );
});

Deno.test("task lease[真实 PG]: 长事务不能用冻结的 now 完成已过期任务", async () => {
  await resetDbForTest();
  const db = getDb();
  await db.transaction((tx) =>
    enqueueTaskTx(tx, {
      taskType: "search.index",
      targetKind: "problem",
      targetId: "long-transaction",
      dedupeKey: "event",
    })
  );
  const [task] = await claimTasks("long-transaction-worker", 1, 60_000, db);
  await db.transaction(async (tx) => {
    // now() 固定在事务开始；让到期时刻处于该事务内部，再用数据库自身等待越过它。
    await tx.execute(
      sql`UPDATE background_tasks SET lease_expiry=to_char(clock_timestamp() AT TIME ZONE 'UTC' + interval '100 milliseconds', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') WHERE id=${task.id}`,
    );
    await tx.execute(sql`SELECT pg_sleep(0.2)`);
    assertEquals(await completeTaskTx(tx, task.id, task.leaseToken), false);
    assertEquals(
      await rescheduleTaskTx(tx, task.id, task.leaseToken, {
        __task_control: "reschedule",
        availableAt: new Date().toISOString(),
        payload: {},
      }),
      false,
    );
    assertEquals(
      await failTaskTx(tx, task.id, task.leaseToken, "expired-in-transaction"),
      { recorded: false, terminal: false },
    );
  });
});

Deno.test("task lease[真实 PG]: 长 handler 持续续租且批次尾部不预领", async () => {
  await resetDbForTest();
  const db = getDb();
  const task = await db.transaction((tx) =>
    enqueueTaskTx(tx, {
      taskType: "search.index",
      targetKind: "problem",
      targetId: "long",
      dedupeKey: "event-1",
      availableAt: "2000-01-01T00:00:00.000Z",
    })
  );
  const tail = await db.transaction((tx) =>
    enqueueTaskTx(tx, {
      taskType: "search.index",
      targetKind: "problem",
      targetId: "tail",
      dedupeKey: "event-2",
    })
  );
  const started = deferred(), release = deferred();
  const worker = startTaskWorker({
    workerId: "long-worker",
    db,
    claimLimit: 10,
    leaseDurationMs: 1000,
    pollIntervalMs: 10,
    handlers: handlers(async () => {
      started.resolve();
      await release.promise;
      return {};
    }),
  });
  try {
    await bounded(started.promise);
    await delay(2400);
    const row = await getTaskById(task.taskId, db);
    assertEquals(row?.status, "leased");
    assertEquals(row?.failure_count, 0);
    assertEquals((await getTaskById(tail.taskId, db))?.status, "pending");
    const competitors = await claimTasks("competitor", 10, 30_000, db);
    assertEquals(
      competitors.some((claimed) => claimed.id === task.taskId),
      false,
    );
    assertEquals(competitors.length, 1);
  } finally {
    release.resolve();
    worker.stop();
    await worker.done;
  }
  assertEquals((await getTaskById(task.taskId, db))?.status, "succeeded");
});

Deno.test("task lease[真实 PG]: 租约被新持有者接管后取消旧 handler", async () => {
  await resetDbForTest();
  const db = getDb();
  const task = await db.transaction((tx) =>
    enqueueTaskTx(tx, {
      taskType: "search.index",
      targetKind: "problem",
      targetId: "lost",
      dedupeKey: "event-1",
    })
  );
  const started = deferred(), aborted = deferred();
  const worker = startTaskWorker({
    workerId: "old-worker",
    db,
    claimLimit: 1,
    leaseDurationMs: 1000,
    pollIntervalMs: 10,
    handlers: handlers(async (_task, signal) => {
      signal.addEventListener("abort", aborted.resolve, { once: true });
      started.resolve();
      await aborted.promise;
      return {};
    }),
  });
  try {
    await bounded(started.promise);
    await db.execute(
      sql`UPDATE background_tasks SET lease_expiry='2000-01-01T00:00:00.000Z' WHERE id=${task.taskId}`,
    );
    const [newOwner] = await claimTasks("new-worker", 1, 60_000, db);
    assert(newOwner);
    await bounded(aborted.promise);
    worker.stop();
    await worker.done;
    assertEquals(
      (await getTaskById(task.taskId, db))?.lease_token,
      newOwner.leaseToken,
    );
    assertEquals((await getTaskById(task.taskId, db))?.status, "leased");
  } finally {
    aborted.resolve();
    worker.stop();
    await worker.done;
  }
});
