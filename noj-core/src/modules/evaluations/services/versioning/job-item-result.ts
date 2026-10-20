/**
 * Judge 结果回写时的批任务条目终态。
 *
 * 这个入口只处理“可信结果已完成”这一条窄路径，故不依赖 worker。派发失败的
 * lease 校验与重试逻辑仍属于 worker；这样结果写入可以在不形成运行时循环的
 * 前提下，与尝试终态保持同一 DbTx。
 */

import { and, eq, sql } from "drizzle-orm";
import type { Executor } from "../../../../shared/db/executor.ts";
import { submissionJobItems } from "../../../../shared/db/schema.ts";
import { refreshJobStatus } from "./rejudge-jobs.ts";

/**
 * 完成某次尝试对应的批任务条目。
 *
 * 条目已经是终态时幂等跳过；同一事务内刷新任务聚合状态。
 */
export async function completeAttemptJobItem(
  attemptId: string,
  status: "succeeded" | "failed",
  executor: Executor,
): Promise<void> {
  const [item] = await executor.select({
    id: submissionJobItems.id,
    job_id: submissionJobItems.job_id,
  }).from(submissionJobItems).where(
    eq(submissionJobItems.attempt_id, attemptId),
  ).limit(1);
  if (!item) return;

  const rows = await executor.update(submissionJobItems).set({
    status,
    attempt_id: attemptId,
    reason_code: status === "failed" ? "PLATFORM_ERROR" : null,
    reason_message: status === "failed" ? "评测平台错误，未产生正式判定" : null,
    lease_owner: null,
    lease_until: null,
    next_dispatch_at: null,
    finished_at: new Date().toISOString(),
  }).where(
    and(
      eq(submissionJobItems.id, item.id),
      sql`${submissionJobItems.status} NOT IN ('succeeded', 'failed', 'skipped')`,
    ),
  ).returning({ id: submissionJobItems.id });

  if (rows.length > 0) await refreshJobStatus(item.job_id, executor);
}
