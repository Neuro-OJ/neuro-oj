/**
 * 批任务受理（Handbook §2.10、§4.3、§5.7 前半）。
 *
 * 管理员重测与用户升级共用 `submission_jobs` / `submission_job_items` 两张表，
 * 本文件实现**受理**（把请求变成固定的条目集合）与任务读取，worker 负责派发。
 *
 * 受理语义：
 * - `Idempotency-Key` 与 actor 绑定：同键同请求返回原任务，同键不同请求 → 409；
 * - **受理时同时固定提交集合**：之后产生的新提交不进入本批任务；
 * - `submitted` 用不可变提交时版本；未知历史版本 → 条目 `skipped`
 *   （`LEGACY_VERSION_UNKNOWN`），不整批拒绝；
 * - `latest` / `specified` 在受理事务中解析并固定到条目
 *   （`target_version_id` + `target_version_ref`）；
 * - 界面"全部用 V3"展开成逐题映射后，任一题没有该版本 → **整次受理 400**，
 *   不产生任务、不改策略；
 * - `policy_changes` 必须显式列出作用域与预期 revision，且只能作用于任务包含的
 *   题目/竞赛；校验全部通过后才应用策略并建任务；
 * - 手动所选上限 500；整题/整场无总量上限（后台分批）。
 */

import { and, eq, inArray, sql } from "drizzle-orm";
import { AppError } from "../../../../shared/base/errors.ts";
import { getDb } from "../../../../shared/db/connection.ts";
import type { Executor } from "../../../../shared/db/executor.ts";
import {
  objectiveSubmissions,
  problems,
  problemVersions,
  submissionJobItems,
  submissionJobs,
  submissions,
} from "../../../../shared/db/schema.ts";
import { canonicalJson } from "../../../catalog/index.ts";
import type {
  EffectiveVersionPolicy,
  SubmissionJobItemStatus,
} from "../../../../shared/versioning/types.ts";
import {
  setContestProblemEffectiveVersionPolicy,
  setProblemEffectiveVersionPolicy,
} from "./effective-policy.ts";

/** 手动所选提交上限。 */
export const MAX_SELECTED_SUBMISSIONS = 500;
/** worker 单次领取上限（§5.7）。 */
export const MAX_JOB_ITEMS_PER_CLAIM = 100;

/** 条目来源。 */
export type JobSourceKind = "submission" | "objective";

/** 重测范围。 */
export type RejudgeScope =
  | {
    type: "selected";
    submissions: Array<{ kind: JobSourceKind; id: string }>;
  }
  | { type: "problem"; problem_id: string }
  | { type: "contest"; contest_id: string };

/** 重测目标版本。 */
export type RejudgeTarget =
  | { mode: "submitted" }
  | { mode: "latest" }
  | { mode: "specified"; versions: Record<string, string> };

/** 策略变更请求。 */
export interface PolicyChangeRequest {
  problem_id: string;
  contest_id?: string;
  expected_revision: number;
  policy: EffectiveVersionPolicy;
}

/** 管理员重测请求体（§4.3）。 */
export interface RejudgeRequest {
  kind: "rejudge";
  scope: RejudgeScope;
  target: RejudgeTarget;
  policy_changes?: PolicyChangeRequest[];
}

/** 受理结果。 */
export interface AcceptJobResult {
  job_id: string;
  status: string;
  total_items: number;
  /** 已存在同幂等键任务时为 true（未新建）。 */
  existing: boolean;
}

/** 条目读模型。 */
export interface JobItemView {
  id: string;
  ordinal: number;
  source_kind: JobSourceKind;
  source_id: string;
  problem_id: string;
  target_version_id: string | null;
  target_version_ref: string | null;
  status: string;
  attempt_id: string | null;
  reason_code: string | null;
  reason_message: string | null;
}

/** 任务读模型。 */
export interface JobView {
  id: string;
  kind: string;
  actor_id: string;
  status: string;
  created_at: string;
  finished_at: string | null;
  /** 由条目聚合的计数（不维护进程内计数器）。 */
  counts: Record<string, number>;
  total_items: number;
}

/** 受理前的规范化条目。 */
interface PlannedItem {
  source_kind: JobSourceKind;
  source_id: string;
  problem_id: string;
  target_version_id: string | null;
  target_version_ref: string | null;
  skipped_reason?: { code: string; message: string };
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

/** 校验请求结构，返回规范化后的请求对象。 */
export function normalizeRejudgeRequest(
  request: RejudgeRequest,
): RejudgeRequest {
  if (!request || request.kind !== "rejudge") {
    throw new AppError("任务类型必须是 rejudge", 400, "INVALID_JOB_KIND");
  }
  const scope = request.scope;
  if (!scope || typeof scope !== "object") {
    throw new AppError("缺少重测范围", 400, "INVALID_JOB_SCOPE");
  }
  if (scope.type === "selected") {
    if (!Array.isArray(scope.submissions)) {
      throw new AppError(
        "selected 范围必须给出 submissions 数组",
        400,
        "INVALID_JOB_SCOPE",
      );
    }
  } else if (scope.type === "problem") {
    if (!scope.problem_id) {
      throw new AppError("缺少 problem_id", 400, "INVALID_JOB_SCOPE");
    }
  } else if (scope.type === "contest") {
    if (!scope.contest_id) {
      throw new AppError("缺少 contest_id", 400, "INVALID_JOB_SCOPE");
    }
  } else {
    throw new AppError("不支持的重测范围", 400, "INVALID_JOB_SCOPE");
  }
  const target = request.target;
  if (!target || typeof target !== "object") {
    throw new AppError("缺少目标版本", 400, "INVALID_JOB_TARGET");
  }
  if (target.mode === "specified") {
    const versions = target.versions;
    if (!versions || typeof versions !== "object" || Array.isArray(versions)) {
      throw new AppError(
        "specified 目标必须给出题目→版本映射",
        400,
        "INVALID_JOB_TARGET",
      );
    }
  } else if (target.mode !== "submitted" && target.mode !== "latest") {
    throw new AppError("不支持的目标版本模式", 400, "INVALID_JOB_TARGET");
  }
  return {
    kind: "rejudge",
    scope,
    target,
    policy_changes: request.policy_changes ?? [],
  };
}

/** 解析提交集合（受理时固定；去重后按首次出现顺序）。 */
async function resolveScopeItems(
  scope: RejudgeScope,
  executor: Executor,
): Promise<
  Array<
    {
      kind: JobSourceKind;
      id: string;
      problem_id: string;
      submitted_version_id: string | null;
      contest_id: string | null;
    }
  >
> {
  const db = executor;
  if (scope.type === "selected") {
    if (scope.submissions.length > MAX_SELECTED_SUBMISSIONS) {
      throw new AppError(
        `手动所选提交不得超过 ${MAX_SELECTED_SUBMISSIONS} 条`,
        400,
        "TOO_MANY_SUBMISSIONS",
      );
    }
    // 受理时去重：同一提交只生成一个条目
    const seen = new Set<string>();
    const planned: Array<{
      kind: JobSourceKind;
      id: string;
      problem_id: string;
      submitted_version_id: string | null;
      contest_id: string | null;
    }> = [];
    for (const entry of scope.submissions) {
      const key = `${entry.kind}:${entry.id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      if (entry.kind === "submission") {
        const [row] = await db.select({
          id: submissions.id,
          problem_id: submissions.problem_id,
          submitted_version_id: submissions.submitted_version_id,
          contest_id: submissions.contest_id,
        }).from(submissions).where(eq(submissions.id, entry.id)).limit(1);
        if (row) planned.push({ kind: "submission", ...row });
        continue;
      }
      const [row] = await db.select({
        id: objectiveSubmissions.id,
        problem_id: objectiveSubmissions.paper_id,
        submitted_version_id: objectiveSubmissions.submitted_version_id,
        contest_id: objectiveSubmissions.contest_id,
      }).from(objectiveSubmissions).where(
        eq(objectiveSubmissions.id, entry.id),
      ).limit(1);
      if (row) planned.push({ kind: "objective", ...row });
    }
    return planned;
  }

  if (scope.type === "problem") {
    const plain = await db.select({
      id: submissions.id,
      problem_id: submissions.problem_id,
      submitted_version_id: submissions.submitted_version_id,
      contest_id: submissions.contest_id,
    }).from(submissions).where(eq(submissions.problem_id, scope.problem_id));
    const objective = await db.select({
      id: objectiveSubmissions.id,
      problem_id: objectiveSubmissions.paper_id,
      submitted_version_id: objectiveSubmissions.submitted_version_id,
      contest_id: objectiveSubmissions.contest_id,
    }).from(objectiveSubmissions).where(
      eq(objectiveSubmissions.paper_id, scope.problem_id),
    );
    return [
      ...plain.map((row) => ({ kind: "submission" as const, ...row })),
      ...objective.map((row) => ({ kind: "objective" as const, ...row })),
    ];
  }

  const contestId = scope.contest_id;
  const plain = await db.select({
    id: submissions.id,
    problem_id: submissions.problem_id,
    submitted_version_id: submissions.submitted_version_id,
    contest_id: submissions.contest_id,
  }).from(submissions).where(eq(submissions.contest_id, contestId));
  const objective = await db.select({
    id: objectiveSubmissions.id,
    problem_id: objectiveSubmissions.paper_id,
    submitted_version_id: objectiveSubmissions.submitted_version_id,
    contest_id: objectiveSubmissions.contest_id,
  }).from(objectiveSubmissions).where(
    eq(objectiveSubmissions.contest_id, contestId),
  );
  return [
    ...plain.map((row) => ({ kind: "submission" as const, ...row })),
    ...objective.map((row) => ({ kind: "objective" as const, ...row })),
  ];
}

/** 读取题目最新已发布版本。 */
async function latestVersionsOf(
  problemIds: string[],
  executor: Executor,
): Promise<Map<string, string>> {
  if (problemIds.length === 0) return new Map();
  const rows = await executor.select({
    id: problems.id,
    latest: problems.latest_version_id,
  }).from(problems).where(inArray(problems.id, problemIds));
  const out = new Map<string, string>();
  for (const row of rows) {
    if (row.latest) out.set(row.id, row.latest);
  }
  return out;
}

/** 校验指定版本存在且属于对应题目。 */
async function assertSpecifiedVersionsUsable(
  versions: Record<string, string>,
  executor: Executor,
): Promise<void> {
  const problemIds = Object.keys(versions);
  if (problemIds.length === 0) return;
  const rows = await executor.select({
    problem_id: problemVersions.problem_id,
    id: problemVersions.id,
  }).from(problemVersions).where(
    inArray(problemVersions.problem_id, problemIds),
  );
  const available = new Set(rows.map((row) => `${row.problem_id}:${row.id}`));
  const missing = problemIds.filter((problemId) =>
    !available.has(`${problemId}:${versions[problemId]}`)
  );
  if (missing.length > 0) throw missingTargetVersion(missing);
}

/** 依据目标模式把解析后的提交集合变成条目计划。 */
async function planItems(
  members: Array<{
    kind: JobSourceKind;
    id: string;
    problem_id: string;
    submitted_version_id: string | null;
  }>,
  target: RejudgeTarget,
  executor: Executor,
): Promise<PlannedItem[]> {
  const problemIds = [...new Set(members.map((member) => member.problem_id))];

  if (target.mode === "specified") {
    // 逐题映射必须覆盖所有涉及的题目，任一缺失整次受理失败
    const missing = problemIds.filter((problemId) =>
      !target.versions[problemId]
    );
    if (missing.length > 0) throw missingTargetVersion(missing);
    await assertSpecifiedVersionsUsable(target.versions, executor);
  }
  const latest = target.mode === "latest"
    ? await latestVersionsOf(problemIds, executor)
    : new Map<string, string>();
  if (target.mode === "latest") {
    const missing = problemIds.filter((problemId) => !latest.has(problemId));
    if (missing.length > 0) throw missingTargetVersion(missing);
  }

  return members.map((member) => {
    if (target.mode === "submitted") {
      if (!member.submitted_version_id) {
        return {
          source_kind: member.kind,
          source_id: member.id,
          problem_id: member.problem_id,
          target_version_id: null,
          target_version_ref: null,
          skipped_reason: {
            code: "LEGACY_VERSION_UNKNOWN",
            message: "提交时版本未知（存量历史提交），无法按提交时版本重测",
          },
        };
      }
      return {
        source_kind: member.kind,
        source_id: member.id,
        problem_id: member.problem_id,
        target_version_id: member.submitted_version_id,
        target_version_ref: member.submitted_version_id,
      };
    }
    const versionId = target.mode === "latest"
      ? latest.get(member.problem_id) as string
      : target.versions[member.problem_id];
    return {
      source_kind: member.kind,
      source_id: member.id,
      problem_id: member.problem_id,
      target_version_id: versionId,
      target_version_ref: versionId,
    };
  });
}

/**
 * 受理管理员重测任务。
 *
 * @param actorId 操作者（幂等键与 actor 绑定）
 * @param idempotencyKey 客户端幂等键（必填）
 */
export async function acceptRejudgeJob(
  actorId: string,
  request: RejudgeRequest,
  idempotencyKey: string,
): Promise<AcceptJobResult> {
  if (!idempotencyKey || idempotencyKey.length > 128) {
    throw new AppError(
      "必须提供 Idempotency-Key（≤128 字符）",
      400,
      "IDEMPOTENCY_KEY_REQUIRED",
    );
  }
  const db = getDb();
  const normalized = normalizeRejudgeRequest(request);
  const requestHash = await hashRequest(normalized);

  // 幂等：先查同键任务
  const [existingJob] = await db.select().from(submissionJobs).where(
    and(
      eq(submissionJobs.actor_id, actorId),
      eq(submissionJobs.kind, "rejudge"),
      eq(submissionJobs.idempotency_key, idempotencyKey),
    ),
  ).limit(1);
  if (existingJob) {
    if (existingJob.request_hash !== requestHash) throw idempotencyConflict();
    return {
      job_id: existingJob.id,
      status: existingJob.status,
      total_items: await countItems(existingJob.id, db),
      existing: true,
    };
  }

  // 全部校验在写入前完成（"整场统一 V3，某题没有 V3 → 受理失败，不产生任务"）
  const members = await resolveScopeItems(normalized.scope, db);
  const planned = await planItems(members, normalized.target, db);
  validatePolicyChanges(
    normalized.policy_changes ?? [],
    new Set(planned.map((item) => item.problem_id)),
  );

  // 应用策略变更（每项自带事务与乐观锁；校验已全部通过）
  for (const change of normalized.policy_changes ?? []) {
    if (change.contest_id) {
      await setContestProblemEffectiveVersionPolicy(
        change.contest_id,
        change.problem_id,
        {
          policy: change.policy,
          expectedRevision: change.expected_revision,
          actorId,
        },
      );
    } else {
      await setProblemEffectiveVersionPolicy(change.problem_id, {
        policy: change.policy,
        expectedRevision: change.expected_revision,
        actorId,
      });
    }
  }

  const now = new Date().toISOString();
  const jobId = crypto.randomUUID();
  const jobStatus = planned.length === 0 ? "completed" : "queued";
  try {
    await db.transaction(async (tx) => {
      await tx.insert(submissionJobs).values({
        id: jobId,
        kind: "rejudge",
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
          planned.map((
            item,
            index,
          ): typeof submissionJobItems.$inferInsert => ({
            id: crypto.randomUUID(),
            job_id: jobId,
            ordinal: index,
            source_kind: item.source_kind,
            source_id: item.source_id,
            problem_id: item.problem_id,
            target_version_id: item.target_version_id,
            target_version_ref: item.target_version_ref,
            status: item.skipped_reason ? "skipped" : "pending",
            reason_code: item.skipped_reason?.code ?? null,
            reason_message: item.skipped_reason?.message ?? null,
            created_at: now,
            finished_at: item.skipped_reason ? now : null,
          })),
        );
      }
    });
  } catch (error) {
    // 幂等键竞态：并发受理同键 → 返回先写入的那个任务
    const [raced] = await db.select().from(submissionJobs).where(
      and(
        eq(submissionJobs.actor_id, actorId),
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
    job_id: jobId,
    status: jobStatus,
    total_items: planned.length,
    existing: false,
  };
}

/** 请求规范化哈希（相同请求必须得到相同哈希）。 */
export async function hashRequest(request: RejudgeRequest): Promise<string> {
  const payload = canonicalJson({
    kind: request.kind,
    scope: request.scope,
    target: request.target,
    policy_changes: (request.policy_changes ?? []).map((change) => ({
      problem_id: change.problem_id,
      contest_id: change.contest_id ?? null,
      expected_revision: change.expected_revision,
      policy: change.policy,
    })),
  });
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(payload),
  );
  return Array.from(
    new Uint8Array(digest),
    (b) => b.toString(16).padStart(2, "0"),
  ).join("");
}

/**
 * 校验策略变更：作用域必须落在任务包含的题目/竞赛内，且 revision 匹配。
 *
 * 只做校验与读取，不写库。
 */
function validatePolicyChanges(
  changes: readonly PolicyChangeRequest[],
  jobProblemIds: ReadonlySet<string>,
): void {
  for (const change of changes) {
    if (!jobProblemIds.has(change.problem_id)) {
      throw new AppError(
        `策略变更作用于任务范围之外的题目：${change.problem_id}`,
        400,
        "POLICY_CHANGE_OUT_OF_SCOPE",
      );
    }
    if (!Number.isInteger(change.expected_revision)) {
      throw new AppError(
        "策略变更必须给出预期 revision",
        400,
        "POLICY_CHANGE_REVISION_REQUIRED",
      );
    }
    if (change.policy.mode === "exact" && !change.policy.version_id) {
      throw new AppError("exact 策略必须给出要求版本", 400, "INVALID_POLICY");
    }
    // revision 校验交给策略服务（同一事务语义），这里只做基础形态检查
  }
}

/** 统计任务条目数。 */
async function countItems(jobId: string, executor: Executor): Promise<number> {
  const [row] = await executor.select({
    count: sql<number>`count(*)::int`,
  }).from(submissionJobItems).where(eq(submissionJobItems.job_id, jobId));
  return row?.count ?? 0;
}

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

/**
 * 依据条目状态推导并写入任务终态（§5.7「job 状态与统计由持久化条目推导」）。
 *
 * 全部条目进入终态（succeeded/failed/skipped）后：有 failed → `completed_with_errors`，
 * 否则 `completed`。
 */
export async function refreshJobStatus(
  jobId: string,
  executor?: Executor,
): Promise<string> {
  const db = executor ?? getDb();
  const counts = await countItemsByStatus(jobId, db);
  const pending = (counts.pending ?? 0) + (counts.preparing ?? 0) +
    (counts.dispatched ?? 0);
  if (pending > 0) {
    const status = (counts.dispatched ?? 0) > 0 ? "running" : "queued";
    await db.update(submissionJobs).set({ status }).where(
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

/**
 * 重试任务：只包含 `failed` / `skipped` 条目，生成**关联新任务**，
 * 保留目标版本映射，**不再次修改有效策略**。
 */
export async function retryRejudgeJob(
  actorId: string,
  jobId: string,
  idempotencyKey: string,
): Promise<AcceptJobResult> {
  const db = getDb();
  const [job] = await db.select().from(submissionJobs).where(
    eq(submissionJobs.id, jobId),
  ).limit(1);
  if (!job) {
    throw new AppError("任务不存在", 404, "JOB_NOT_FOUND");
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
  const requestHash = await hashRequest({
    ...request,
    policy_changes: [],
  });
  const existing = await db.select().from(submissionJobs).where(
    and(
      eq(submissionJobs.actor_id, actorId),
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
  await db.transaction(async (tx) => {
    await tx.insert(submissionJobs).values({
      id: newJobId,
      kind: "rejudge",
      actor_id: actorId,
      idempotency_key: idempotencyKey,
      request_hash: requestHash,
      request: {
        ...request,
        retry_of: jobId,
        policy_changes: [],
      } as unknown as Record<string, unknown>,
      status: "queued",
      created_at: now,
    });
    await tx.insert(submissionJobItems).values(
      retryable.map((item, index): typeof submissionJobItems.$inferInsert => ({
        id: crypto.randomUUID(),
        job_id: newJobId,
        ordinal: index,
        source_kind: item.source_kind,
        source_id: item.source_id,
        problem_id: item.problem_id,
        target_version_id: item.target_version_id,
        target_version_ref: item.target_version_ref,
        status: "pending",
        created_at: now,
      })),
    );
  });

  return {
    job_id: newJobId,
    status: "queued",
    total_items: retryable.length,
    existing: false,
  };
}
