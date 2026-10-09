/**
 * 评测结果落库事务（Handbook §5.6）。
 *
 * 同一次事务内完成：
 * 1. 锁定并读取提交的当前活动尝试；
 * 2. 忽略已处理 / 过时 / 不匹配的结果（`finishAttempt` 的单次终态语义）；
 * 3. 写尝试终态；
 * 4. 若为 `graded`，更新对应版本的**当前正式判定指针**（§2.9）；
 * 5. 按当前题库与竞赛策略重算全部有效字段（§3.2，两个作用域独立）；
 * 6. 清空 `active_attempt_id`、更新最近尝试与运行状态。
 *
 * 平台错误（`platform_error`）**不替换已有正式判定**：只写尝试终态并把提交标记为
 * error，`submission_version_results` 与其他有效字段保持原样。
 */

import { and, eq } from "drizzle-orm";
import { getDb } from "../../../../shared/db/connection.ts";
import type { Executor } from "../../../../shared/db/executor.ts";
import {
  evaluationAttempts,
  objectiveSubmissions,
  submissionJobItems,
  submissions,
} from "../../../../shared/db/schema.ts";
import type { AttemptResultKind } from "../../../../shared/versioning/types.ts";
import {
  finishAttempt,
  getAttempt,
  isTerminalAttemptState,
} from "./attempts.ts";
import {
  type ProjectionSource,
  recomputeSubmissionProjection,
  type SubmissionProjectionPlan,
  upsertCurrentVersionResult,
} from "./projection.ts";
import { completeJobItem } from "./job-worker.ts";

/** 结果写入输入（可信封套字段，来自 JudgeResult）。 */
export interface ApplyAttemptResultInput {
  /** 尝试 ID（= 正式评测 run_id）。 */
  attemptId: string;
  resultKind: AttemptResultKind;
  resultStatus: string | null;
  /** ×100 整数分；平台错误时为 null。 */
  score: number | null;
  accepted: boolean;
  output?: string;
  details?: Record<string, unknown>;
  timeMs?: number | null;
  memoryKb?: number | null;
}

/** 结果写入结论。 */
export type ApplyAttemptOutcome =
  | { applied: "graded"; projection: SubmissionProjectionPlan }
  | { applied: "platform_error" }
  | { applied: "ignored"; reason: "not_found" | "already_terminal" | "stale" };

/**
 * 读取提交行并在事务内加锁（§5.1 锁顺序：先题目、再提交）。
 *
 * 同时取出 `contest_id`：竞赛口径的投影必须知道提交的竞赛上下文，
 * 否则结果写入后 `is_contest_*` 永远为空（竞赛固定版本策略形同失效）。
 */
async function lockSubmissionRow(
  source: ProjectionSource,
  executor: Executor,
): Promise<
  | {
    active_attempt_id: string | null;
    status: string;
    contest_id: string | null;
  }
  | null
> {
  if (source.kind === "submission") {
    const [row] = await executor.select({
      active_attempt_id: submissions.active_attempt_id,
      status: submissions.status,
      contest_id: submissions.contest_id,
    }).from(submissions).where(eq(submissions.id, source.id)).for("update");
    return row ?? null;
  }
  const [row] = await executor.select({
    active_attempt_id: objectiveSubmissions.active_attempt_id,
    status: objectiveSubmissions.status,
    contest_id: objectiveSubmissions.contest_id,
  }).from(objectiveSubmissions).where(
    eq(objectiveSubmissions.id, source.id),
  ).for("update");
  return row ?? null;
}

/** 写提交的"最近尝试 / 运行状态"字段（清空在途尝试）。 */
async function updateSubmissionRuntimeState(
  source: ProjectionSource,
  patch: {
    latest_attempt_id: string;
    status: "finished" | "error";
    judge_finished_at?: string;
  },
  executor: Executor,
): Promise<void> {
  if (source.kind === "submission") {
    await executor.update(submissions).set({
      latest_attempt_id: patch.latest_attempt_id,
      active_attempt_id: null,
      status: patch.status,
      judge_finished_at: patch.judge_finished_at ?? null,
    }).where(eq(submissions.id, source.id));
  } else {
    await executor.update(objectiveSubmissions).set({
      latest_attempt_id: patch.latest_attempt_id,
      active_attempt_id: null,
    }).where(eq(objectiveSubmissions.id, source.id));
  }
}

/**
 * 在调用方事务内应用一次评测结果。
 *
 * 调用方必须已经开启事务（本函数不自行开启，以便与任务条目更新、SSE 事件同批提交）。
 */
export async function applyAttemptResult(
  input: ApplyAttemptResultInput,
  executor?: Executor,
): Promise<ApplyAttemptOutcome> {
  const db = executor ?? getDb();
  const attempt = await getAttempt(input.attemptId, db);
  if (!attempt) return { applied: "ignored", reason: "not_found" };
  // 先锁提交行再取竞赛上下文：`contest_id` 是竞赛口径投影的必要输入，
  // 且必须在同一事务的同一行锁内读到，避免与竞赛固定版本切换发生竞态。
  const locked = await lockSubmissionRow(
    {
      kind: attempt.submission_id ? "submission" : "objective",
      id: (attempt.submission_id ?? attempt.objective_submission_id) as string,
      problem_id: attempt.problem_id,
      contest_id: null,
    },
    db,
  );
  if (!locked) return { applied: "ignored", reason: "not_found" };
  const source: ProjectionSource = {
    kind: attempt.submission_id ? "submission" : "objective",
    id: (attempt.submission_id ?? attempt.objective_submission_id) as string,
    problem_id: attempt.problem_id,
    contest_id: locked.contest_id,
  };

  // 过时结果：提交的活动尝试已经换成别的尝试
  if (
    locked.active_attempt_id && locked.active_attempt_id !== input.attemptId
  ) {
    return { applied: "ignored", reason: "stale" };
  }
  if (isTerminalAttemptState(attempt.state)) {
    return { applied: "ignored", reason: "already_terminal" };
  }

  const applied = await finishAttempt({
    attemptId: input.attemptId,
    resultKind: input.resultKind,
    resultStatus: input.resultStatus,
    score: input.score,
    accepted: input.accepted,
    output: input.output,
    details: input.details,
    timeMs: input.timeMs,
    memoryKb: input.memoryKb,
  }, db);
  if (!applied) return { applied: "ignored", reason: "already_terminal" };

  if (input.resultKind === "platform_error") {
    // 平台错误不替换正式判定：只记终态与运行状态
    await updateSubmissionRuntimeState(source, {
      latest_attempt_id: input.attemptId,
      status: "error",
      judge_finished_at: new Date().toISOString(),
    }, db);
    // 批任务条目：平台错误属于条目 failed（WA/零分才是成功完成）
    await completeAttemptJobItem(input.attemptId, "failed", db);
    return { applied: "platform_error" };
  }

  // graded：更新"该版本当前正式判定"，再按当前策略重算双口径投影
  await upsertCurrentVersionResult(db, {
    source,
    problemVersionId: attempt.problem_version_id,
    attemptId: input.attemptId,
  });
  const projection = await recomputeSubmissionProjection(db, source);
  await updateSubmissionRuntimeState(source, {
    latest_attempt_id: input.attemptId,
    status: "finished",
    judge_finished_at: new Date().toISOString(),
  }, db);
  // 批任务条目：正式判定（含 WA、零分）即条目成功完成
  await completeAttemptJobItem(input.attemptId, "succeeded", db);
  return { applied: "graded", projection };
}

/**
 * 结果回写时完成对应的批任务条目（§5.6 第 8 步）。
 *
 * - 正式判定（含 WA/零分）→ 条目 `succeeded`；
 * - 平台错误 → 条目 `failed` + `PLATFORM_ERROR`；
 * - 条目已是终态时 `completeJobItem` 幂等跳过（重复消息不会重复计数）。
 */
async function completeAttemptJobItem(
  attemptId: string,
  status: "succeeded" | "failed",
  executor: Executor,
): Promise<void> {
  const [item] = await executor.select({ id: submissionJobItems.id })
    .from(submissionJobItems).where(
      eq(submissionJobItems.attempt_id, attemptId),
    ).limit(1);
  if (!item) return;
  await completeJobItem(item.id, {
    status,
    attemptId,
    reasonCode: status === "failed" ? "PLATFORM_ERROR" : null,
    reasonMessage: status === "failed" ? "评测平台错误，未产生正式判定" : null,
  }, executor);
}

/** 供测试与读路径使用的尝试列表（按 sequence 升序）。 */
export async function listAttempts(
  source: ProjectionSource,
  executor?: Executor,
): Promise<typeof evaluationAttempts.$inferSelect[]> {
  const db = executor ?? getDb();
  const column = source.kind === "submission"
    ? evaluationAttempts.submission_id
    : evaluationAttempts.objective_submission_id;
  const rows = await db.select().from(evaluationAttempts).where(
    and(eq(column, source.id)),
  );
  return rows.sort((a, b) => a.sequence - b.sequence);
}
