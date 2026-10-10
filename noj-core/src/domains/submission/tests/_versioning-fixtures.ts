/** 旧服务测试的正式评测夹具：显式建立活动尝试，再构造协议 v2 封套。 */
import { eq } from "drizzle-orm";
import { getDb } from "../../../shared/db/connection.ts";
import {
  evaluationAttempts,
  selfTests,
  submissions,
} from "../../../shared/db/schema.ts";
import { publishBaselineVersionForTest } from "../../../../tests/helper.ts";
import { saveEvaluationResult } from "../services/submissions/submissions-result.ts";
import type { JudgeResult } from "../types/index.ts";

/** 模拟生产事务中创建尝试并绑定提交的动作；不用于历史未知版本或负向协议用例。 */
export async function seedActiveAttemptForTest(
  input: typeof evaluationAttempts.$inferInsert,
): Promise<void> {
  const versionId = input.problem_version_id ??
    await publishBaselineVersionForTest(input.problem_id);
  await getDb().transaction(async (tx) => {
    await tx.insert(evaluationAttempts).values({
      ...input,
      problem_version_id: versionId,
    });
    await tx.update(submissions).set({
      active_attempt_id: input.id,
      judge_run_id: input.id,
      rejudge_seq: input.sequence,
    }).where(eq(submissions.id, input.submission_id!));
  });
}

/** 仅读取已建立的绑定，绝不通过结果构造器修改数据库状态。 */
export async function v2ResultForTest(
  result: JudgeResult,
): Promise<JudgeResult> {
  if (result.submission_id.startsWith("st_")) {
    const [row] = await getDb().select().from(selfTests).where(
      eq(selfTests.id, result.submission_id),
    );
    return {
      ...result,
      evaluation_protocol_version: 2,
      run_id: row?.judge_run_id ?? "missing-run",
      problem_version_id: row?.problem_version_id ?? "missing-version",
      rejudge_seq: result.rejudge_seq ?? 0,
      result_kind: result.result_kind ??
        (result.status === "SystemError" || result.status === "error"
          ? "platform_error"
          : "graded"),
    };
  }
  const [row] = await getDb().select().from(submissions).where(
    eq(submissions.id, result.submission_id),
  );
  const attemptId = result.attempt_id ?? result.run_id ??
    row?.active_attempt_id;
  const [attempt] = attemptId
    ? await getDb().select().from(evaluationAttempts).where(
      eq(evaluationAttempts.id, attemptId),
    )
    : [];
  return {
    ...result,
    evaluation_protocol_version: 2,
    attempt_id: attemptId ?? "missing-attempt",
    run_id: attemptId ?? "missing-attempt",
    problem_version_id: attempt?.problem_version_id ?? "missing-version",
    rejudge_seq: result.rejudge_seq ?? attempt?.sequence ?? 0,
    result_kind: result.result_kind ??
      (result.status === "SystemError" || result.status === "error"
        ? "platform_error"
        : "graded"),
  };
}

/** 将本用例给出的判定放入其已经建立的协议 v2 绑定。 */
export async function saveV2ResultForTest(result: JudgeResult) {
  return await saveEvaluationResult(await v2ResultForTest(result));
}
