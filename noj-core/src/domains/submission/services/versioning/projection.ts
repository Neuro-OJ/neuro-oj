/**
 * 有效成绩投影写入服务（Handbook §3.1、§3.2、§3.5）。
 *
 * 这里是**唯一**允许计算并写入提交有效字段的地方：
 * - `recomputeSubmissionProjection`：单条提交的题库与竞赛双口径投影；
 * - `recomputeProblemProjections`：某题全部提交（策略切换后重算）；
 * - `recomputeContestProblemProjections`：某竞赛某题全部提交（竞赛策略切换后重算）。
 *
 * 纯计算由 `shared/versioning/effective-results.ts` 完成；本服务只负责
 * 「读候选 → 取策略 → 算 → 写」，并在业务事务内递增 `query_projection_revisions`
 * 的 `data_revision`（缓存键的一部分，保证策略提交后立即可读到新口径）。
 *
 * 锁顺序（Handbook §5.1）：调用方应在持有题目行锁的前提下调用本服务；
 * 本服务只写提交行与投影 revision 行。
 */

import { and, eq, inArray, sql } from "drizzle-orm";
import type { Executor } from "../../../../shared/db/executor.ts";
import {
  contestProblems,
  evaluationAttempts,
  objectiveSubmissions,
  problems,
  queryProjectionRevisions,
  submissions,
  submissionVersionResults,
} from "../../../../shared/db/schema.ts";
import {
  type CurrentVersionResult,
  type EffectiveSelection,
  type EffectiveVersionPolicy,
  EMPTY_EFFECTIVE_SELECTION,
} from "../../../../shared/versioning/types.ts";
import { policyFromColumns } from "../../../../shared/versioning/types.ts";
import {
  mergeSubmissionProjection,
  selectEffectiveResults,
} from "../../../../shared/versioning/effective-results.ts";

/** 投影来源：两类正式提交之一。 */
export type ProjectionSourceKind = "submission" | "objective";

/** 投影来源。 */
export interface ProjectionSource {
  kind: ProjectionSourceKind;
  id: string;
  problem_id: string;
  /** 竞赛提交时非空；练习提交为 null。 */
  contest_id: string | null;
}

/** 单条提交的完整投影计算结果（未写入）。 */
export interface SubmissionProjectionPlan {
  source: ProjectionSource;
  global: EffectiveSelection;
  contest: EffectiveSelection;
  /** 写回提交行的策略 revision（题库）。 */
  global_policy_revision: number;
  /** 写回提交行的策略 revision（竞赛×题目）；无竞赛上下文为 null。 */
  contest_policy_revision: number | null;
}

/** 投影作用域键（缓存与物化视图用）。 */
export function globalScopeKey(): string {
  return "global";
}

/** 题目作用域键。 */
export function problemScopeKey(problemId: string): string {
  return `problem:${problemId}`;
}

/** 竞赛作用域键。 */
export function contestScopeKey(contestId: string): string {
  return `contest:${contestId}`;
}

/**
 * 递增投影数据 revision（幂等创建行）。
 *
 * 必须在业务事务内调用：判定替换与策略切换都要让缓存键失效，
 * 而"策略立即生效"不允许依赖 TTL 或异步刷新。
 */
export async function bumpProjectionRevision(
  executor: Executor,
  scopeKey: string,
): Promise<number> {
  const rows = await executor.insert(queryProjectionRevisions).values({
    scope_key: scopeKey,
    data_revision: 1,
    materialized_revision: 0,
  }).onConflictDoUpdate({
    target: queryProjectionRevisions.scope_key,
    set: {
      data_revision: sql`${queryProjectionRevisions.data_revision} + 1`,
    },
  }).returning({ data_revision: queryProjectionRevisions.data_revision });
  return rows[0]?.data_revision ?? 1;
}

/** 读取当前题库策略（缺行/非法形态按 `any` 兜底）。 */
async function loadProblemPolicy(
  db: Executor,
  problemId: string,
): Promise<{ policy: EffectiveVersionPolicy; revision: number }> {
  const [row] = await db.select({
    mode: problems.effective_version_mode,
    required: problems.required_version_id,
    revision: problems.effective_policy_revision,
  }).from(problems).where(eq(problems.id, problemId)).limit(1);
  return {
    policy: policyFromColumns(row?.mode, row?.required) ?? { mode: "any" },
    revision: row?.revision ?? 0,
  };
}

/** 读取「竞赛×题目」策略；关联不存在时返回 null（该题不在竞赛中）。 */
async function loadContestPolicy(
  db: Executor,
  contestId: string,
  problemId: string,
): Promise<{ policy: EffectiveVersionPolicy; revision: number } | null> {
  const [row] = await db.select({
    mode: contestProblems.effective_version_mode,
    required: contestProblems.required_version_id,
    revision: contestProblems.effective_policy_revision,
  }).from(contestProblems).where(
    and(
      eq(contestProblems.contest_id, contestId),
      eq(contestProblems.problem_id, problemId),
    ),
  ).limit(1);
  if (!row) return null;
  return {
    policy: policyFromColumns(row.mode, row.required) ?? { mode: "any" },
    revision: row.revision,
  };
}

/**
 * 读取某提交的全部当前正式判定（`submission_version_results` 指向的尝试）。
 *
 * 候选自带 `result_kind` / `state`，纯计算器会忽略非 graded 或非终态的行——
 * 这是纵深防御：写入服务本就不该把平台错误写进这张表。
 */
export async function loadCurrentVersionResults(
  db: Executor,
  source: ProjectionSource,
): Promise<CurrentVersionResult[]> {
  const sourceColumn = source.kind === "submission"
    ? submissionVersionResults.submission_id
    : submissionVersionResults.objective_submission_id;
  const rows = await db.select({
    attempt_id: submissionVersionResults.current_attempt_id,
    problem_version_id: submissionVersionResults.problem_version_id,
    score: evaluationAttempts.score,
    accepted: evaluationAttempts.accepted,
    sequence: evaluationAttempts.sequence,
    result_kind: evaluationAttempts.result_kind,
    state: evaluationAttempts.state,
  }).from(submissionVersionResults)
    .innerJoin(
      evaluationAttempts,
      eq(evaluationAttempts.id, submissionVersionResults.current_attempt_id),
    )
    .where(eq(sourceColumn, source.id));
  return rows.map((row) => ({
    attempt_id: row.attempt_id,
    problem_version_id: row.problem_version_id,
    score: row.score ?? 0,
    accepted: row.accepted,
    sequence: row.sequence,
    result_kind: row.result_kind,
    state: row.state,
  }));
}

/** 读取提交的竞赛上下文（两类提交各自的 contest_id）。 */
export async function loadSubmissionContestId(
  db: Executor,
  source: ProjectionSource,
): Promise<string | null> {
  if (source.kind === "submission") {
    const [row] = await db.select({ contest_id: submissions.contest_id })
      .from(submissions).where(eq(submissions.id, source.id)).limit(1);
    return row?.contest_id ?? null;
  }
  const [row] = await db.select({ contest_id: objectiveSubmissions.contest_id })
    .from(objectiveSubmissions).where(
      eq(objectiveSubmissions.id, source.id),
    ).limit(1);
  return row?.contest_id ?? null;
}

/**
 * 计算单条提交的双口径投影（不写入）。
 *
 * 题库与竞赛分别执行同一套选择算法（Handbook §3.2），因此两个口径的
 * 有效/通过指针可以完全不同。
 */
export async function computeSubmissionProjection(
  db: Executor,
  source: ProjectionSource,
): Promise<SubmissionProjectionPlan> {
  const problemPolicy = await loadProblemPolicy(db, source.problem_id);
  const results = await loadCurrentVersionResults(db, source);
  const global = selectEffectiveResults(results, problemPolicy.policy);

  let contest: EffectiveSelection = { ...EMPTY_EFFECTIVE_SELECTION };
  let contestRevision: number | null = null;
  if (source.contest_id) {
    const contestPolicy = await loadContestPolicy(
      db,
      source.contest_id,
      source.problem_id,
    );
    if (contestPolicy) {
      contest = selectEffectiveResults(results, contestPolicy.policy);
      contestRevision = contestPolicy.revision;
    }
  }

  return {
    source,
    global,
    contest,
    global_policy_revision: problemPolicy.revision,
    contest_policy_revision: contestRevision,
  };
}

/** 把投影计划写入对应的提交行。 */
async function writeProjection(
  db: Executor,
  plan: SubmissionProjectionPlan,
): Promise<void> {
  const merged = mergeSubmissionProjection(plan.global, plan.contest);
  const values = {
    ...merged,
    global_policy_revision: plan.global_policy_revision,
    contest_policy_revision: plan.contest_policy_revision,
  };
  if (plan.source.kind === "submission") {
    await db.update(submissions).set(values).where(
      eq(submissions.id, plan.source.id),
    );
  } else {
    await db.update(objectiveSubmissions).set(values).where(
      eq(objectiveSubmissions.id, plan.source.id),
    );
  }
}

/**
 * 重算并写入单条提交的题库与竞赛投影（唯一写入入口）。
 *
 * 同时递增 `problem:<id>` 与（竞赛提交时）`contest:<id>` 的 data_revision，
 * 让缓存与物化视图立刻知道口径变了。
 */
export async function recomputeSubmissionProjection(
  executor: Executor,
  source: ProjectionSource,
): Promise<SubmissionProjectionPlan> {
  const plan = await computeSubmissionProjection(executor, source);
  await writeProjection(executor, plan);
  await bumpProjectionRevision(executor, problemScopeKey(source.problem_id));
  if (source.contest_id) {
    await bumpProjectionRevision(executor, contestScopeKey(source.contest_id));
  }
  return plan;
}

/** 列出某题下的全部提交来源（分页游标由调用方控制批量）。 */
export async function listProblemProjectionSources(
  db: Executor,
  problemId: string,
): Promise<ProjectionSource[]> {
  const plainRows = await db.select({
    id: submissions.id,
    problem_id: submissions.problem_id,
    contest_id: submissions.contest_id,
  }).from(submissions).where(eq(submissions.problem_id, problemId));
  const objectiveRows = await db.select({
    id: objectiveSubmissions.id,
    problem_id: objectiveSubmissions.paper_id,
    contest_id: objectiveSubmissions.contest_id,
  }).from(objectiveSubmissions).where(
    eq(objectiveSubmissions.paper_id, problemId),
  );
  return [
    ...plainRows.map((row) => ({
      kind: "submission" as const,
      id: row.id,
      problem_id: row.problem_id,
      contest_id: row.contest_id,
    })),
    ...objectiveRows.map((row) => ({
      kind: "objective" as const,
      id: row.id,
      problem_id: row.problem_id,
      contest_id: row.contest_id,
    })),
  ];
}

/**
 * 重算某题全部提交的投影（题库策略切换后调用）。
 *
 * 必须在持题目行锁的事务内执行（Handbook §5.1「策略重算必须与结果写入互斥」），
 * 否则并发的结果写入可能用旧策略覆盖新投影。
 *
 * @returns 被重算的提交数量
 */
export async function recomputeProblemProjections(
  executor: Executor,
  problemId: string,
): Promise<number> {
  const sources = await listProblemProjectionSources(executor, problemId);
  for (const source of sources) {
    const plan = await computeSubmissionProjection(executor, source);
    await writeProjection(executor, plan);
  }
  await bumpProjectionRevision(executor, problemScopeKey(problemId));
  return sources.length;
}

/**
 * 重算某竞赛某题全部提交的竞赛口径投影。
 *
 * 与题库口径独立：题库策略变化不会调用本函数，反之亦然。
 *
 * @returns 被重算的提交数量
 */
export async function recomputeContestProblemProjections(
  executor: Executor,
  contestId: string,
  problemId: string,
): Promise<number> {
  const plainRows = await listContestProblemSources(
    executor,
    "submission",
    contestId,
    problemId,
  );
  const objectiveRows = await listContestProblemSources(
    executor,
    "objective",
    contestId,
    problemId,
  );
  for (
    const source of [...plainRows, ...objectiveRows]
  ) {
    const plan = await computeSubmissionProjection(executor, source);
    await writeProjection(executor, plan);
  }
  await bumpProjectionRevision(executor, contestScopeKey(contestId));
  return plainRows.length + objectiveRows.length;
}

/** 读取某竞赛某题下的提交来源（两类提交统一）。 */
async function listContestProblemSources(
  db: Executor,
  kind: ProjectionSourceKind,
  contestId: string,
  problemId: string,
): Promise<ProjectionSource[]> {
  if (kind === "submission") {
    const rows = await db.select({
      id: submissions.id,
      problem_id: submissions.problem_id,
      contest_id: submissions.contest_id,
    }).from(submissions).where(
      and(
        eq(submissions.contest_id, contestId),
        eq(submissions.problem_id, problemId),
      ),
    );
    return rows.map((row) => ({
      kind: "submission" as const,
      id: row.id,
      problem_id: row.problem_id,
      contest_id: row.contest_id,
    }));
  }
  const rows = await db.select({
    id: objectiveSubmissions.id,
    problem_id: objectiveSubmissions.paper_id,
    contest_id: objectiveSubmissions.contest_id,
  }).from(objectiveSubmissions).where(
    and(
      eq(objectiveSubmissions.contest_id, contestId),
      eq(objectiveSubmissions.paper_id, problemId),
    ),
  );
  return rows.map((row) => ({
    kind: "objective" as const,
    id: row.id,
    problem_id: row.problem_id,
    contest_id: row.contest_id,
  }));
}

/**
 * 写入/替换某提交在某版本上的当前正式判定（Handbook §2.9）。
 *
 * **只有 graded 终态尝试**可以调用；调用方负责校验尝试属于该提交、题目与版本
 * （唯一写入服务检查，见 §2.8）。未知版本桶（`problem_version_id = null`）仅用于
 * 迁移历史。
 */
export async function upsertCurrentVersionResult(
  executor: Executor,
  input: {
    source: ProjectionSource;
    problemVersionId: string | null;
    attemptId: string;
    updatedAt?: string;
  },
): Promise<void> {
  const now = input.updatedAt ?? new Date().toISOString();
  const rows = await executor.select().from(submissionVersionResults).where(
    and(
      input.source.kind === "submission"
        ? eq(submissionVersionResults.submission_id, input.source.id)
        : eq(submissionVersionResults.objective_submission_id, input.source.id),
      input.problemVersionId == null
        ? sql`${submissionVersionResults.problem_version_id} IS NULL`
        : eq(
          submissionVersionResults.problem_version_id,
          input.problemVersionId,
        ),
    ),
  ).limit(1);

  if (rows[0]) {
    await executor.update(submissionVersionResults).set({
      current_attempt_id: input.attemptId,
      updated_at: now,
    }).where(eq(submissionVersionResults.id, rows[0].id));
    return;
  }

  await executor.insert(submissionVersionResults).values({
    id: crypto.randomUUID(),
    submission_id: input.source.kind === "submission" ? input.source.id : null,
    objective_submission_id: input.source.kind === "objective"
      ? input.source.id
      : null,
    problem_id: input.source.problem_id,
    problem_version_id: input.problemVersionId,
    current_attempt_id: input.attemptId,
    updated_at: now,
  });
}

/** 删除某提交的当前判定（整题删除等清理路径使用）。 */
export async function deleteVersionResultsForSource(
  executor: Executor,
  source: ProjectionSource,
): Promise<void> {
  await executor.delete(submissionVersionResults).where(
    source.kind === "submission"
      ? eq(submissionVersionResults.submission_id, source.id)
      : eq(submissionVersionResults.objective_submission_id, source.id),
  );
}

/** 批量读取多条提交的当前判定（读路径与批量重算共用）。 */
export async function loadCurrentVersionResultsForSources(
  db: Executor,
  sources: readonly ProjectionSource[],
): Promise<Map<string, CurrentVersionResult[]>> {
  const out = new Map<string, CurrentVersionResult[]>();
  if (sources.length === 0) return out;
  const plainIds = sources.filter((s) => s.kind === "submission").map((s) =>
    s.id
  );
  const objectiveIds = sources.filter((s) => s.kind === "objective").map((s) =>
    s.id
  );
  const fetch = async (ids: string[], kind: ProjectionSourceKind) => {
    if (ids.length === 0) return;
    const rows = await db.select({
      source_id: kind === "submission"
        ? submissionVersionResults.submission_id
        : submissionVersionResults.objective_submission_id,
      attempt_id: submissionVersionResults.current_attempt_id,
      problem_version_id: submissionVersionResults.problem_version_id,
      score: evaluationAttempts.score,
      accepted: evaluationAttempts.accepted,
      sequence: evaluationAttempts.sequence,
      result_kind: evaluationAttempts.result_kind,
      state: evaluationAttempts.state,
    }).from(submissionVersionResults)
      .innerJoin(
        evaluationAttempts,
        eq(evaluationAttempts.id, submissionVersionResults.current_attempt_id),
      )
      .where(
        inArray(
          kind === "submission"
            ? submissionVersionResults.submission_id
            : submissionVersionResults.objective_submission_id,
          ids,
        ),
      );
    for (const row of rows) {
      const key = `${kind}:${row.source_id}`;
      const list = out.get(key) ?? [];
      list.push({
        attempt_id: row.attempt_id,
        problem_version_id: row.problem_version_id,
        score: row.score ?? 0,
        accepted: row.accepted,
        sequence: row.sequence,
        result_kind: row.result_kind,
        state: row.state,
      });
      out.set(key, list);
    }
  };
  await fetch(plainIds, "submission");
  await fetch(objectiveIds, "objective");
  return out;
}
