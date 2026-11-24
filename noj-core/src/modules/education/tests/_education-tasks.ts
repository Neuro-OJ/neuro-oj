/**
 * 教学事件任务的测试辅助。
 *
 * 生产中 `education.recompute` 由通用后台任务 worker 领取；测试需要确定性地
 * 排空教学任务，因此这里只领取教学任务类型，并按 worker 相同的语义提交
 * 完成 / 重新调度 / 失败。
 */
import { eq } from "drizzle-orm";
import { getDb } from "../../../shared/db/connection.ts";
import type { DbRoot } from "../../../shared/db/executor.ts";
import { backgroundTasks } from "../../../shared/db/schema.ts";
import {
  type ClaimedTask,
  isTaskRescheduleResult,
  TASK_DEFAULT_LEASE_MS,
  TASK_TYPES,
  type TaskHandler,
  type TaskHandlerMap,
  type TaskType,
} from "../../../shared/tasks/contracts.ts";
import {
  claimTasks,
  completeTaskTx,
  failTaskTx,
  rescheduleTaskTx,
} from "../../../shared/tasks/repository.ts";
import {
  EDUCATION_TASK_TYPE,
  type EducationTaskPayload,
} from "../contracts/facts.ts";
import { processEducationTask } from "../services/progress-worker.ts";

/** 领取一批已到期的教学任务（不处理）。 */
export async function claimEducationTasks(
  limit = 20,
  leaseDurationMs = TASK_DEFAULT_LEASE_MS,
): Promise<ClaimedTask[]> {
  return await claimTasks(
    "education-test",
    limit,
    leaseDurationMs,
    getDb(),
    [EDUCATION_TASK_TYPE],
  );
}

/**
 * 以 worker 语义执行一条已领取的教学任务。
 *
 * @returns 租约仍有效且结果已提交时为 true；租约失效（被他人接管）时为 false
 */
export async function runEducationTask(task: ClaimedTask): Promise<boolean> {
  const db = getDb();
  try {
    const result = await processEducationTask(
      task,
      new AbortController().signal,
    );
    if (isTaskRescheduleResult(result)) {
      return await db.transaction((tx) =>
        rescheduleTaskTx(tx, task.id, task.leaseToken, result)
      );
    }
    if (result && "skipped" in result && result.skipped === "lease_lost") {
      return false;
    }
    return await db.transaction((tx) =>
      completeTaskTx(tx, task.id, task.leaseToken, result ?? {})
    );
  } catch (error) {
    await db.transaction((tx) =>
      failTaskTx(
        tx,
        task.id,
        task.leaseToken,
        error instanceof Error ? error.message : String(error),
      )
    );
    return false;
  }
}

/** 领取并处理一批到期教学任务；返回空数组表示当前没有可处理任务。 */
export async function processEducationBatch(limit = 20) {
  const tasks = await claimEducationTasks(limit);
  const results: Array<{ id: string; succeeded: boolean }> = [];
  for (const task of tasks) {
    results.push({ id: task.id, succeeded: await runEducationTask(task) });
  }
  return results;
}

/** 反复处理直到没有到期教学任务（有上限，防止测试死循环）。 */
export async function drainEducationTasks(maxBatches = 50) {
  for (let i = 0; i < maxBatches; i++) {
    if (!(await processEducationBatch()).length) return;
  }
  throw new Error("教学任务在上限轮数内未排空");
}

/** 读取全部教学事件任务，payload 展开为事件字段便于断言。 */
export async function listEducationTasks(db: DbRoot = getDb()) {
  const rows = await db.select().from(backgroundTasks).where(
    eq(backgroundTasks.task_type, EDUCATION_TASK_TYPE),
  );
  return rows.map((row) => ({
    ...row,
    event: row.payload as unknown as EducationTaskPayload,
  }));
}

/** 只处理教学任务的 handler 表（配合 `startTaskWorker`）；其他类型显式失败。 */
export function educationOnlyHandlers(): TaskHandlerMap {
  const handlers = {} as Record<TaskType, TaskHandler>;
  for (const type of TASK_TYPES) {
    handlers[type] = () => Promise.reject(new Error(`测试未接入 ${type}`));
  }
  handlers[EDUCATION_TASK_TYPE] = processEducationTask;
  return handlers;
}
