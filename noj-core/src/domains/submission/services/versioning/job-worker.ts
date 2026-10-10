/**
 * 批任务 worker 的领取、租约与终态（Handbook §5.7）。
 *
 * 设计要点：
 * - **领取使用独立短事务**：`FOR UPDATE SKIP LOCKED` 领取后立即提交，
 *   业务事务（建尝试、派发）在锁外执行，绝不持锁等待外部 IO；
 * - **lease 60 秒**，执行期间续租；崩溃后 lease 到期可被重新领取；
 * - 网络派发失败按 1/2/4/8/16 秒指数退避，超过 5 次标记条目 `failed`；
 * - 队列容量不足属于**可等待**情况：重新排队但不计作派发失败（`requeueJobItem`）；
 * - 条目终态写入是**幂等**的：已是终态的行不会被覆盖（防止重复派发把
 *   `succeeded` 改回 `dispatched`）；
 * - 全部条目终态后由 `refreshJobStatus` 推导任务状态（无进程内计数器）。
 */

import { and, eq, inArray, isNull, lte, or, sql } from "drizzle-orm";
import { getDb } from "../../../../shared/db/connection.ts";
import type { Executor } from "../../../../shared/db/executor.ts";
import {
  submissionJobItems,
  submissionJobs,
} from "../../../../shared/db/schema.ts";
import type { SubmissionJobItemStatus } from "../../../../shared/versioning/types.ts";
import { refreshJobStatus } from "./rejudge-jobs.ts";

/** 默认 lease 时长（秒）。 */
export const JOB_ITEM_LEASE_SECONDS = 60;
/** 单次领取上限。 */
export const JOB_ITEM_CLAIM_LIMIT = 100;
/** 网络派发失败的最大重试次数与退避序列（秒）。 */
export const DISPATCH_BACKOFF_SECONDS = [1, 2, 4, 8, 16] as const;

/** 领取到的条目。 */
export interface ClaimedJobItem {
  id: string;
  job_id: string;
  ordinal: number;
  source_kind: "submission" | "objective";
  source_id: string;
  problem_id: string;
  target_version_id: string | null;
  target_version_ref: string | null;
  dispatch_retries: number;
}

/** 条目终态。 */
export type JobItemTerminalStatus = "succeeded" | "failed" | "skipped";

function nowIso(): string {
  return new Date().toISOString();
}

function plusSeconds(seconds: number): string {
  return new Date(Date.now() + seconds * 1000).toISOString();
}

/**
 * 领取一批可派发条目（独立短事务）。
 *
 * 可领取 = `pending` 且到达 `next_dispatch_at`，或 `preparing` 且 lease 已过期
 * （崩溃恢复）。
 */
export async function claimJobItems(
  owner: string,
  options: { limit?: number; leaseSeconds?: number } = {},
): Promise<ClaimedJobItem[]> {
  const db = getDb();
  const limit = Math.min(
    options.limit ?? JOB_ITEM_CLAIM_LIMIT,
    JOB_ITEM_CLAIM_LIMIT,
  );
  const leaseSeconds = options.leaseSeconds ?? JOB_ITEM_LEASE_SECONDS;
  const now = nowIso();

  return await db.transaction(async (tx) => {
    const rows = await tx.select({
      id: submissionJobItems.id,
      job_id: submissionJobItems.job_id,
      ordinal: submissionJobItems.ordinal,
      source_kind: submissionJobItems.source_kind,
      source_id: submissionJobItems.source_id,
      problem_id: submissionJobItems.problem_id,
      target_version_id: submissionJobItems.target_version_id,
      target_version_ref: submissionJobItems.target_version_ref,
      dispatch_retries: submissionJobItems.dispatch_retries,
    }).from(submissionJobItems).where(
      or(
        and(
          eq(submissionJobItems.status, "pending"),
          or(
            isNull(submissionJobItems.next_dispatch_at),
            lte(submissionJobItems.next_dispatch_at, now),
          ),
        ),
        and(
          eq(submissionJobItems.status, "preparing"),
          lte(submissionJobItems.lease_until, now),
        ),
      ),
    ).orderBy(submissionJobItems.ordinal).limit(limit).for("update", {
      skipLocked: true,
    });

    if (rows.length === 0) return [];
    const ids = rows.map((row) => row.id);
    await tx.update(submissionJobItems).set({
      status: "preparing",
      lease_owner: owner,
      lease_until: plusSeconds(leaseSeconds),
    }).where(inArray(submissionJobItems.id, ids));
    return rows as ClaimedJobItem[];
  });
}

/** 续租（执行期间调用；条目已终态时返回 false）。 */
export async function renewJobItemLease(
  itemId: string,
  owner: string,
  leaseSeconds = JOB_ITEM_LEASE_SECONDS,
): Promise<boolean> {
  const db = getDb();
  const rows = await db.update(submissionJobItems).set({
    lease_until: plusSeconds(leaseSeconds),
  }).where(
    and(
      eq(submissionJobItems.id, itemId),
      eq(submissionJobItems.lease_owner, owner),
      eq(submissionJobItems.status, "preparing"),
    ),
  ).returning({ id: submissionJobItems.id });
  return rows.length > 0;
}

/**
 * 标记条目已派发（条件更新）。
 *
 * **只在 `preparing` 时生效**：结果可能比这次状态更新更早到达并把条目写成
 * `succeeded`，此时不能把终态改回 `dispatched`。
 */
export async function markJobItemDispatched(
  itemId: string,
  attemptId: string,
  owner: string,
): Promise<boolean> {
  const db = getDb();
  const rows = await db.update(submissionJobItems).set({
    status: "dispatched",
    attempt_id: attemptId,
    lease_owner: null,
    lease_until: null,
  }).where(
    and(
      eq(submissionJobItems.id, itemId),
      eq(submissionJobItems.status, "preparing"),
      eq(submissionJobItems.lease_owner, owner),
    ),
  ).returning({ id: submissionJobItems.id });
  if (rows.length === 0) return false;
  await touchJobStatus(itemId, db);
  return true;
}

/**
 * 写条目终态（幂等）。
 *
 * 已是终态（succeeded/failed/skipped）的行不再被覆盖——相同尝试允许重复派发，
 * 但结果只应用一次。
 */
export async function completeJobItem(
  itemId: string,
  terminal: {
    status: JobItemTerminalStatus;
    attemptId?: string | null;
    reasonCode?: string | null;
    reasonMessage?: string | null;
  },
  executor?: Executor,
): Promise<boolean> {
  const db = executor ?? getDb();
  const rows = await db.update(submissionJobItems).set({
    status: terminal.status,
    attempt_id: terminal.attemptId ?? null,
    reason_code: terminal.reasonCode ?? null,
    reason_message: terminal.reasonMessage ?? null,
    lease_owner: null,
    lease_until: null,
    next_dispatch_at: null,
    finished_at: nowIso(),
  }).where(
    and(
      eq(submissionJobItems.id, itemId),
      sql`${submissionJobItems.status} NOT IN ('succeeded', 'failed', 'skipped')`,
    ),
  ).returning({ id: submissionJobItems.id });
  if (rows.length === 0) return false;
  await touchJobStatus(itemId, db);
  return true;
}

/** 依据条目 id 找到任务并刷新其聚合状态。 */
async function touchJobStatus(
  itemId: string,
  executor: Executor,
): Promise<void> {
  const [row] = await executor.select({ job_id: submissionJobItems.job_id })
    .from(submissionJobItems).where(eq(submissionJobItems.id, itemId)).limit(1);
  if (row) await refreshJobStatus(row.job_id, executor);
}

/**
 * 派发失败处理：未超过退避序列则重新排队，超过则条目 `failed`。
 *
 * @returns `true` 表示已重新排队（可重试），`false` 表示已标记失败
 */
export async function scheduleDispatchRetryOrFail(
  itemId: string,
  options: { reasonCode: string; reasonMessage: string },
): Promise<boolean> {
  const db = getDb();
  const [item] = await db.select({
    retries: submissionJobItems.dispatch_retries,
  }).from(submissionJobItems).where(eq(submissionJobItems.id, itemId)).limit(1);
  if (!item) return false;
  const retries = item.retries;
  if (retries >= DISPATCH_BACKOFF_SECONDS.length) {
    await completeJobItem(itemId, {
      status: "failed",
      reasonCode: options.reasonCode,
      reasonMessage: options.reasonMessage,
    });
    return false;
  }
  const backoff = DISPATCH_BACKOFF_SECONDS[retries];
  await db.update(submissionJobItems).set({
    status: "pending",
    dispatch_retries: retries + 1,
    next_dispatch_at: plusSeconds(backoff),
    lease_owner: null,
    lease_until: null,
  }).where(
    and(
      eq(submissionJobItems.id, itemId),
      sql`${submissionJobItems.status} NOT IN ('succeeded', 'failed', 'skipped')`,
    ),
  );
  return true;
}

/**
 * 队列容量不足时的重新排队：**不计作派发失败**（不退避计数）。
 */
export async function requeueJobItem(
  itemId: string,
  delaySeconds = 5,
): Promise<void> {
  const db = getDb();
  await db.update(submissionJobItems).set({
    status: "pending",
    next_dispatch_at: plusSeconds(delaySeconds),
    lease_owner: null,
    lease_until: null,
  }).where(
    and(
      eq(submissionJobItems.id, itemId),
      sql`${submissionJobItems.status} NOT IN ('succeeded', 'failed', 'skipped')`,
    ),
  );
}

/** 回收过期 lease（崩溃恢复）：`preparing` 且 lease 过期 → 回到 `pending`。 */
export async function requeueExpiredLeases(
  executor?: Executor,
): Promise<number> {
  const db = executor ?? getDb();
  const rows = await db.update(submissionJobItems).set({
    status: "pending",
    lease_owner: null,
    lease_until: null,
  }).where(
    and(
      eq(submissionJobItems.status, "preparing"),
      lte(submissionJobItems.lease_until, nowIso()),
    ),
  ).returning({ id: submissionJobItems.id, job_id: submissionJobItems.job_id });
  for (const jobId of new Set(rows.map((row) => row.job_id))) {
    await refreshJobStatus(jobId, db);
  }
  return rows.length;
}

/** 读取任务的活动条目（`preparing`/`dispatched`），用于观测与断言。 */
export async function listActiveJobItems(
  jobId: string,
  executor?: Executor,
): Promise<
  Array<
    { id: string; status: SubmissionJobItemStatus; attempt_id: string | null }
  >
> {
  const db = executor ?? getDb();
  return await db.select({
    id: submissionJobItems.id,
    status: submissionJobItems.status,
    attempt_id: submissionJobItems.attempt_id,
  }).from(submissionJobItems).where(
    and(
      eq(submissionJobItems.job_id, jobId),
      inArray(
        submissionJobItems.status,
        ["preparing", "dispatched"] as SubmissionJobItemStatus[],
      ),
    ),
  );
}

/** 任务是否仍可继续（存在未终态条目）。 */
export async function hasOpenJobItems(
  jobId: string,
  executor?: Executor,
): Promise<boolean> {
  const db = executor ?? getDb();
  const [row] = await db.select({ id: submissionJobItems.id })
    .from(submissionJobItems).where(
      and(
        eq(submissionJobItems.job_id, jobId),
        inArray(
          submissionJobItems.status,
          ["pending", "preparing", "dispatched"] as SubmissionJobItemStatus[],
        ),
      ),
    ).limit(1);
  return Boolean(row);
}

/** 读取任务行（幂等键校验等场景）。 */
export async function findJobById(jobId: string) {
  const db = getDb();
  const [row] = await db.select().from(submissionJobs).where(
    eq(submissionJobs.id, jobId),
  ).limit(1);
  return row ?? null;
}
