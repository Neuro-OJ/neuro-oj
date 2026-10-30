import {
  commitDomainProblemCopy,
  compensateProblemCopy,
  prepareDomainProblemCopy,
} from "./problem-copy.ts";
import { and, asc, count, eq, ilike, inArray, or, sql } from "drizzle-orm";
import {
  domainProblemBindingAvailableWhere,
  loadBindingAvailability,
} from "./binding-availability.ts";
import {
  AppError,
  BadRequestError,
  ConflictError,
  NotFoundError,
} from "../../../../shared/base/errors.ts";
import { getDb } from "../../../../shared/db/connection.ts";
import type { DbTx, Executor } from "../../../../shared/db/executor.ts";
import { loadWorkspaceTx } from "../../../access/policy.ts";
import { userActorFromAuthenticatedId } from "../../../access/contracts/actor.ts";
import { workspaceAuditTx } from "../../../access/audit.ts";
import { recordProblemChangeTx } from "../../../education/contracts/events.ts";
import { recordProblemEducationChange } from "./education-events.ts";
import type { UserActor } from "../../../access/contracts/actor.ts";
import {
  domainProblemBindings,
  domains,
  problemBindingHistory,
  problems,
  problemVersions,
} from "../../../../shared/db/schema.ts";
import type { EffectiveVersionPolicy } from "../../../../shared/versioning/types.ts";
import {
  assertWorkspacePermission as assertLegacyWorkspacePermission,
  loadWorkspace,
} from "../../../access/contracts/cross-module/workspace_services_access.ts";
import {
  assertCurrentProblemShare,
  legacyWorkspaceFromAccess,
  resolveDomainProblem,
} from "./problem-binding-access.ts";
import {
  domainProblemReference,
  parseDomainProblemReference,
} from "./problem-reference.ts";

function isDbTx(executor: Executor): executor is DbTx {
  return "rollback" in executor && "setTransaction" in executor &&
    "nestedIndex" in executor;
}

/** 写入绑定变化依据，和配置共用事务，不依赖可丢失的通知。 */
async function recordBinding(
  binding: typeof domainProblemBindings.$inferSelect,
  answerVersionId: string | null,
  actorId: string,
  reason: string,
  tx: DbTx,
) {
  const [policyProblem] = await tx.select().from(problems).where(
    eq(problems.id, binding.problem_id),
  );
  await tx.insert(problemBindingHistory).values({
    id: crypto.randomUUID(),
    binding_id: binding.id,
    problem_id: binding.problem_id,
    revision: binding.revision,
    effective_version_mode: policyProblem.effective_version_mode as
      | "any"
      | "exact",
    required_version_id: policyProblem.required_version_id,
    answer_version_id: answerVersionId,
    disabled_at: binding.disabled_at,
    actor_id: actorId,
    reason,
    created_at: new Date().toISOString(),
  });
  // 源题（owned）状态变化会影响所有使用域的引用，必须让全部绑定陈旧；
  // 共享引用（shared）只影响它自己的使用域。
  if (binding.kind === "owned") {
    await recordProblemEducationChange(tx, binding.problem_id);
  } else {
    await recordProblemChangeTx(tx, {
      domainId: binding.domain_id,
      problemId: binding.problem_id,
    });
  }
  await workspaceAuditTx(
    tx,
    userActorFromAuthenticatedId(actorId),
    binding.domain_id,
    "domain.update",
    {
      operation: "problem.binding",
      binding_id: binding.id,
      problem_id: binding.problem_id,
      revision: binding.revision,
      reason,
      visibility: binding.visibility,
      disabled_at: binding.disabled_at,
    },
  );
}

/** 跨域导入创建独立已发布副本；文件预检在事务外完成。 */
export async function importDomainProblem(
  slug: string,
  sourceReference: string,
  actorId: string,
  executor?: Executor,
  versionId?: string,
) {
  if (executor) {
    throw new BadRequestError("请先在目标域复制题目，再将本域题目加入作业");
  }
  const prepared = await prepareDomainProblemCopy(
    slug,
    sourceReference,
    actorId,
    versionId,
  );
  try {
    return await getDb().transaction((tx) =>
      commitDomainProblemCopy(tx, prepared)
    );
  } catch (error) {
    await compensateProblemCopy(prepared);
    throw error;
  }
}

/** 新 application 入口的显式用户合同；旧字符串入口仅供迁移期调用方使用。 */
export function importDomainProblemForActor(
  slug: string,
  sourceReference: string,
  actor: UserActor,
  versionId?: string,
) {
  return importDomainProblem(
    slug,
    sourceReference,
    actor.userId,
    undefined,
    versionId,
  );
}

/** 题库策略独立修改；不更新其他域绑定或改写旧版本和提交。 */
export async function setDomainProblemBindingPolicy(
  slug: string,
  reference: string,
  actorId: string,
  expectedRevision: number | null,
  policy: EffectiveVersionPolicy,
  reason: string,
  executor?: Executor,
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
  const operation = async (tx: DbTx) => {
    const workspace = legacyWorkspaceFromAccess(
      await loadWorkspaceTx(
        tx,
        slug,
        userActorFromAuthenticatedId(actorId),
        {
          write: true,
          lock: true,
        },
      ),
    );
    assertLegacyWorkspacePermission(workspace.context, "problem:policy");
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
      throw new ConflictError(
        "题库配置已变化，请重新读取",
        "EFFECTIVE_POLICY_REVISION_CONFLICT",
      );
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
      revision: binding.revision + 1,
      updated_at: new Date().toISOString(),
    }).where(eq(domainProblemBindings.id, binding.id)).returning();
    await tx.update(problems).set({
      effective_version_mode: policy.mode,
      required_version_id: required,
      effective_policy_revision: binding.revision + 1,
    }).where(eq(problems.id, binding.problem_id));
    await recordBinding(
      updated,
      required ?? resolved.problem.latest_version_id,
      actorId,
      reason.trim(),
      tx,
    );
    return updated;
  };
  return executor && isDbTx(executor)
    ? await operation(executor)
    : await getDb().transaction(operation);
}

/** 题库有效版本策略的显式用户合同。 */
export function setDomainProblemBindingPolicyForActorTx(
  actor: UserActor,
  slug: string,
  reference: string,
  expectedRevision: number | null,
  policy: EffectiveVersionPolicy,
  reason: string,
  executor: DbTx,
) {
  return setDomainProblemBindingPolicy(
    slug,
    reference,
    actor.userId,
    expectedRevision,
    policy,
    reason,
    executor,
  );
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
    const actor = userActorFromAuthenticatedId(actorId);
    await loadWorkspaceTx(tx, slug, actor, { write: true });
    await tx.select({ id: domains.id }).from(domains).where(
      inArray(domains.slug, [slug, parsed.sourceSlug ?? slug]),
    ).orderBy(asc(domains.id)).for("update");
    const workspace = legacyWorkspaceFromAccess(
      await loadWorkspaceTx(
        tx,
        slug,
        actor,
        {
          write: true,
          lock: true,
        },
      ),
    );
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
      assertLegacyWorkspacePermission(
        workspace.context,
        workspace.context.domainPermissions.has("problem:write_any")
          ? "problem:write_any"
          : resource.problem.owner_id === actorId
          ? "problem:write_own"
          : "problem:write_any",
      );
    } else {
      assertLegacyWorkspacePermission(workspace.context, "problem:policy");
    }
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
      currentProblem.required_version_id ?? currentProblem.latest_version_id,
      actorId,
      input.reason.trim(),
      tx,
    );
    return updated;
  });
}

/** 题库上下架状态的显式用户合同。 */
export function setDomainProblemBindingStateForActor(
  actor: UserActor,
  slug: string,
  reference: string,
  expectedRevision: number | null,
  input: {
    disabled: boolean;
    visibility?: "public" | "members";
    reason: string;
  },
) {
  return setDomainProblemBindingState(
    slug,
    reference,
    actor.userId,
    expectedRevision,
    input,
  );
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
    assertLegacyWorkspacePermission(workspace.context, "problem:policy");
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
        effective_version_mode: problems.effective_version_mode,
        required_version_id: problems.required_version_id,
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
        effective_version_mode: row.problem.effective_version_mode,
        required_version_id: row.problem.required_version_id,
        answer_version_id: status?.answer_version_id ?? null,
        can_edit: canEdit,
        can_share: false,
        can_manage_policy: workspace.platformAdmin ||
          permissions.has("problem:policy"),
        can_change_state: canEdit ||
          !owned &&
            (workspace.platformAdmin || permissions.has("problem:policy")),
      };
    }),
  };
}
