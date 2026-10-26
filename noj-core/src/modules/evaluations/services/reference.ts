/**
 * 题目删除/保留所需的评测只读引用合同。
 *
 * problems 只需要知道评测是否仍引用题目，不应导入 submission/evaluation 的
 * 写服务。这个查询不做删除，也不改变提交或成绩事实。
 */
import { and, eq, or } from "drizzle-orm";
import { getDb } from "../../../shared/db/connection.ts";
import type { DbRoot } from "../../../shared/db/executor.ts";
import {
  evaluationAttempts,
  objectiveSubmissions,
  submissions,
} from "../../../shared/db/schema.ts";
import type {
  EvaluationReference,
  EvaluationSource,
} from "../contracts/read.ts";

type ReadExecutor = Pick<DbRoot, "select">;

/** 返回题目下仍存在的提交/客观题提交及其在途状态。 */
export async function listEvaluationReferences(
  problemId: string,
  executor: ReadExecutor = getDb(),
): Promise<EvaluationReference[]> {
  const [submissionRows, objectiveRows] = await Promise.all([
    executor.select({
      id: submissions.id,
      contestId: submissions.contest_id,
      activeAttemptId: submissions.active_attempt_id,
    }).from(submissions).where(eq(submissions.problem_id, problemId)),
    executor.select({
      id: objectiveSubmissions.id,
      contestId: objectiveSubmissions.contest_id,
      activeAttemptId: objectiveSubmissions.active_attempt_id,
    }).from(objectiveSubmissions).where(
      eq(objectiveSubmissions.paper_id, problemId),
    ),
  ]);

  const attempts = await executor.select({
    id: evaluationAttempts.id,
    submissionId: evaluationAttempts.submission_id,
    objectiveSubmissionId: evaluationAttempts.objective_submission_id,
    state: evaluationAttempts.state,
  }).from(evaluationAttempts).where(or(
    eq(evaluationAttempts.problem_id, problemId),
    and(
      eq(evaluationAttempts.problem_id, problemId),
      eq(evaluationAttempts.state, "judging"),
    ),
  ));
  const attemptBySource = new Map<string, typeof attempts>();
  for (const attempt of attempts) {
    const key = attempt.submissionId ?? attempt.objectiveSubmissionId;
    if (!key) continue;
    const existing = attemptBySource.get(key) ?? [];
    existing.push(attempt);
    attemptBySource.set(key, existing);
  }

  return [
    ...submissionRows.map((row): EvaluationReference => {
      const source: EvaluationSource = {
        kind: "submission",
        id: row.id,
        problemId,
        contestId: row.contestId,
      };
      const sourceAttempts = attemptBySource.get(row.id) ?? [];
      return {
        source,
        hasActiveAttempt: Boolean(row.activeAttemptId),
        hasHistory: sourceAttempts.length > 0,
      };
    }),
    ...objectiveRows.map((row): EvaluationReference => {
      const source: EvaluationSource = {
        kind: "objective",
        id: row.id,
        problemId,
        contestId: row.contestId,
      };
      const sourceAttempts = attemptBySource.get(row.id) ?? [];
      return {
        source,
        hasActiveAttempt: Boolean(row.activeAttemptId),
        hasHistory: sourceAttempts.length > 0,
      };
    }),
  ];
}

/** 删除题目时使用的窄 guard；保留历史提交意味着默认拒绝物理删除。 */
export async function hasEvaluationReferences(
  problemId: string,
  executor: ReadExecutor = getDb(),
): Promise<boolean> {
  const refs = await listEvaluationReferences(problemId, executor);
  return refs.length > 0;
}
