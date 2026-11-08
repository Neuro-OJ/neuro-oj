/** 重测任务（rejudge）的重试：把父任务的 failed/skipped 条目生成为关联新任务。 */

import { and, eq, inArray, sql } from "drizzle-orm";
import { AppError } from "../../../../shared/base/errors.ts";
import { getDb } from "../../../../shared/db/connection.ts";
import {
  submissionJobItems,
  submissionJobs,
} from "../../../../shared/db/schema.ts";
import { resolveDefaultExecutionContexts } from "../../../problems/contracts/cross-module/services_workspace_execution-context.ts";
import { DEFAULT_DOMAIN_ID } from "../../../../shared/workspace/types.ts";
import type { SubmissionJobItemStatus } from "../../../../shared/versioning/types.ts";
import {
  countItems,
  idempotencyConflict,
  insertJobItemsBatched,
} from "./rejudge-common.ts";
import { hashRetryRequest } from "./rejudge-hash.ts";
import type { AcceptJobResult, RejudgeRequest } from "./rejudge-types.ts";

/**
 * 重试任务：只包含 `failed` / `skipped` 条目，生成**关联新任务**，
 * 保留目标版本映射，**不再次修改有效策略**。
 *
 * 锁序（Handbook §5.1）：本入口不写有效策略、不重算投影（重试请求的
 * `policy_changes` 恒为空，条目沿用父任务固定的目标版本），因此不获取任何
 * 题目/竞赛宿主锁，只在本事务内插入 `submission_jobs` / `submission_job_items`
 * 行——不参与「题目 → 竞赛 → 提交 → 尝试 → revision」争用，也就不可能与批量
 * 策略修改入口互相成环。若将来在此引入策略/竞赛锁，必须改为调用
 * `lockEffectivePolicyHosts` 一次拿全（题目升序 → 竞赛升序），而不是逐项获取。
 */
export async function retryRejudgeJob(
  actorId: string,
  jobId: string,
  idempotencyKey: string,
): Promise<AcceptJobResult> {
  const db = getDb();
  if (!idempotencyKey || idempotencyKey.length > 128) {
    throw new AppError(
      "必须提供 Idempotency-Key（≤128 字符）",
      400,
      "IDEMPOTENCY_KEY_REQUIRED",
    );
  }
  const [job] = await db.select().from(submissionJobs).where(
    eq(submissionJobs.id, jobId),
  ).limit(1);
  if (!job) {
    throw new AppError("任务不存在", 404, "JOB_NOT_FOUND");
  }
  // 父任务必须存在且为 rejudge：升级任务不能被解释成重测（#40）
  if (job.kind !== "rejudge") {
    throw new AppError("仅能重试重测任务", 400, "INVALID_JOB_KIND");
  }
  const retryable = await db.select().from(submissionJobItems).where(
    and(
      eq(submissionJobItems.job_id, jobId),
      inArray(
        submissionJobItems.status,
        ["failed", "skipped"] as SubmissionJobItemStatus[],
      ),
    ),
  ).orderBy(submissionJobItems.ordinal);
  if (retryable.length === 0) {
    throw new AppError(
      "该任务没有可重试的条目（仅 failed/skipped 可重试）",
      400,
      "NO_RETRYABLE_ITEMS",
    );
  }

  const request = job.request as unknown as RejudgeRequest;
  const requestHash = await hashRetryRequest(job.kind, jobId, retryable);
  const existing = await db.select().from(submissionJobs).where(
    and(
      eq(submissionJobs.actor_id, actorId),
      sql`(${submissionJobs.domain_id} IS NULL OR ${submissionJobs.domain_id} = ${DEFAULT_DOMAIN_ID})`,
      eq(submissionJobs.kind, "rejudge"),
      eq(submissionJobs.idempotency_key, idempotencyKey),
    ),
  ).limit(1);
  if (existing[0]) {
    if (existing[0].request_hash !== requestHash) throw idempotencyConflict();
    return {
      job_id: existing[0].id,
      status: existing[0].status,
      total_items: await countItems(existing[0].id, db),
      existing: true,
    };
  }

  const now = new Date().toISOString();
  const newJobId = crypto.randomUUID();
  const rows = retryable.map(
    (item, index): typeof submissionJobItems.$inferInsert => ({
      id: crypto.randomUUID(),
      domain_id: DEFAULT_DOMAIN_ID,
      job_id: newJobId,
      ordinal: index,
      source_kind: item.source_kind,
      source_id: item.source_id,
      problem_id: item.problem_id,
      target_version_id: item.target_version_id,
      target_version_ref: item.target_version_ref,
      status: "pending",
      created_at: now,
    }),
  );
  try {
    await db.transaction(async (tx) => {
      const contexts = await resolveDefaultExecutionContexts(
        rows.map((row) => row.problem_id),
        actorId,
        tx,
      );
      for (const row of rows) {
        const context = contexts.get(row.problem_id);
        row.domain_problem_binding_id = context?.domain_problem_binding_id ??
          null;
        if (!context) {
          row.status = "skipped";
          row.reason_code = "SOURCE_DELETED";
          row.reason_message = "源题已不存在，不能重新评测";
          row.finished_at = now;
        }
      }
      const complete = rows.every((row) => row.status === "skipped");
      await tx.insert(submissionJobs).values({
        id: newJobId,
        domain_id: DEFAULT_DOMAIN_ID,
        kind: "rejudge",
        actor_id: actorId,
        idempotency_key: idempotencyKey,
        request_hash: requestHash,
        request: {
          ...request,
          retry_of: jobId,
          policy_changes: [],
        } as unknown as Record<string, unknown>,
        status: complete ? "completed" : "queued",
        created_at: now,
        finished_at: complete ? now : null,
      });
      // 整题/整场任务的重试条目数可达数万：分批插入（#41）
      await insertJobItemsBatched(tx, rows);
    });
  } catch (error) {
    // 并发受理同一幂等键：唯一索引 (actor_id, kind, idempotency_key) 冲突后
    // 必须重读已提交任务并核对请求哈希，而不是把 23505 抛给调用方（#40）
    const [raced] = await db.select().from(submissionJobs).where(
      and(
        eq(submissionJobs.actor_id, actorId),
        sql`(${submissionJobs.domain_id} IS NULL OR ${submissionJobs.domain_id} = ${DEFAULT_DOMAIN_ID})`,
        eq(submissionJobs.kind, "rejudge"),
        eq(submissionJobs.idempotency_key, idempotencyKey),
      ),
    ).limit(1);
    if (raced) {
      if (raced.request_hash !== requestHash) throw idempotencyConflict();
      return {
        job_id: raced.id,
        status: raced.status,
        total_items: await countItems(raced.id, db),
        existing: true,
      };
    }
    throw error;
  }

  return {
    job_id: newJobId,
    status: rows.every((row) => row.status === "skipped")
      ? "completed"
      : "queued",
    total_items: retryable.length,
    existing: false,
  };
}
