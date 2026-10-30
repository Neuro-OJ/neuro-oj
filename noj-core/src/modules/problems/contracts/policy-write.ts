/**
 * problems 对「题库绑定策略」的窄事务写能力。
 *
 * `problems`、`domain_problem_bindings` 与 `problem_binding_history` 由 problems
 * 持有。评测模块只负责判定与有效成绩计算，**不能直接改有效版本策略**；策略宿主
 * （题目行）与策略行的锁定、revision 比较、版本归属校验以及变更依据都在本文件内
 * 完成，application 负责把本文件与 evaluations 的重算放进同一外层事务。
 *
 * 所有函数：
 * - 第一个参数是真实 `DbTx`，不自开根事务、不读默认连接；
 * - 只写 problems 拥有的表；
 * - 授权（成员资格、角色）由 access 在调用前解析，本文件只接受已确认的 actor id。
 */
import { and, eq } from "drizzle-orm";
import { BadRequestError, ConflictError } from "../../../shared/base/errors.ts";
import type { DbTx } from "../../../shared/db/executor.ts";
import {
  domainProblemBindings,
  problemBindingHistory,
  problems,
  problemVersions,
} from "../../../shared/db/schema.ts";
import {
  type EffectiveVersionPolicy,
  policyToColumns,
} from "../../../shared/versioning/types.ts";

/** 绑定策略修改结果（供 application 交给 evaluations 重算投影）。 */
export interface ProblemEffectivePolicyChange {
  readonly binding_id: string;
  readonly problem_id: string;
  readonly domain_id: string;
  readonly revision: number;
  readonly policy: EffectiveVersionPolicy;
}

/** 锁内读到的绑定行快照。 */
interface BindingRow {
  readonly id: string;
  readonly domain_id: string;
  readonly problem_id: string;
  readonly revision: number;
}

/**
 * 锁定题目行（策略宿主），返回所属域；不存在返回 null。
 *
 * 锁序固定为「题目 → 绑定」：与结果写入、批量受理入口一致，避免成环。
 */
export async function lockProblemPolicyHostTx(
  tx: DbTx,
  problemId: string,
): Promise<{ domainId: string | null } | null> {
  const [row] = await tx.select({ domain_id: problems.domain_id }).from(
    problems,
  ).where(eq(problems.id, problemId)).for("update");
  return row ? { domainId: row.domain_id } : null;
}

/** 校验 `exact` 策略引用的版本属于该题且已发布。 */
export async function assertProblemVersionPublishedTx(
  tx: DbTx,
  problemId: string,
  versionId: string,
): Promise<void> {
  const [version] = await tx.select({ id: problemVersions.id }).from(
    problemVersions,
  ).where(
    and(
      eq(problemVersions.id, versionId),
      eq(problemVersions.problem_id, problemId),
    ),
  );
  if (!version) throw new BadRequestError("要求版本不属于此题或未发布");
}

/** 锁定并读取某域对某题的 owned 绑定；不存在返回 null。 */
export async function lockOwnedProblemBindingTx(
  tx: DbTx,
  domainId: string,
  problemId: string,
): Promise<BindingRow | null> {
  const [row] = await tx.select({
    id: domainProblemBindings.id,
    domain_id: domainProblemBindings.domain_id,
    problem_id: domainProblemBindings.problem_id,
    revision: domainProblemBindings.revision,
  }).from(domainProblemBindings).where(
    and(
      eq(domainProblemBindings.domain_id, domainId),
      eq(domainProblemBindings.problem_id, problemId),
      eq(domainProblemBindings.kind, "owned"),
    ),
  ).for("update");
  return row ?? null;
}

/** 绑定策略写入的核心实现；调用方必须已持有题目与绑定行锁。 */
async function applyBindingPolicyTx(
  tx: DbTx,
  binding: BindingRow,
  input: {
    expectedRevision: number;
    policy: EffectiveVersionPolicy;
    actorId: string;
    reason: string;
  },
): Promise<ProblemEffectivePolicyChange> {
  if (binding.revision !== input.expectedRevision) {
    throw new ConflictError(
      "题库配置已变化，请重新读取",
      "EFFECTIVE_POLICY_REVISION_CONFLICT",
    );
  }
  const required = input.policy.mode === "exact"
    ? input.policy.version_id
    : null;
  if (required) {
    await assertProblemVersionPublishedTx(tx, binding.problem_id, required);
  }
  const columns = policyToColumns(input.policy);
  const nextRevision = binding.revision + 1;
  const now = new Date().toISOString();
  const [updated] = await tx.update(domainProblemBindings).set({
    revision: nextRevision,
    updated_at: now,
  }).where(eq(domainProblemBindings.id, binding.id)).returning({
    id: domainProblemBindings.id,
    revision: domainProblemBindings.revision,
  });
  await tx.update(problems).set({
    effective_version_mode: columns.effective_version_mode,
    required_version_id: columns.required_version_id,
    effective_policy_revision: nextRevision,
    updated_at: now,
  }).where(eq(problems.id, binding.problem_id));
  // 变更依据与策略同事务落库：删除题目时由 problems 自己清理这张表。
  await tx.insert(problemBindingHistory).values({
    id: crypto.randomUUID(),
    binding_id: updated.id,
    problem_id: binding.problem_id,
    revision: updated.revision,
    effective_version_mode: columns.effective_version_mode,
    required_version_id: columns.required_version_id,
    // 作答版本由解析器按策略选择；exact 时等于要求版本，any 时为空。
    answer_version_id: columns.required_version_id,
    disabled_at: null,
    actor_id: input.actorId,
    reason: input.reason,
    created_at: now,
  });
  return {
    binding_id: updated.id,
    problem_id: binding.problem_id,
    domain_id: binding.domain_id,
    revision: updated.revision,
    policy: input.policy,
  };
}

/**
 * 在调用方事务内切换某域对某题的有效版本策略。
 *
 * 步骤固定为：锁题目 → 锁 owned 绑定 → 校验 revision → 校验 exact 版本归属 →
 * 写策略列并递增 revision → 追加变更依据。
 *
 * @throws {ConflictError} 409 `EFFECTIVE_POLICY_REVISION_CONFLICT`
 * @throws {BadRequestError} 400 exact 版本不属于该题或未发布
 */
export async function setProblemEffectivePolicyTx(
  tx: DbTx,
  input: {
    domainId: string;
    problemId: string;
    expectedRevision: number;
    policy: EffectiveVersionPolicy;
    actorId: string;
    reason: string;
  },
): Promise<ProblemEffectivePolicyChange> {
  await lockProblemPolicyHostTx(tx, input.problemId);
  const binding = await lockOwnedProblemBindingTx(
    tx,
    input.domainId,
    input.problemId,
  );
  if (!binding) throw new BadRequestError("该题目不属于此工作空间");
  return await applyBindingPolicyTx(tx, binding, input);
}

/** 按绑定 ID 切换策略；调用方已持有题目锁时使用。 */
export async function setProblemBindingPolicyTx(
  tx: DbTx,
  input: {
    bindingId: string;
    problemId: string;
    expectedRevision: number;
    policy: EffectiveVersionPolicy;
    actorId: string;
    reason: string;
  },
): Promise<ProblemEffectivePolicyChange> {
  const [binding] = await tx.select({
    id: domainProblemBindings.id,
    domain_id: domainProblemBindings.domain_id,
    problem_id: domainProblemBindings.problem_id,
    revision: domainProblemBindings.revision,
  }).from(domainProblemBindings).where(
    eq(domainProblemBindings.id, input.bindingId),
  ).for("update");
  if (!binding) throw new BadRequestError("题库绑定不存在");
  if (binding.problem_id !== input.problemId) {
    throw new BadRequestError("题库绑定与题目不匹配");
  }
  return await applyBindingPolicyTx(tx, binding, input);
}
