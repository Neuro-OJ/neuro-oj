/**
 * 出题人按题覆盖及格线（`problem_difficulty.pass_ratio_override`）。
 *
 * 与题目挂载共用编辑权限口径（`assertProblemEditPermissionForActor`）；
 * 写审计 `knowledge.difficulty.pass_ratio`。清空（null）表示回到实例默认
 * `knowledge_pass_ratio`。覆盖值保存在 `problem_difficulty` 行上，难度重算
 * 不会清除它。
 */
import { eq } from "drizzle-orm";
import type { UserActor } from "../../modules/access/contracts/actor.ts";
import { recordAudit } from "../../modules/platform/index.ts";
import type { AuditDetail } from "../../modules/platform/index.ts";
import { NotFoundError, ValidationError } from "../../shared/base/errors.ts";
import { getDb } from "../../shared/db/connection.ts";
import { problemDifficulty, problems } from "../../shared/db/schema.ts";
import { assertProblemEditPermissionForActor } from "../../modules/problems/index.ts";
import { tierToPrior } from "./difficulty.ts";

/**
 * 设置/清除题目及格线覆盖。
 *
 * @param value 0–100 整数或 null（清除）
 * @throws {ValidationError} 取值非法
 * @throws {ForbiddenError} 无编辑权限
 */
export async function setPassRatioOverride(
  actor: UserActor,
  problemId: string,
  value: unknown,
  meta: { ipAddress: string; requestId?: string },
): Promise<number | null> {
  let ratio: number | null;
  if (value === null) {
    ratio = null;
  } else if (
    typeof value === "number" && Number.isInteger(value) && value >= 0 &&
    value <= 100
  ) {
    ratio = value;
  } else {
    throw new ValidationError("pass_ratio_override 必须是 0–100 的整数或 null");
  }
  const [problem] = await getDb().select({
    id: problems.id,
    difficulty: problems.difficulty,
    domain_id: problems.domain_id,
    owner_id: problems.owner_id,
  }).from(problems).where(eq(problems.id, problemId));
  if (!problem) throw new NotFoundError("题目不存在");
  await assertProblemEditPermissionForActor(problem, actor);
  const now = new Date().toISOString();
  const prior = tierToPrior(problem.difficulty);
  await getDb().insert(problemDifficulty).values({
    problem_id: problemId,
    prior,
    calibrated: prior,
    sample_size: 0,
    pass_ratio_override: ratio,
    updated_at: now,
  }).onConflictDoUpdate({
    target: problemDifficulty.problem_id,
    set: { pass_ratio_override: ratio, updated_at: now },
  });
  await recordAudit(
    actor,
    meta,
    "knowledge.difficulty.pass_ratio",
    {
      action: "knowledge.difficulty.pass_ratio",
      pass_ratio_override: ratio,
    } as unknown as AuditDetail,
    { type: "problem", id: problemId },
  );
  return ratio;
}
