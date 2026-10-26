/**
 * evaluations 原子写入合同。
 *
 * 这里的函数只接受真实 Drizzle transaction callback 句柄。应用层负责开启
 * DbRoot.transaction；本层不根据 optional executor 猜测事务所有权，也不从
 * Hono Context/ALS 获取操作者。
 */
import type {
  SystemActor,
  UserActor,
} from "../../../access/contracts/actor.ts";
import type { DbTx } from "../../../../shared/db/executor.ts";
import {
  type ApplyAttemptOutcome,
  type ApplyAttemptResultInput,
  applyAttemptResultTx as applyAttemptResultTxInternal,
} from "./result-write.ts";
import {
  bumpProjectionRevision,
  bumpSubmissionCountRevisions,
  computeSubmissionProjection,
  deleteVersionResultsForSource,
  lockProjectionHosts,
  lockProjectionSource,
  type ProjectionSource,
  recomputeContestProblemProjections,
  recomputeProblemBindingProjections,
  recomputeProblemProjections,
  recomputeSubmissionProjection,
  type SubmissionProjectionPlan,
  upsertCurrentVersionResult,
} from "./projection.ts";
import {
  type AttemptRecord,
  createAttempt,
  type CreateAttemptInput,
  finishAttempt,
  type FinishAttemptInput,
  getAttempt,
  markAttemptStarted,
  registerAttemptTerminalRevocation,
  supersedeAttempt,
} from "./attempts.ts";

export type EvaluationWriteActor = UserActor | SystemActor;

/** 在受理事务内锁定提交宿主。 */
export function lockEvaluationHostsTx(
  tx: DbTx,
  source: ProjectionSource,
): Promise<void> {
  return lockProjectionHosts(tx, source);
}

/** 递增有效成绩/统计投影 revision；必须与业务写入同一事务。 */
export function bumpEvaluationRevisionTx(
  tx: DbTx,
  scopeKey: string,
): Promise<number> {
  return bumpProjectionRevision(tx, scopeKey);
}

export function bumpSubmissionCountRevisionsTx(
  tx: DbTx,
  scope: { problem_id: string; contest_id?: string | null },
): Promise<void> {
  return bumpSubmissionCountRevisions(tx, scope);
}

/** 创建尝试并绑定 active_attempt_id；操作者显式传入以保留审计边界。 */
export function createEvaluationAttemptTx(
  tx: DbTx,
  actor: EvaluationWriteActor,
  input: Omit<CreateAttemptInput, "executor" | "createdBy"> & {
    createdBy?: string | null;
  },
): Promise<AttemptRecord> {
  const createdBy = actor.kind === "user"
    ? actor.userId
    : input.createdBy ?? null;
  return createAttempt({ ...input, createdBy, executor: tx });
}

export function getEvaluationAttemptTx(
  tx: DbTx,
  attemptId: string,
): Promise<AttemptRecord | null> {
  return getAttempt(attemptId, tx);
}

export function markEvaluationAttemptStartedTx(
  tx: DbTx,
  _actor: EvaluationWriteActor,
  attemptId: string,
): Promise<void> {
  return markAttemptStarted(attemptId, tx);
}

export function finishEvaluationAttemptTx(
  tx: DbTx,
  _actor: EvaluationWriteActor,
  input: FinishAttemptInput,
): Promise<boolean> {
  return finishAttempt(input, tx);
}

export function supersedeEvaluationAttemptTx(
  tx: DbTx,
  _actor: EvaluationWriteActor,
  attemptId: string,
): Promise<boolean> {
  return supersedeAttempt(attemptId, tx);
}

export function registerAttemptTerminalRevocationTx(
  tx: DbTx,
  _actor: EvaluationWriteActor,
  input: Parameters<typeof registerAttemptTerminalRevocation>[1],
): Promise<void> {
  return registerAttemptTerminalRevocation(tx, input);
}

/** 结果 + 正式判定指针 + 有效成绩投影的唯一原子入口。 */
export function applyAttemptResultTx(
  tx: DbTx,
  actor: EvaluationWriteActor,
  input: ApplyAttemptResultInput,
): Promise<ApplyAttemptOutcome> {
  // actor 是显式的事务边界合同；结果本身来自 Judge/后台时由 runtime 传入
  // SystemActor(background_task)，HTTP 重放则传入已认证 UserActor。
  return applyAttemptResultTxInternal(tx, actor, input);
}

export function recomputeSubmissionProjectionTx(
  tx: DbTx,
  _actor: EvaluationWriteActor,
  source: ProjectionSource,
): Promise<SubmissionProjectionPlan> {
  return recomputeSubmissionProjection(tx, source);
}

export function recomputeProblemProjectionsTx(
  tx: DbTx,
  _actor: EvaluationWriteActor,
  problemId: string,
  bindingId?: string,
): Promise<number> {
  return recomputeProblemProjections(tx, problemId, bindingId);
}

export function recomputeProblemBindingProjectionsTx(
  tx: DbTx,
  _actor: EvaluationWriteActor,
  binding: { id: string; problem_id: string; domain_id: string },
): Promise<number> {
  return recomputeProblemBindingProjections(tx, binding);
}

export function recomputeContestProblemProjectionsTx(
  tx: DbTx,
  _actor: EvaluationWriteActor,
  contestId: string,
  problemId: string,
): Promise<number> {
  return recomputeContestProblemProjections(tx, contestId, problemId);
}

export function computeSubmissionProjectionTx(
  tx: DbTx,
  source: ProjectionSource,
): Promise<SubmissionProjectionPlan> {
  return computeSubmissionProjection(tx, source);
}

export function lockProjectionSourceTx(
  tx: DbTx,
  source: ProjectionSource,
): Promise<void> {
  return lockProjectionSource(tx, source);
}

export function upsertCurrentVersionResultTx(
  tx: DbTx,
  input: Parameters<typeof upsertCurrentVersionResult>[1],
): Promise<void> {
  return upsertCurrentVersionResult(tx, input);
}

export function deleteVersionResultsForSourceTx(
  tx: DbTx,
  source: ProjectionSource,
): Promise<void> {
  return deleteVersionResultsForSource(tx, source);
}
