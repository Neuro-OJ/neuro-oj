/** 重测任务（rejudge）的读取：任务详情与条目分页列表。 */

import { and, eq, sql } from "drizzle-orm";
import { getDb } from "../../../../shared/db/connection.ts";
import {
  submissionJobItems,
  submissionJobs,
} from "../../../../shared/db/schema.ts";
import type { SubmissionJobItemStatus } from "../../../../shared/versioning/types.ts";
import { countItemsByStatus } from "./rejudge-common.ts";
import type { JobItemView, JobView } from "./rejudge-types.ts";

/** 读取任务（含按状态聚合的计数）。 */
export async function getRejudgeJob(jobId: string): Promise<JobView | null> {
  const db = getDb();
  const [job] = await db.select().from(submissionJobs).where(
    eq(submissionJobs.id, jobId),
  ).limit(1);
  if (!job) return null;
  const counts = await countItemsByStatus(jobId, db);
  const total = Object.values(counts).reduce((sum, value) => sum + value, 0);
  return {
    id: job.id,
    kind: job.kind,
    actor_id: job.actor_id,
    status: job.status,
    created_at: job.created_at,
    finished_at: job.finished_at,
    counts,
    total_items: total,
  };
}

/** 分页读取任务条目。 */
export async function listRejudgeJobItems(
  jobId: string,
  options: {
    page?: number;
    perPage?: number;
    status?: SubmissionJobItemStatus;
  } = {},
): Promise<{ data: JobItemView[]; total: number }> {
  const db = getDb();
  const page = Math.max(1, options.page ?? 1);
  const perPage = Math.min(100, Math.max(1, options.perPage ?? 20));
  const where = options.status
    ? and(
      eq(submissionJobItems.job_id, jobId),
      eq(submissionJobItems.status, options.status),
    )
    : eq(submissionJobItems.job_id, jobId);
  const [countRow] = await db.select({
    count: sql<number>`count(*)::int`,
  }).from(submissionJobItems).where(where);
  const rows = await db.select().from(submissionJobItems).where(where)
    .orderBy(submissionJobItems.ordinal)
    .limit(perPage).offset((page - 1) * perPage);
  return {
    data: rows.map((row) => ({
      id: row.id,
      ordinal: row.ordinal,
      source_kind: row.source_kind,
      source_id: row.source_id,
      problem_id: row.problem_id,
      target_version_id: row.target_version_id,
      target_version_ref: row.target_version_ref,
      status: row.status,
      attempt_id: row.attempt_id,
      reason_code: row.reason_code,
      reason_message: row.reason_message,
    })),
    total: countRow?.count ?? 0,
  };
}
