/**
 * 后台任务 worker 真实 PostgreSQL 生命周期测试（P4）。
 *
 * 覆盖提交后子进程退出恢复，以及 stop 后等待在途 handler 完成的 drain 语义。
 */
import { assert, assertEquals } from "jsr:@std/assert@^1";
import { sql } from "drizzle-orm";
import { getDb } from "../../../../shared/db/connection.ts";
import { resetDbForTest } from "../../../../../tests/helpers/db.ts";
import {
  claimTasks,
  enqueueTaskTx,
  getTaskById,
} from "../../tasks/repository.ts";
import { TASK_TYPES, type TaskHandlerMap } from "../../tasks/contracts.ts";
import { startTaskWorker } from "../../tasks/worker.ts";

const db = getDb();

async function reset(): Promise<void> {
  await resetDbForTest();
  await db.execute(sql`DELETE FROM background_tasks`);
}

function allHandlers(
  override: Partial<TaskHandlerMap> = {},
): TaskHandlerMap {
  const handlers = Object.fromEntries(
    TASK_TYPES.map((type) => [type, async () => {
      await Promise.resolve();
      return { ok: true };
    }]),
  ) as unknown as TaskHandlerMap;
  return { ...handlers, ...override };
}

Deno.test("task worker[真实子进程]: 完成标记前退出后由新 worker 回收", async () => {
  await reset();
  const task = await db.transaction((tx) =>
    enqueueTaskTx(tx, {
      taskType: "evaluation.dispatch",
      targetKind: "submission",
      targetId: crypto.randomUUID(),
      dedupeKey: crypto.randomUUID(),
      payload: { attempt_id: crypto.randomUUID() },
    })
  );

  const fixture = new URL("./claim-and-exit.ts", import.meta.url);
  const command = new Deno.Command(Deno.execPath(), {
    args: ["run", "-A", fixture.pathname],
    stdout: "piped",
    stderr: "piped",
    env: {
      ...Deno.env.toObject(),
      NOJ_CRASH_WORKER_ID: "crash-subprocess",
    },
  });
  const output = await command.output();
  assertEquals(output.code, 0, new TextDecoder().decode(output.stderr));

  // 子进程没有调用 completeTaskTx；把租约推进到过去，模拟数据库时钟到达
  // 租约边界，再由新 worker 走正式回收路径。
  await db.execute(
    sql`UPDATE background_tasks SET lease_expiry = '2000-01-01T00:00:00.000Z' WHERE id = ${task.taskId}`,
  );
  const [reclaimed] = await claimTasks("recovery-worker", 1, 60_000, db);
  assertEquals(reclaimed.id, task.taskId);
  assertEquals(reclaimed.failureCount, 1);
  assertEquals(reclaimed.payload.attempt_id !== undefined, true);
});

Deno.test("task worker[真实 PG]: stop 后等待在途 handler 完成再结束", async () => {
  await reset();
  const task = await db.transaction((tx) =>
    enqueueTaskTx(tx, {
      taskType: "evaluation.dispatch",
      targetKind: "submission",
      targetId: crypto.randomUUID(),
      dedupeKey: crypto.randomUUID(),
    })
  );

  let startedResolve: (() => void) | undefined;
  const started = new Promise<void>((resolve) => startedResolve = resolve);
  const worker = startTaskWorker({
    workerId: "drain-worker",
    db,
    pollIntervalMs: 10,
    leaseDurationMs: 60_000,
    handlers: allHandlers({
      "evaluation.dispatch": async (_claimed, signal) => {
        startedResolve?.();
        await new Promise<void>((resolve) => {
          if (signal.aborted) {
            resolve();
            return;
          }
          signal.addEventListener("abort", () => resolve(), { once: true });
        });
        return { aborted: signal.aborted };
      },
    }),
  });

  await started;
  assertEquals((await getTaskById(task.taskId, db))?.status, "leased");
  worker.stop();
  await worker.done;

  const finished = await getTaskById(task.taskId, db);
  assert(finished !== null);
  assertEquals(finished?.status, "succeeded");
  assertEquals(finished?.lease_token, null);
});
