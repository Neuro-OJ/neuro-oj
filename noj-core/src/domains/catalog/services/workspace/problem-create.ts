import { count, eq, sql } from "drizzle-orm";
import {
  AppError,
  BadRequestError,
  ConflictError,
} from "../../../../shared/base/errors.ts";
import type { Executor } from "../../../../shared/db/executor.ts";
import {
  domainProblemBindings,
  domainResourceCounters,
  domains,
  problemBindingHistory,
  problems,
} from "../../../../shared/db/schema.ts";
import {
  assertWorkspacePermission,
  getDomainEffectiveLimits,
  loadWorkspace,
  lockActiveWorkspaceAccount,
  workspaceAudit,
} from "../../../workspace/index.ts";

/** 创建事务锁住使用域，检查题库容量并原子分配编号；绑定写入后才提交。 */
export async function prepareDomainProblemCreation(
  slug: string,
  actorId: string,
  requestedNumber: number | undefined,
  executor: Executor,
) {
  await lockActiveWorkspaceAccount(executor, actorId);
  const { domain, context } = await loadWorkspace(slug, actorId, {
    executor,
    write: true,
    lock: true,
  });
  assertWorkspacePermission(context, "problem:create");
  const { effective: limits } = await getDomainEffectiveLimits(
    domain.id,
    executor,
  );
  const [usage] = await executor.select({ count: count() }).from(
    domainProblemBindings,
  )
    .where(eq(domainProblemBindings.domain_id, domain.id));
  if (limits.problems !== null && usage.count >= limits.problems) {
    throw new AppError("域题库条目额度已用尽", 429, "DOMAIN_PROBLEM_LIMIT");
  }
  if (
    requestedNumber !== undefined &&
    (!Number.isInteger(requestedNumber) || requestedNumber < 1 ||
      requestedNumber >= 2147483647)
  ) {
    throw new BadRequestError(
      "题号必须是有效正整数",
      "INVALID_PROBLEM_REFERENCE",
    );
  }
  if (requestedNumber !== undefined) {
    const [existing] = await executor.select({ id: problems.id }).from(problems)
      .where(
        sql`${problems.domain_id} = ${domain.id} AND ${problems.number} = ${requestedNumber}`,
      );
    if (existing) {
      throw new ConflictError(
        "本域题号已存在",
        "DOMAIN_PROBLEM_NUMBER_CONFLICT",
      );
    }
  }
  const [allocated] = await executor.update(domains).set({
    next_problem_number: requestedNumber === undefined
      ? sql`${domains.next_problem_number} + 1`
      : sql`GREATEST(${domains.next_problem_number}, ${requestedNumber} + 1)`,
  }).where(eq(domains.id, domain.id)).returning({
    next: domains.next_problem_number,
  });
  return {
    domain,
    number: requestedNumber ?? allocated.next - 1,
    used: usage.count,
  };
}

/** 源题、初始草稿、本域绑定、策略依据和额度计数共用创建事务。 */
export async function bindCreatedDomainProblem(
  problem: typeof problems.$inferSelect,
  domainId: string,
  actorId: string,
  previousUsage: number,
  executor: Executor,
) {
  const [binding] = await executor.insert(domainProblemBindings).values({
    id: crypto.randomUUID(),
    domain_id: domainId,
    problem_id: problem.id,
    kind: "owned",
    visibility: problem.visibility === "public" ? "public" : "members",
    created_by: actorId,
    created_at: problem.created_at,
    updated_at: problem.updated_at,
  }).returning();
  await executor.insert(problemBindingHistory).values({
    id: crypto.randomUUID(),
    binding_id: binding.id,
    problem_id: problem.id,
    revision: binding.revision,
    effective_version_mode: "any",
    actor_id: actorId,
    reason: "创建本域题目",
    created_at: problem.created_at,
  });
  await executor.insert(domainResourceCounters).values({
    domain_id: domainId,
    resource: "problems",
    used: previousUsage + 1,
  }).onConflictDoUpdate({
    target: [domainResourceCounters.domain_id, domainResourceCounters.resource],
    set: { used: previousUsage + 1 },
  });
  await workspaceAudit(executor, actorId, domainId, "domain.update", {
    operation: "problem.create",
    problem_id: problem.id,
    number: problem.number,
    binding_id: binding.id,
  });
}
