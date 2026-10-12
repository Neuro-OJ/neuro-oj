import { count, eq, isNull, sql } from "drizzle-orm";
import { AppError } from "../../../../shared/base/errors.ts";
import { getDb } from "../../../../shared/db/connection.ts";
import type { Executor } from "../../../../shared/db/executor.ts";
import {
  domainProblemBindings,
  domainResourceCounters,
  domains,
  problemBindingHistory,
  problems,
  trainings,
} from "../../../../shared/db/schema.ts";
import { DEFAULT_DOMAIN_ID } from "../../../../shared/workspace/types.ts";

/** 默认域已初始化后回填旧资源，幂等且不改写现有绑定策略或版本。 */
export async function backfillDefaultCatalog(
  executor?: Executor,
): Promise<
  {
    problems_assigned: number;
    trainings_assigned: number;
    bindings_created: number;
  }
> {
  if (!executor) {
    return await getDb().transaction((tx) => backfillDefaultCatalog(tx));
  }
  const [domain] = await executor.select().from(domains).where(
    eq(domains.id, DEFAULT_DOMAIN_ID),
  ).for("update");
  if (!domain) {
    throw new AppError(
      "请先初始化默认工作空间",
      503,
      "DEFAULT_DOMAIN_NOT_READY",
    );
  }
  const pending = await executor.select().from(problems).where(
    isNull(problems.domain_id),
  ).for("update");
  if (pending.some((problem) => problem.type === "U")) {
    throw new AppError(
      "发现尚未处理的旧 U 题，停止资源回填",
      409,
      "LEGACY_U_DATA_REQUIRES_REVIEW",
    );
  }
  await executor.update(problems).set({ domain_id: domain.id }).where(
    isNull(problems.domain_id),
  );
  const assignedTrainings = await executor.update(trainings).set({
    domain_id: domain.id,
  }).where(isNull(trainings.domain_id)).returning({ id: trainings.id });
  const sources = await executor.select().from(problems).where(
    eq(problems.domain_id, domain.id),
  );
  let bindingsCreated = 0;
  for (const source of sources) {
    const [binding] = await executor.insert(domainProblemBindings).values({
      id: crypto.randomUUID(),
      domain_id: domain.id,
      problem_id: source.id,
      kind: "owned",
      visibility: source.visibility === "public" ? "public" : "members",
      effective_version_mode: source.effective_version_mode as "any" | "exact",
      required_version_id: source.required_version_id,
      revision: source.effective_policy_revision,
      created_by: domain.owner_id,
      created_at: source.created_at,
      updated_at: source.updated_at,
    }).onConflictDoNothing({
      target: [
        domainProblemBindings.domain_id,
        domainProblemBindings.problem_id,
      ],
    }).returning();
    if (!binding) continue;
    bindingsCreated++;
    await executor.insert(problemBindingHistory).values({
      id: crypto.randomUUID(),
      binding_id: binding.id,
      problem_id: source.id,
      revision: binding.revision,
      effective_version_mode: binding.effective_version_mode,
      required_version_id: binding.required_version_id,
      answer_version_id: binding.required_version_id ??
        source.latest_version_id,
      actor_id: domain.owner_id,
      reason: "默认域存量策略回填",
      created_at: new Date().toISOString(),
    });
  }
  // MAX 只用于回填游标；后续分配必须锁住域行并原子递增。
  await executor.update(domains).set({
    next_problem_number:
      sql`GREATEST(${domains.next_problem_number}, COALESCE((SELECT MAX(number) FROM problems WHERE domain_id = ${domain.id}), 1000) + 1, 1001)`,
  }).where(eq(domains.id, domain.id));
  const [total] = await executor.select({ count: count() }).from(
    domainProblemBindings,
  ).where(eq(domainProblemBindings.domain_id, domain.id));
  await executor.insert(domainResourceCounters).values({
    domain_id: domain.id,
    resource: "problems",
    used: total.count,
  }).onConflictDoUpdate({
    target: [domainResourceCounters.domain_id, domainResourceCounters.resource],
    set: { used: total.count },
  });
  const [remaining] = await executor.select({ count: count() }).from(problems)
    .where(isNull(problems.domain_id));
  if (remaining.count) {
    throw new AppError(
      "源题归属回填不完整",
      500,
      "CATALOG_BACKFILL_INCOMPLETE",
    );
  }
  return {
    problems_assigned: pending.length,
    trainings_assigned: assignedTrainings.length,
    bindings_created: bindingsCreated,
  };
}
