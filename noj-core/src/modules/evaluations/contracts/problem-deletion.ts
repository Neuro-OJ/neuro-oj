/**
 * 题目删除时 evaluations 拥有的评测事实清理合同。
 *
 * `submissions`、`objective_submissions`、`self_tests`、`evaluation_attempts`
 * 及其关联评测行归 evaluations 所有。problems 若要删除题目，必须经 application
 * 在同一外层事务里调用本文件的两个函数：
 *
 * 1. `assertProblemEvaluationDeletionAllowedTx`：锁内确认没有禁止删除的在途评测；
 * 2. `deleteProblemEvaluationRowsTx`：按保留规则清理属于该题目的评测行。
 *
 * 两个函数都只接收真实 `DbTx`、只写 evaluations 拥有的表，不自开事务，
 * 也不回退到默认根连接。
 */
import { and, eq, inArray, sql } from "drizzle-orm";
import { AppError } from "../../../shared/base/errors.ts";
import type { DbTx } from "../../../shared/db/executor.ts";
import {
  evaluationAttempts,
  objectiveSubmissions,
  selfTests,
  submissions,
} from "../../../shared/db/schema.ts";

/** 清理一个题目时涉及的评测行统计，供审计与测试断言。 */
export interface DeletedProblemEvaluationRows {
  /** 被清理的代码提交数（含已结束的）。 */
  submissions: number;
  /** 被清理的客观题提交数。 */
  objective_submissions: number;
  /** 被清理的自测数。 */
  self_tests: number;
  /** 被清理的评测尝试数。 */
  evaluation_attempts: number;
}

/**
 * 锁内确认题目可以被删除。
 *
 * 只要还存在"在途评测"就拒绝：代码提交仍在判题或已有活跃尝试、客观题提交存在
 * 活跃尝试、自测仍在 pending/judging。检查必须在题目行与相关域行都锁定之后调用，
 * 否则并发创建的新提交会绕过判据。
 *
 * @throws {AppError} 409 `SOURCE_JUDGING`：存在正在执行的评测。
 */
export async function assertProblemEvaluationDeletionAllowedTx(
  tx: DbTx,
  problemId: string,
): Promise<void> {
  const [activeSubmission] = await tx.select({ id: submissions.id }).from(
    submissions,
  ).where(and(
    eq(submissions.problem_id, problemId),
    sql`(${submissions.active_attempt_id} IS NOT NULL OR ${submissions.status} IN ('pending', 'judging'))`,
  )).limit(1);
  const [activeObjective] = await tx.select({ id: objectiveSubmissions.id })
    .from(objectiveSubmissions).where(and(
      eq(objectiveSubmissions.paper_id, problemId),
      sql`${objectiveSubmissions.active_attempt_id} IS NOT NULL`,
    )).limit(1);
  const [activeSelfTest] = await tx.select({ id: selfTests.id }).from(selfTests)
    .where(and(
      eq(selfTests.problem_id, problemId),
      sql`${selfTests.status} IN ('pending', 'judging')`,
    )).limit(1);
  if (activeSubmission || activeObjective || activeSelfTest) {
    throw new AppError(
      "题目存在正在执行的评测，不能删除",
      409,
      "SOURCE_JUDGING",
    );
  }
}

/**
 * 删除题目所属的评测行。
 *
 * 保留规则与历史实现一致：题目删除即物理清理该题的全部提交、客观题提交、
 * 自测与评测尝试。顺序自内向外（结果 → 尝试 → 提交 → 自测），避免触发外键。
 * 调用方必须已经通过 `assertProblemEvaluationDeletionAllowedTx`。
 */
export async function deleteProblemEvaluationRowsTx(
  tx: DbTx,
  problemId: string,
): Promise<DeletedProblemEvaluationRows> {
  const submissionRows = await tx.select({ id: submissions.id }).from(
    submissions,
  ).where(eq(submissions.problem_id, problemId));
  const submissionIds = submissionRows.map((row) => row.id);
  const objectiveRows = await tx.select({ id: objectiveSubmissions.id }).from(
    objectiveSubmissions,
  ).where(eq(objectiveSubmissions.paper_id, problemId));
  const objectiveIds = objectiveRows.map((row) => row.id);

  // 评测尝试由题目、提交或客观题提交三个入口定位（同一题目也可能有历史来源）。
  const attemptRows = await tx.select({ id: evaluationAttempts.id }).from(
    evaluationAttempts,
  ).where(eq(evaluationAttempts.problem_id, problemId));
  const attemptIds = new Set(attemptRows.map((row) => row.id));
  if (submissionIds.length) {
    const bySubmission = await tx.select({ id: evaluationAttempts.id }).from(
      evaluationAttempts,
    ).where(inArray(evaluationAttempts.submission_id, submissionIds));
    for (const row of bySubmission) attemptIds.add(row.id);
  }
  if (objectiveIds.length) {
    const byObjective = await tx.select({ id: evaluationAttempts.id }).from(
      evaluationAttempts,
    ).where(inArray(evaluationAttempts.objective_submission_id, objectiveIds));
    for (const row of byObjective) attemptIds.add(row.id);
  }
  const attemptList = [...attemptIds];

  if (attemptList.length) {
    await tx.delete(evaluationAttempts).where(
      inArray(evaluationAttempts.id, attemptList),
    );
  }

  const selfTestRows = await tx.delete(selfTests).where(
    eq(selfTests.problem_id, problemId),
  ).returning({ id: selfTests.id });
  const deletedSubmissions = await tx.delete(submissions).where(
    eq(submissions.problem_id, problemId),
  ).returning({ id: submissions.id });
  const deletedObjective = await tx.delete(objectiveSubmissions).where(
    eq(objectiveSubmissions.paper_id, problemId),
  ).returning({ id: objectiveSubmissions.id });

  return {
    submissions: deletedSubmissions.length,
    objective_submissions: deletedObjective.length,
    self_tests: selfTestRows.length,
    evaluation_attempts: attemptList.length,
  };
}
