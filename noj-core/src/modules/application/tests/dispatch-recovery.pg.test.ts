/**
 * 评测派发任务恢复测试（P4）。
 *
 * 覆盖交接文档 §4.4 的 application/tests/dispatch-recovery.pg.test.ts 要求：
 * - 受理事务提交后进程退出：任务仍在库，重启后可从数据库事实重建并派发；
 * - Redis 中断：任务保留 pending 并按退避重试，提交不会变成孤儿；
 * - 任务身份（attempt/run）重试时保持不变。
 */
import { assertEquals } from "jsr:@std/assert@^1";
import { sql } from "drizzle-orm";
import { getDb } from "../../../shared/db/connection.ts";
import { resetDbForTest } from "../../../../tests/helpers/db.ts";
import { backgroundTasks } from "../../../shared/db/schema.ts";
import {
  claimTasks,
  enqueueTaskTx,
  failTaskTx,
  getTaskById,
} from "../../runtime/index.ts";
import { missingTaskHandlers } from "../background-handlers.ts";

async function reset(): Promise<void> {
  await resetDbForTest();
  await getDb().execute(sql`DELETE FROM background_tasks`);
}

Deno.test("dispatch recovery[真实 PG]: 提交事务内的派发任务在重启后仍可领取", async () => {
  await reset();
  const db = getDb();
  const submissionId = crypto.randomUUID();
  const attemptId = crypto.randomUUID();
  // 模拟"提交 + attempt + 派发任务"同事务提交后进程崩溃。
  await db.transaction((tx) =>
    enqueueTaskTx(tx, {
      taskType: "evaluation.dispatch",
      targetKind: "submission",
      targetId: submissionId,
      dedupeKey: attemptId,
      payload: { attempt_id: attemptId, submission_id: submissionId },
    })
  );
  // 重启：任务可被领取，且 payload 保留同一 attempt identity。
  const [claimed] = await claimTasks("worker-restart", 5, 60_000, db);
  assertEquals(claimed.taskType, "evaluation.dispatch");
  assertEquals(claimed.targetId, submissionId);
  assertEquals(claimed.payload.attempt_id, attemptId);
  assertEquals(claimed.payload.submission_id, submissionId);
});

Deno.test("dispatch recovery[真实 PG]: Redis 中断时任务保留并可退避重试", async () => {
  await reset();
  const db = getDb();
  const submissionId = crypto.randomUUID();
  const attemptId = crypto.randomUUID();
  await db.transaction((tx) =>
    enqueueTaskTx(tx, {
      taskType: "evaluation.dispatch",
      targetKind: "submission",
      targetId: submissionId,
      dedupeKey: attemptId,
      payload: { attempt_id: attemptId, submission_id: submissionId },
    })
  );
  const [claimed] = await claimTasks("worker-1", 1, 60_000, db);
  // 模拟 Redis 不可用导致的派发失败。
  const outcome = await db.transaction((tx) =>
    failTaskTx(tx, claimed.id, claimed.leaseToken, "Redis 连接不可用")
  );
  assertEquals(outcome.recorded, true);
  assertEquals(outcome.terminal, false);

  const row = await getTaskById(claimed.id, db);
  assertEquals(row?.status, "pending");
  assertEquals(row?.failure_count, 1);
  // 退避后仍可再次领取（把 available_at 提前模拟时间流逝）。
  await db.execute(
    sql`UPDATE background_tasks SET available_at = '2000-01-01T00:00:00.000Z' WHERE id = ${claimed.id}`,
  );
  const [retried] = await claimTasks("worker-2", 1, 60_000, db);
  assertEquals(retried.id, claimed.id);
  // 同一 attempt identity：重试不会生成新的 run。
  assertEquals(retried.payload.attempt_id, attemptId);
});

Deno.test("dispatch recovery[真实 PG]: 重复入队不产生第二条派发任务", async () => {
  await reset();
  const db = getDb();
  const submissionId = crypto.randomUUID();
  const attemptId = crypto.randomUUID();
  const first = await db.transaction((tx) =>
    enqueueTaskTx(tx, {
      taskType: "evaluation.dispatch",
      targetKind: "submission",
      targetId: submissionId,
      dedupeKey: attemptId,
      payload: { attempt_id: attemptId },
    })
  );
  const second = await db.transaction((tx) =>
    enqueueTaskTx(tx, {
      taskType: "evaluation.dispatch",
      targetKind: "submission",
      targetId: submissionId,
      dedupeKey: attemptId,
      payload: { attempt_id: attemptId },
    })
  );
  assertEquals(first.created, true);
  assertEquals(second.created, false);
  assertEquals(first.taskId, second.taskId);
  const rows = await db.select().from(backgroundTasks);
  assertEquals(rows.length, 1);
});

Deno.test("dispatch recovery: handler 注册表覆盖全部任务类型", () => {
  const missing = missingTaskHandlers({
    "search.index": () => Promise.resolve(),
    "evaluation.dispatch": () => Promise.resolve(),
    "education.recompute": () => Promise.resolve(),
    "storage.reclaim": () => Promise.resolve(),
    "notification.email": () => Promise.resolve(),
  });
  assertEquals(missing, []);
  const partial = missingTaskHandlers({
    "search.index": () => Promise.resolve(),
  });
  assertEquals(partial.includes("evaluation.dispatch"), true);
});
