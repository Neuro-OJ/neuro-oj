import { eq } from "drizzle-orm";
import { AppError } from "../../../../shared/base/errors.ts";
import type { Executor } from "../../../../shared/db/executor.ts";
import {
  domainProblemBindings,
  objectiveSubmissions,
  problems,
  problemShareSettings,
  problemVersions,
  submissions,
} from "../../../../shared/db/schema.ts";

/** 持有源题锁并完成删除授权后调用；历史及绑定存在时禁止级联物理清除。 */
export async function assertProblemHasNoRetainedReferences(
  problemId: string,
  executor: Executor,
) {
  const [version] = await executor.select({ id: problemVersions.id }).from(
    problemVersions,
  ).where(eq(problemVersions.problem_id, problemId)).limit(1);
  const [binding] = await executor.select({ id: domainProblemBindings.id })
    .from(domainProblemBindings).where(
      eq(domainProblemBindings.problem_id, problemId),
    ).limit(1);
  const [submission] = await executor.select({ id: submissions.id }).from(
    submissions,
  ).where(eq(submissions.problem_id, problemId)).limit(1);
  const [objective] = await executor.select({ id: objectiveSubmissions.id })
    .from(objectiveSubmissions).where(
      eq(objectiveSubmissions.paper_id, problemId),
    ).limit(1);
  const [sharing] = await executor.select({
    id: problemShareSettings.problem_id,
  }).from(problemShareSettings).where(
    eq(problemShareSettings.problem_id, problemId),
  ).limit(1);
  if (version || binding || submission || objective || sharing) {
    throw new AppError(
      "题目已有版本、题库引用或提交记录，不能物理删除；请保留历史并停用资源",
      409,
      "SOURCE_HAS_RETAINED_REFERENCES",
    );
  }
  const [identity] = await executor.select({ id: problems.id }).from(problems)
    .where(eq(problems.id, problemId));
  if (!identity) throw new AppError("题目已不存在", 404, "PROBLEM_NOT_FOUND");
}
