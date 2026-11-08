/** 重测任务（rejudge）的通用辅助：错误构造、分批写入条目、计数与任务终态推导。 */

import { eq, sql } from "drizzle-orm";
import { AppError } from "../../../../shared/base/errors.ts";
import { getDb } from "../../../../shared/db/connection.ts";
import type { Executor } from "../../../../shared/db/executor.ts";
import {
  submissionJobItems,
  submissionJobs,
} from "../../../../shared/db/schema.ts";
import { JOB_ITEM_INSERT_BATCH } from "./rejudge-types.ts";

/**
 * 分批插入任务条目（#41）。
 *
 * 保持调用方的事务上下文：分批只影响单语句规模，成员集合仍在受理事务内固定。
 */
export async function insertJobItemsBatched(
  executor: Executor,
  rows: ReadonlyArray<typeof submissionJobItems.$inferInsert>,
): Promise<void> {
  for (let offset = 0; offset < rows.length; offset += JOB_ITEM_INSERT_BATCH) {
    await executor.insert(submissionJobItems).values(
      rows.slice(offset, offset + JOB_ITEM_INSERT_BATCH),
    );
  }
}

/** 409：幂等键复用但请求不同。 */
export function idempotencyConflict(): AppError {
  return new AppError(
    "该 Idempotency-Key 已用于不同的请求",
    409,
    "IDEMPOTENCY_KEY_REUSED",
  );
}

/** 400：部分题目缺少指定版本（整次受理失败）。 */
export function missingTargetVersion(problemIds: string[]): AppError {
  return new AppError(
    `指定的目标版本缺失：${
      problemIds.join(", ")
    }（整次受理已拒绝，未产生任务）`,
    400,
    "TARGET_VERSION_MISSING",
  );
}

/** 统计任务条目数。 */
export async function countItems(
  jobId: string,
  executor: Executor,
): Promise<number> {
  const [row] = await executor.select({
    count: sql<number>`count(*)::int`,
  }).from(submissionJobItems).where(eq(submissionJobItems.job_id, jobId));
  return row?.count ?? 0;
}

/** 按状态聚合条目计数（不维护进程内计数器）。 */
export async function countItemsByStatus(
  jobId: string,
  executor: Executor,
): Promise<Record<string, number>> {
  const rows = await executor.select({
    status: submissionJobItems.status,
    count: sql<number>`count(*)::int`,
  }).from(submissionJobItems).where(eq(submissionJobItems.job_id, jobId))
    .groupBy(submissionJobItems.status);
  const out: Record<string, number> = {};
  for (const row of rows) out[row.status] = row.count;
  return out;
}

/**
 * 依据条目状态推导并写入任务终态（§5.7「job 状态与统计由持久化条目推导」）。
 *
 * 全部条目进入终态（succeeded/failed/skipped）后：有 failed → `completed_with_errors`，
 * 否则 `completed`。
 *
 * #39（不得从 completed 回退 running）：聚合读取与任务更新必须在**同一事务内、
 * 持有任务行锁之后**执行。`FOR UPDATE` 先把并发聚合串行化，随后在同一事务内
 * 重新统计条目，因此后进入的调用必然看到先前调用已提交的条目终态，
 * 过时的「还有在途条目」结果无法再写回任务行。
 */
export async function refreshJobStatus(
  jobId: string,
  executor?: Executor,
): Promise<string> {
  if (!executor) {
    return await getDb().transaction((tx) => refreshJobStatus(jobId, tx));
  }
  const db = executor;
  await db.select({ id: submissionJobs.id }).from(submissionJobs).where(
    eq(submissionJobs.id, jobId),
  ).for("update");
  const counts = await countItemsByStatus(jobId, db);
  const pending = (counts.pending ?? 0) + (counts.preparing ?? 0) +
    (counts.dispatched ?? 0);
  if (pending > 0) {
    const status = (counts.dispatched ?? 0) > 0 ? "running" : "queued";
    await db.update(submissionJobs).set({ status, finished_at: null }).where(
      eq(submissionJobs.id, jobId),
    );
    return status;
  }
  const status = (counts.failed ?? 0) > 0
    ? "completed_with_errors"
    : "completed";
  await db.update(submissionJobs).set({
    status,
    finished_at: new Date().toISOString(),
  }).where(eq(submissionJobs.id, jobId));
  return status;
}
