import { and, asc, count, eq, ilike, inArray, or, sql } from "drizzle-orm";
import {
  domainProblemBindingAvailableWhere,
  loadBindingAvailability,
} from "./binding-availability.ts";
import { recordEducationEvent } from "../../../../shared/education-events.ts";
import {
  AppError,
  BadRequestError,
  ConflictError,
  NotFoundError,
} from "../../../../shared/base/errors.ts";
import { getDb } from "../../../../shared/db/connection.ts";
import type { Executor } from "../../../../shared/db/executor.ts";
import {
  domainProblemBindings,
  domainResourceCounters,
  domains,
  problemBindingHistory,
  problems,
  problemVersions,
} from "../../../../shared/db/schema.ts";
import type { EffectiveVersionPolicy } from "../../../../shared/versioning/types.ts";
import { recomputeProblemBindingProjections } from "../../../submission/index.ts";
import {
  assertWorkspacePermission,
  getDomainEffectiveLimits,
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
import { recordProblemEducationChange } from "./education-events.ts";

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
  if (binding.kind === "owned") {
    await recordProblemEducationChange(executor, binding.problem_id);
  } else {
    await recordEducationEvent(executor, {
      domain_id: binding.domain_id,
      problem_id: binding.problem_id,
      event_type: "problem.changed",
    });
  }
  await workspaceAudit(executor, actorId, binding.domain_id, "domain.update", {
    operation: "problem.binding",
    binding_id: binding.id,
    problem_id: binding.problem_id,
    revision: binding.revision,
    reason,
    visibility: binding.visibility,
    disabled_at: binding.disabled_at,
  });
}

/** 显式引用公开源题；同域重复请求复用绑定且不重复扣容量。 */
export async function importDomainProblem(
  slug: string,
  sourceReference: string,
  actorId: string,
  executor?: Executor,
) {
  const parsed = parseDomainProblemReference(sourceReference);
  if (!parsed.sourceSlug || parsed.sourceSlug === slug) {
    throw new BadRequestError("引用题必须使用其他域的来源题号");
  }
  const importProblem = async (tx: Executor) => {
    // 多域写入按稳定 ID 加锁，避免两个域互相引用时形成相反锁顺序。
    await loadWorkspace(slug, actorId, { executor: tx, write: true });
    await tx.select({ id: domains.id }).from(domains).where(
      inArray(domains.slug, [slug, parsed.sourceSlug!]),
    ).orderBy(asc(domains.id)).for("update");
    const { domain, context } = await loadWorkspace(slug, actorId, {
      executor: tx,
      write: true,
    });
    if (!context.domainPermissions.has("problem:import")) {
      assertWorkspacePermission(context, "problem:create");
    }
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
      // 重复引用不能让教学人员撤销管理员的下架决定。
      assertWorkspacePermission(context, "problem:policy");
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
    const { effective: limit } = await getDomainEffectiveLimits(domain.id, tx);
    const [usage] = await tx.select({ count: count() }).from(
      domainProblemBindings,
    ).where(eq(domainProblemBindings.domain_id, domain.id));
    if (
      limit.problems !== null &&
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
  };
  return executor
    ? await importProblem(executor)
    : await getDb().transaction(importProblem);
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
    // 与正式结果写入共用宿主锁，策略和投影在同一事务生效。
    await tx.select({ id: problems.id }).from(problems).where(
      eq(problems.id, resolved.problem.id),
    ).for("update");
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
    await recomputeProblemBindingProjections(tx, updated);
    return updated;
  });
}

/** 下架保留源题、不可变版本、绑定和提交；恢复共享引用时重新检查来源授权。 */
export async function setDomainProblemBindingState(
  slug: string,
  reference: string,
  actorId: string,
  expectedRevision: number | null,
  input: {
    disabled: boolean;
    visibility?: "public" | "members";
    reason: string;
  },
) {
  if (
    expectedRevision === null || !Number.isSafeInteger(expectedRevision) ||
    expectedRevision < 0
  ) {
    throw new AppError("需要题库配置 revision", 428, "REVISION_REQUIRED");
  }
  if (
    typeof input.disabled !== "boolean" ||
    input.visibility !== undefined &&
      !["public", "members"].includes(input.visibility) ||
    typeof input.reason !== "string" || !input.reason.trim() ||
    input.reason.length > 2000
  ) {
    throw new BadRequestError("需要有效的题库状态、展示范围和变更理由");
  }
  const parsed = parseDomainProblemReference(reference);
  return await getDb().transaction(async (tx) => {
    await loadWorkspace(slug, actorId, { executor: tx, write: true });
    await tx.select({ id: domains.id }).from(domains).where(
      inArray(domains.slug, [slug, parsed.sourceSlug ?? slug]),
    ).orderBy(asc(domains.id)).for("update");
    const workspace = await loadWorkspace(slug, actorId, {
      executor: tx,
      write: true,
      lock: true,
    });
    const [resource] = await tx.select({
      problem: problems,
      source: domains,
      binding: domainProblemBindings,
    })
      .from(domainProblemBindings).innerJoin(
        problems,
        eq(problems.id, domainProblemBindings.problem_id),
      )
      .innerJoin(domains, eq(domains.id, problems.domain_id)).where(and(
        eq(domainProblemBindings.domain_id, workspace.domain.id),
        eq(problems.number, parsed.number),
        parsed.sourceSlug
          ? eq(domains.slug, parsed.sourceSlug)
          : eq(problems.domain_id, workspace.domain.id),
      ));
    if (!resource) throw new NotFoundError("域题库中不存在此题");
    if (resource.binding.kind === "owned") {
      assertWorkspacePermission(
        workspace.context,
        workspace.context.domainPermissions.has("problem:write_any")
          ? "problem:write_any"
          : resource.problem.owner_id === actorId
          ? "problem:write_own"
          : "problem:write_any",
      );
    } else assertWorkspacePermission(workspace.context, "problem:policy");
    const [currentProblem] = await tx.select().from(problems).where(
      eq(problems.id, resource.problem.id),
    ).for("update");
    const [binding] = await tx.select().from(domainProblemBindings).where(
      eq(domainProblemBindings.id, resource.binding.id),
    ).for("update");
    if (binding.revision !== expectedRevision) {
      throw new ConflictError("题库配置已变化，请重新读取");
    }
    if (binding.kind === "shared" && !input.disabled) {
      await assertCurrentProblemShare(
        currentProblem,
        resource.source,
        workspace.domain.id,
        tx,
      );
    }
    const now = new Date().toISOString();
    const [updated] = await tx.update(domainProblemBindings).set({
      disabled_at: input.disabled ? binding.disabled_at ?? now : null,
      ...(input.visibility ? { visibility: input.visibility } : {}),
      revision: binding.revision + 1,
      updated_at: now,
    }).where(eq(domainProblemBindings.id, binding.id)).returning();
    if (binding.kind === "owned" && input.visibility) {
      await tx.update(problems).set({
        visibility: input.visibility === "public" ? "public" : "private",
        updated_at: now,
      }).where(eq(problems.id, resource.problem.id));
    }
    await recordBinding(
      updated,
      updated.required_version_id ?? currentProblem.latest_version_id,
      actorId,
      input.reason.trim(),
      tx,
    );
    return updated;
  });
}

/** 管理列表保留已下架/失效绑定；内容撤销后仅返回来源标识与本域配置。 */
export async function listDomainProblemBindings(
  slug: string,
  actorId: string,
  query: { page: number; limit: number; keyword?: string },
) {
  const workspace = await loadWorkspace(slug, actorId), db = getDb();
  const permissions = workspace.context.domainPermissions;
  if (
    !workspace.platformAdmin &&
    ![
      "problem:import",
      "problem:write_own",
      "problem:write_any",
      "problem:policy",
    ].some((permission) => permissions.has(permission))
  ) {
    assertWorkspacePermission(workspace.context, "problem:policy");
  }
  const manageAll = workspace.platformAdmin ||
    permissions.has("problem:write_any") || permissions.has("problem:policy");
  const available = domainProblemBindingAvailableWhere(
    domainProblemBindings.id,
    domainProblemBindings.domain_id,
    { member: true },
  );
  const condition = and(
    eq(domainProblemBindings.domain_id, workspace.domain.id),
    manageAll ? undefined : or(
      eq(domainProblemBindings.kind, "shared"),
      eq(problems.owner_id, actorId),
    ),
    query.keyword
      ? or(
        ilike(
          sql`${domains.slug} || ':' || ${problems.number}`,
          `%${query.keyword}%`,
        ),
        and(
          or(eq(domainProblemBindings.kind, "owned"), available),
          ilike(problems.title, `%${query.keyword}%`),
        ),
      )
      : undefined,
  );
  const queryRows = () =>
    db.select({
      binding: domainProblemBindings,
      source: { id: domains.id, slug: domains.slug },
      problem: {
        id: problems.id,
        domain_id: problems.domain_id,
        number: problems.number,
        owner_id: problems.owner_id,
        title: problems.title,
        latest_version_id: problems.latest_version_id,
      },
    }).from(domainProblemBindings).innerJoin(
      problems,
      eq(problems.id, domainProblemBindings.problem_id),
    ).innerJoin(domains, eq(domains.id, problems.domain_id)).where(condition);
  const [[total], rows] = await Promise.all([
    db.select({ total: count() }).from(
      queryRows().as("management_problem_bindings"),
    ),
    queryRows().orderBy(asc(domains.slug), asc(problems.number)).limit(
      query.limit,
    ).offset((query.page - 1) * query.limit),
  ]);
  const statuses = new Map(
    (await loadBindingAvailability(
      db,
      workspace.domain.id,
      rows.map((row) => row.binding.id),
    )).map((row) => [row.id, row]),
  );
  return {
    page: query.page,
    limit: query.limit,
    total: total.total,
    items: rows.map((row) => {
      const status = statuses.get(row.binding.id);
      const owned = row.binding.kind === "owned";
      const canEdit = owned &&
        (workspace.platformAdmin || permissions.has("problem:write_any") ||
          row.problem.owner_id === actorId &&
            permissions.has("problem:write_own"));
      return {
        reference: domainProblemReference(
          { ...row.problem, domain_id: row.source.id },
          row.source.slug,
          workspace.domain.id,
        ),
        title: owned || status?.available ? row.problem.title : null,
        binding_id: row.binding.id,
        revision: row.binding.revision,
        policy_revision: row.binding.revision,
        kind: row.binding.kind,
        visibility: row.binding.visibility,
        disabled_at: row.binding.disabled_at,
        resource_available: status?.available ?? false,
        effective_version_mode: row.binding.effective_version_mode,
        required_version_id: row.binding.required_version_id,
        answer_version_id: status?.answer_version_id ?? null,
        can_edit: canEdit,
        can_share: owned &&
          (workspace.platformAdmin || permissions.has("problem:share")),
        can_manage_policy: workspace.platformAdmin ||
          permissions.has("problem:policy"),
        can_change_state: canEdit ||
          !owned &&
            (workspace.platformAdmin || permissions.has("problem:policy")),
      };
    }),
  };
}
