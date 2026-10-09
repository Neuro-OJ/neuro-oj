/**
 * 用户升级任务受理（Handbook §4.4）。
 *
 * 「升级」= 用**当前最新版**（或 `source_contest` 下竞赛固定版）重做一条**新提交**：
 * - 新提交沿用原用户、记录升级来源（`upgraded_from_id`）、使用**当前时间**；
 * - 最新版在**受理时固定**，之后发布的新版不进入本批任务；
 * - 单次最多 500 条，受理时去重；
 * - `context = practice | source_contest`，默认 `practice`；
 * - `source_contest` 要求目标版本恰好是该竞赛的固定作答版本；
 * - 用户只能升级**自己的**提交；
 * - 跳过（skipped）而不是整批拒绝：源已删除、源正在评测、已在最新版、无已发布版本。
 *
 * worker 端 `applyUpgradeItem` 负责真正建新提交与派发（下一批次实现）。
 */

import { and, eq } from "drizzle-orm";
import { AppError } from "../../../../shared/base/errors.ts";
import { getDb } from "../../../../shared/db/connection.ts";
import type { Executor } from "../../../../shared/db/executor.ts";
import {
  contestProblems,
  objectiveSubmissions,
  problems,
  submissionJobItems,
  submissionJobs,
  submissions,
} from "../../../../shared/db/schema.ts";
import { hashCanonical, MAX_SELECTED_SUBMISSIONS } from "./rejudge-jobs.ts";

/** 升级上下文。 */
export type UpgradeContext = "practice" | "source_contest";

/** 升级请求体（§4.4）。 */
export interface UpgradeRequest {
  submissions: Array<{ kind: "submission" | "objective"; id: string }>;
  context?: UpgradeContext;
}

/** 受理结果。 */
export interface AcceptUpgradeResult {
  job_id: string;
  status: string;
  total_items: number;
  skipped_items: number;
  existing: boolean;
}

/** 源提交读模型。 */
interface UpgradeSource {
  kind: "submission" | "objective";
  id: string;
  user_id: string;
  problem_id: string;
  contest_id: string | null;
  submitted_version_id: string | null;
  active_attempt_id: string | null;
}

async function loadSource(
  kind: "submission" | "objective",
  id: string,
  executor: Executor,
): Promise<UpgradeSource | null> {
  if (kind === "submission") {
    const [row] = await executor.select({
      id: submissions.id,
      user_id: submissions.user_id,
      problem_id: submissions.problem_id,
      contest_id: submissions.contest_id,
      submitted_version_id: submissions.submitted_version_id,
      active_attempt_id: submissions.active_attempt_id,
    }).from(submissions).where(eq(submissions.id, id)).limit(1);
    return row ? { kind, ...row } : null;
  }
  const [row] = await executor.select({
    id: objectiveSubmissions.id,
    user_id: objectiveSubmissions.user_id,
    problem_id: objectiveSubmissions.paper_id,
    contest_id: objectiveSubmissions.contest_id,
    submitted_version_id: objectiveSubmissions.submitted_version_id,
    active_attempt_id: objectiveSubmissions.active_attempt_id,
  }).from(objectiveSubmissions).where(
    eq(objectiveSubmissions.id, id),
  ).limit(1);
  return row ? { kind, ...row } : null;
}

/** 读取题目最新已发布版本。 */
async function latestVersionOf(
  problemId: string,
  executor: Executor,
): Promise<string | null> {
  const [row] = await executor.select({ latest: problems.latest_version_id })
    .from(problems).where(eq(problems.id, problemId)).limit(1);
  return row?.latest ?? null;
}

/** 读取竞赛固定作答版本。 */
async function contestPinnedVersionOf(
  contestId: string,
  problemId: string,
  executor: Executor,
): Promise<string | null> {
  const [row] = await executor.select({
    pinned: contestProblems.pinned_version_id,
  }).from(contestProblems).where(
    and(
      eq(contestProblems.contest_id, contestId),
      eq(contestProblems.problem_id, problemId),
    ),
  ).limit(1);
  return row?.pinned ?? null;
}

/** 受理用户升级任务。 */
export async function acceptUpgradeJob(
  actorId: string,
  request: UpgradeRequest,
  idempotencyKey: string,
): Promise<AcceptUpgradeResult> {
  if (!idempotencyKey || idempotencyKey.length > 128) {
    throw new AppError(
      "必须提供 Idempotency-Key（≤128 字符）",
      400,
      "IDEMPOTENCY_KEY_REQUIRED",
    );
  }
  const entries = Array.isArray(request?.submissions)
    ? request.submissions
    : null;
  if (!entries) {
    throw new AppError(
      "submissions 必须是数组",
      400,
      "INVALID_UPGRADE_REQUEST",
    );
  }
  if (entries.length > MAX_SELECTED_SUBMISSIONS) {
    throw new AppError(
      `单次升级不得超过 ${MAX_SELECTED_SUBMISSIONS} 条`,
      400,
      "TOO_MANY_SUBMISSIONS",
    );
  }
  const context: UpgradeContext = request.context === "source_contest"
    ? "source_contest"
    : "practice";
  const normalized = {
    submissions: entries.map((entry) => ({
      kind: entry.kind === "objective"
        ? "objective" as const
        : "submission" as const,
      id: entry.id,
    })),
    context,
  };
  // 哈希覆盖 kind / 提交集合 / context：同键不同请求必须 409
  const requestHash = await hashCanonical({
    kind: "upgrade",
    submissions: normalized.submissions,
    context: normalized.context,
  });

  const db = getDb();
  const [existingJob] = await db.select().from(submissionJobs).where(
    and(
      eq(submissionJobs.actor_id, actorId),
      eq(submissionJobs.kind, "upgrade"),
      eq(submissionJobs.idempotency_key, idempotencyKey),
    ),
  ).limit(1);
  if (existingJob) {
    if (existingJob.request_hash !== requestHash) {
      throw new AppError(
        "该 Idempotency-Key 已用于不同的请求",
        409,
        "IDEMPOTENCY_KEY_REUSED",
      );
    }
    const items = await listUpgradeItems(existingJob.id, db);
    return {
      job_id: existingJob.id,
      status: existingJob.status,
      total_items: items.total,
      skipped_items: items.skipped,
      existing: true,
    };
  }

  // 去重（同一提交只生成一个条目）
  const seen = new Set<string>();
  const planned: Array<{
    source: UpgradeSource;
    targetVersionId: string | null;
    skipped?: { code: string; message: string };
  }> = [];
  for (const entry of normalized.submissions) {
    const key = `${entry.kind}:${entry.id}`;
    if (seen.has(key)) continue;
    seen.add(key);

    const source = await loadSource(entry.kind, entry.id, db);
    if (!source) {
      // 源提交已删除：保留原始引用用于解释（不泄露内容）
      planned.push({
        source: {
          kind: entry.kind,
          id: entry.id,
          user_id: actorId,
          problem_id: "",
          contest_id: null,
          submitted_version_id: null,
          active_attempt_id: null,
        },
        targetVersionId: null,
        skipped: { code: "SOURCE_DELETED", message: "源提交已删除" },
      });
      continue;
    }
    if (source.user_id !== actorId) {
      throw new AppError(
        "只能升级自己的提交",
        403,
        "UPGRADE_FORBIDDEN",
      );
    }
    if (source.active_attempt_id) {
      planned.push({
        source,
        targetVersionId: null,
        skipped: {
          code: "SOURCE_JUDGING",
          message: "源提交正在评测，稍后可重试",
        },
      });
      continue;
    }

    const targetVersionId = context === "source_contest"
      ? (source.contest_id
        ? await contestPinnedVersionOf(source.contest_id, source.problem_id, db)
        : null)
      : await latestVersionOf(source.problem_id, db);
    if (!targetVersionId) {
      planned.push({
        source,
        targetVersionId: null,
        skipped: {
          code: context === "source_contest"
            ? "CONTEST_VERSION_UNKNOWN"
            : "NO_PUBLISHED_VERSION",
          message: context === "source_contest"
            ? "竞赛未固定作答版本，无法按竞赛版本升级"
            : "题目尚未发布任何版本",
        },
      });
      continue;
    }
    if (source.submitted_version_id === targetVersionId) {
      planned.push({
        source,
        targetVersionId,
        skipped: {
          code: "ALREADY_LATEST",
          message: "源提交已在该版本；如需再次评测请使用管理员重测",
        },
      });
      continue;
    }
    planned.push({ source, targetVersionId });
  }

  const now = new Date().toISOString();
  const jobId = crypto.randomUUID();
  const jobStatus = planned.length === 0 ? "completed" : "queued";
  await db.transaction(async (tx) => {
    await tx.insert(submissionJobs).values({
      id: jobId,
      kind: "upgrade",
      actor_id: actorId,
      idempotency_key: idempotencyKey,
      request_hash: requestHash,
      request: normalized as unknown as Record<string, unknown>,
      status: jobStatus,
      created_at: now,
      finished_at: planned.length === 0 ? now : null,
    });
    if (planned.length > 0) {
      await tx.insert(submissionJobItems).values(
        planned.map((entry, index): typeof submissionJobItems.$inferInsert => ({
          id: crypto.randomUUID(),
          job_id: jobId,
          ordinal: index,
          source_kind: entry.source.kind,
          source_id: entry.source.id,
          problem_id: entry.source.problem_id,
          target_version_id: entry.targetVersionId,
          target_version_ref: entry.targetVersionId,
          status: entry.skipped ? "skipped" : "pending",
          reason_code: entry.skipped?.code ?? null,
          reason_message: entry.skipped?.message ?? null,
          created_at: now,
          finished_at: entry.skipped ? now : null,
        })),
      );
    }
  });

  const skipped = planned.filter((entry) => entry.skipped).length;
  return {
    job_id: jobId,
    status: jobStatus,
    total_items: planned.length,
    skipped_items: skipped,
    existing: false,
  };
}

/** 统计任务的条目与 skipped 数。 */
async function listUpgradeItems(
  jobId: string,
  executor: Executor,
): Promise<{ total: number; skipped: number }> {
  const rows = await executor.select({
    status: submissionJobItems.status,
  }).from(submissionJobItems).where(eq(submissionJobItems.job_id, jobId));
  return {
    total: rows.length,
    skipped: rows.filter((row) => row.status === "skipped").length,
  };
}

/**
 * 读取升级任务（含条目），并按权限校验调用者。
 *
 * 用户只能读取自己的升级任务；管理员可读取全部（由调用方传入 `isAdmin`）。
 */
export async function getUpgradeJobForActor(
  jobId: string,
  actorId: string,
  isAdmin = false,
): Promise<
  {
    id: string;
    status: string;
    actor_id: string;
    context: UpgradeContext;
    items: Array<{
      id: string;
      source_kind: string;
      source_id: string;
      problem_id: string;
      target_version_id: string | null;
      status: string;
      reason_code: string | null;
      result_submission_id: string | null;
    }>;
  } | null
> {
  const db = getDb();
  const [job] = await db.select().from(submissionJobs).where(
    eq(submissionJobs.id, jobId),
  ).limit(1);
  if (!job) return null;
  if (!isAdmin && job.actor_id !== actorId) {
    throw new AppError("无权读取该任务", 403, "JOB_FORBIDDEN");
  }
  const items = await db.select().from(submissionJobItems).where(
    eq(submissionJobItems.job_id, jobId),
  ).orderBy(submissionJobItems.ordinal);
  const request = job.request as unknown as UpgradeRequest;
  return {
    id: job.id,
    status: job.status,
    actor_id: job.actor_id,
    context: request.context === "source_contest"
      ? "source_contest"
      : "practice",
    items: items.map((item) => ({
      id: item.id,
      source_kind: item.source_kind,
      source_id: item.source_id,
      problem_id: item.problem_id,
      target_version_id: item.target_version_id,
      status: item.status,
      reason_code: item.reason_code,
      result_submission_id: item.result_submission_id,
    })),
  };
}
