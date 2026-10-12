import { and, asc, count, eq, inArray } from "drizzle-orm";
import {
  AppError,
  BadRequestError,
  ConflictError,
  NotFoundError,
} from "../../../../shared/base/errors.ts";
import { getDb } from "../../../../shared/db/connection.ts";
import type { Executor } from "../../../../shared/db/executor.ts";
import {
  domainLimits,
  domainProblemBindings,
  domainResourceCounters,
  domains,
  problemBindingHistory,
  problems,
  problemVersions,
} from "../../../../shared/db/schema.ts";
import type { EffectiveVersionPolicy } from "../../../../shared/versioning/types.ts";
import {
  assertWorkspacePermission,
  loadWorkspace,
  workspaceAudit,
} from "../../../workspace/index.ts";
import {
  assertCurrentProblemShare,
  resolveDomainProblem,
} from "./problem-binding-access.ts";
import {
  domainProblemReference,
  parseDomainProblemReference,
} from "./problem-reference.ts";

/** 写入绑定变化依据，和配置共用事务，不依赖可丢失的通知。 */
async function recordBinding(
  binding: typeof domainProblemBindings.$inferSelect,
  answerVersionId: string | null,
  actorId: string,
  reason: string,
  executor: Executor,
) {
  await executor.insert(problemBindingHistory).values({
    id: crypto.randomUUID(),
    binding_id: binding.id,
    problem_id: binding.problem_id,
    revision: binding.revision,
    effective_version_mode: binding.effective_version_mode,
    required_version_id: binding.required_version_id,
    answer_version_id: answerVersionId,
    disabled_at: binding.disabled_at,
    actor_id: actorId,
    reason,
    created_at: new Date().toISOString(),
  });
  await workspaceAudit(executor, actorId, binding.domain_id, "domain.update", {
    operation: "problem.binding",
    binding_id: binding.id,
    problem_id: binding.problem_id,
    revision: binding.revision,
    reason,
  });
}

/** 显式引用公开源题；同域重复请求复用绑定且不重复扣容量。 */
export async function importDomainProblem(
  slug: string,
  sourceReference: string,
  actorId: string,
) {
  const parsed = parseDomainProblemReference(sourceReference);
  if (!parsed.sourceSlug || parsed.sourceSlug === slug) {
    throw new BadRequestError("引用题必须使用其他域的来源题号");
  }
  return await getDb().transaction(async (tx) => {
    // 多域写入按稳定 ID 加锁，避免两个域互相引用时形成相反锁顺序。
    await loadWorkspace(slug, actorId, { executor: tx, write: true });
    await tx.select({ id: domains.id }).from(domains).where(
      inArray(domains.slug, [slug, parsed.sourceSlug!]),
    ).orderBy(asc(domains.id)).for("update");
    const { domain, context } = await loadWorkspace(slug, actorId, {
      executor: tx,
      write: true,
    });
    assertWorkspacePermission(context, "problem:create");
    const [source] = await tx.select({ problem: problems, domain: domains })
      .from(problems).innerJoin(domains, eq(domains.id, problems.domain_id))
      .where(
        and(
          eq(domains.slug, parsed.sourceSlug!),
          eq(problems.number, parsed.number),
        ),
      ).for("share");
    if (!source) throw new NotFoundError("源题不存在或不可引用");
    await assertCurrentProblemShare(
      source.problem,
      source.domain,
      domain.id,
      tx,
    );
    const [existing] = await tx.select().from(domainProblemBindings).where(
      and(
        eq(domainProblemBindings.domain_id, domain.id),
        eq(domainProblemBindings.problem_id, source.problem.id),
      ),
    ).for("update");
    if (existing) {
      if (existing.kind !== "shared") {
        throw new AppError(
          "绑定来源不一致",
          503,
          "PROBLEM_BINDING_INCONSISTENT",
        );
      }
      if (!existing.disabled_at) {
        return {
          binding: existing,
          reference: domainProblemReference(
            { ...source.problem, domain_id: source.domain.id },
            source.domain.slug,
            domain.id,
          ),
        };
      }
      const [restored] = await tx.update(domainProblemBindings).set({
        disabled_at: null,
        revision: existing.revision + 1,
        updated_at: new Date().toISOString(),
      }).where(eq(domainProblemBindings.id, existing.id)).returning();
      await recordBinding(
        restored,
        restored.required_version_id ?? source.problem.latest_version_id,
        actorId,
        "恢复引用",
        tx,
      );
      return {
        binding: restored,
        reference: domainProblemReference(
          { ...source.problem, domain_id: source.domain.id },
          source.domain.slug,
          domain.id,
        ),
      };
    }
    const [limit] = await tx.select().from(domainLimits).where(
      eq(domainLimits.domain_id, domain.id),
    );
    const [usage] = await tx.select({ count: count() }).from(
      domainProblemBindings,
    ).where(eq(domainProblemBindings.domain_id, domain.id));
    if (
      limit?.problems !== null && limit?.problems !== undefined &&
      usage.count >= limit.problems
    ) throw new AppError("域题库条目额度已用尽", 429, "DOMAIN_PROBLEM_LIMIT");
    const [sourceBinding] = await tx.select().from(domainProblemBindings).where(
      and(
        eq(domainProblemBindings.domain_id, source.domain.id),
        eq(domainProblemBindings.problem_id, source.problem.id),
      ),
    );
    if (
      !sourceBinding || sourceBinding.kind !== "owned" ||
      sourceBinding.disabled_at
    ) throw new NotFoundError("源域题库配置不可用");
    const now = new Date().toISOString();
    const [binding] = await tx.insert(domainProblemBindings).values({
      id: crypto.randomUUID(),
      domain_id: domain.id,
      problem_id: source.problem.id,
      kind: "shared",
      visibility: "members",
      effective_version_mode: sourceBinding.effective_version_mode,
      required_version_id: sourceBinding.required_version_id,
      created_by: actorId,
      created_at: now,
      updated_at: now,
    }).returning();
    await tx.insert(domainResourceCounters).values({
      domain_id: domain.id,
      resource: "problems",
      used: usage.count + 1,
    }).onConflictDoUpdate({
      target: [
        domainResourceCounters.domain_id,
        domainResourceCounters.resource,
      ],
      set: { used: usage.count + 1 },
    });
    await recordBinding(
      binding,
      binding.required_version_id ?? source.problem.latest_version_id,
      actorId,
      "引用源题并复制初始策略",
      tx,
    );
    return {
      binding,
      reference: domainProblemReference(
        { ...source.problem, domain_id: source.domain.id },
        source.domain.slug,
        domain.id,
      ),
    };
  });
}

/** 题库策略独立修改；不更新其他域绑定或改写旧版本和提交。 */
export async function setDomainProblemBindingPolicy(
  slug: string,
  reference: string,
  actorId: string,
  expectedRevision: number | null,
  policy: EffectiveVersionPolicy,
  reason: string,
) {
  if (
    expectedRevision === null || !Number.isInteger(expectedRevision) ||
    expectedRevision < 0
  ) throw new AppError("需要题库配置 revision", 428, "REVISION_REQUIRED");
  if (
    !policy || !["any", "exact"].includes(policy.mode) ||
    policy.mode === "exact" && !policy.version_id
  ) throw new BadRequestError("有效版本策略非法");
  if (typeof reason !== "string" || !reason.trim() || reason.length > 2000) {
    throw new BadRequestError("请提供不超过 2000 字的修改理由");
  }
  return await getDb().transaction(async (tx) => {
    const workspace = await loadWorkspace(slug, actorId, {
      executor: tx,
      write: true,
      lock: true,
    });
    assertWorkspacePermission(workspace.context, "problem:policy");
    const resolved = await resolveDomainProblem(slug, reference, actorId, {
      executor: tx,
    });
    const [binding] = await tx.select().from(domainProblemBindings).where(
      eq(domainProblemBindings.id, resolved.binding.id),
    ).for("update");
    if (binding.revision !== expectedRevision) {
      throw new ConflictError("题库配置已变化，请重新读取");
    }
    const required = policy.mode === "exact" ? policy.version_id : null;
    if (required) {
      const [version] = await tx.select({ id: problemVersions.id }).from(
        problemVersions,
      ).where(
        and(
          eq(problemVersions.id, required),
          eq(problemVersions.problem_id, binding.problem_id),
        ),
      );
      if (!version) throw new BadRequestError("要求版本不属于此题或未发布");
    }
    const [updated] = await tx.update(domainProblemBindings).set({
      effective_version_mode: policy.mode,
      required_version_id: required,
      revision: binding.revision + 1,
      updated_at: new Date().toISOString(),
    }).where(eq(domainProblemBindings.id, binding.id)).returning();
    await recordBinding(
      updated,
      required ?? resolved.problem.latest_version_id,
      actorId,
      reason.trim(),
      tx,
    );
    return updated;
  });
}
