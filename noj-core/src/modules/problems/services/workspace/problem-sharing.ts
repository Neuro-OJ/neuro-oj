import {
  and,
  asc,
  count,
  eq,
  ilike,
  inArray,
  isNotNull,
  isNull,
  ne,
  sql,
} from "drizzle-orm";
import {
  AppError,
  BadRequestError,
  ConflictError,
  NotFoundError,
} from "../../../../shared/base/errors.ts";
import type { Executor } from "../../../../shared/db/executor.ts";
import { getDb } from "../../../../shared/db/connection.ts";
import { assertWorkspacePermission as assertAccessWorkspacePermission } from "../../../access/policy.ts";
import { loadWorkspaceTx } from "../../../access/policy.ts";
import { userActorFromAuthenticatedId } from "../../../access/contracts/actor.ts";
import {
  domainProblemBindings,
  domains,
  problems,
  problemShareSettings,
  problemShareTargets,
  problemVersions,
  trainings,
  trainingShareSettings,
} from "../../../../shared/db/schema.ts";
import {
  assertWorkspacePermission as assertLegacyWorkspacePermission,
  loadWorkspace as loadLegacyWorkspace,
} from "../../../access/contracts/cross-module/workspace_services_access.ts";
import { validateDomainSlug } from "../../../access/workspace/types.ts";
import { workspaceAudit } from "../../../access/contracts/cross-module/workspace_services_domains.ts";
import { unendedPublicContestForProblem } from "../../../access/contest-policy.ts";
import { domainProblemReference } from "./problem-reference.ts";
import { parseDomainProblemReference } from "./problem-reference.ts";
import { recordProblemEducationChange } from "./education-events.ts";

/** 设置引用授权与题目可见性分离；关闭授权的提交即时使后续检查拒绝。 */
export async function setDomainProblemSharing(
  slug: string,
  reference: string,
  actorId: string,
  input: {
    expectedRevision: number | null;
    enabled: boolean;
    scope: "all" | "selected";
    targetDomainIds?: string[];
    targetDomainSlugs?: string[];
  },
) {
  const parsed = parseDomainProblemReference(reference);
  if (parsed.sourceSlug && parsed.sourceSlug !== slug) {
    throw new NotFoundError("不能修改其他域源题共享政策");
  }
  if (
    input.expectedRevision === null ||
    !Number.isInteger(input.expectedRevision) || input.expectedRevision < 0
  ) throw new AppError("需要共享政策 revision", 428, "REVISION_REQUIRED");
  if (
    typeof input.enabled !== "boolean" ||
    !["all", "selected"].includes(input.scope) ||
    input.targetDomainIds !== undefined &&
      input.targetDomainSlugs !== undefined ||
    !Array.isArray(input.targetDomainSlugs ?? input.targetDomainIds ?? []) ||
    (input.targetDomainSlugs ?? input.targetDomainIds ?? []).length > 500 ||
    (input.targetDomainSlugs ?? input.targetDomainIds ?? []).some((id) =>
      typeof id !== "string" || !id
    )
  ) throw new BadRequestError("共享配置非法");
  const configuredTargets = input.targetDomainSlugs ?? input.targetDomainIds ??
    [];
  if (
    input.scope === "all" && configuredTargets.length ||
    input.enabled && input.scope === "selected" && !configuredTargets.length
  ) throw new BadRequestError("全部域模式不填写目标；定向共享必须填写目标域");
  return await getDb().transaction(async (tx) => {
    const actor = userActorFromAuthenticatedId(actorId);
    const { domain, context } = await loadWorkspaceTx(tx, slug, actor, {
      write: true,
      lock: true,
    });
    assertAccessWorkspacePermission(context, "problem:share");
    const targets = input.targetDomainSlugs !== undefined
      ? await resolveSharingTargetSlugs(
        input.targetDomainSlugs,
        actorId,
        context.platformPermissions.has("admin:full_access"),
        tx,
      )
      : [...new Set(input.targetDomainIds ?? [])];
    const [problem] = await tx.select().from(problems).where(
      and(
        eq(problems.domain_id, domain.id),
        eq(problems.number, parsed.number),
      ),
    ).for("update");
    if (!problem) throw new NotFoundError("源题不存在");
    const [owned] = await tx.select({
      visibility: domainProblemBindings.visibility,
    }).from(domainProblemBindings).where(and(
      eq(domainProblemBindings.domain_id, domain.id),
      eq(domainProblemBindings.problem_id, problem.id),
      eq(domainProblemBindings.kind, "owned"),
    ));
    if (
      input.enabled &&
      (problem.visibility !== "public" || !problem.latest_version_id ||
        domain.configuration.access !== "public" ||
        owned?.visibility !== "public")
    ) throw new BadRequestError("只有公开域内已发布的公开题可以共享");
    if (targets.includes(domain.id)) {
      throw new BadRequestError("不能向源域自身授予引用");
    }
    if (targets.length) {
      const found = await tx.select({ id: domains.id }).from(domains).where(
        inArray(domains.id, targets),
      );
      if (found.length !== targets.length) {
        throw new BadRequestError("目标域不存在");
      }
    }
    const now = new Date().toISOString();
    await tx.insert(problemShareSettings).values({
      problem_id: problem.id,
      updated_by: actorId,
      updated_at: now,
    }).onConflictDoNothing();
    const [existing] = await tx.select().from(problemShareSettings).where(
      eq(problemShareSettings.problem_id, problem.id),
    ).for("update");
    if (existing.revision !== input.expectedRevision) {
      throw new ConflictError("共享政策已变化，请重新读取");
    }
    await tx.delete(problemShareTargets).where(
      eq(problemShareTargets.problem_id, problem.id),
    );
    if (targets.length) {
      await tx.insert(problemShareTargets).values(
        targets.map((id) => ({ problem_id: problem.id, domain_id: id })),
      );
    }
    const [updated] = await tx.update(problemShareSettings).set({
      enabled: input.enabled,
      scope: input.scope,
      revision: existing.revision + 1,
      updated_by: actorId,
      updated_at: now,
    }).where(eq(problemShareSettings.problem_id, problem.id)).returning();
    await workspaceAudit(tx, actorId, domain.id, "domain.update", {
      operation: "problem.share",
      problem_id: problem.id,
      enabled: updated.enabled,
      scope: updated.scope,
      revision: updated.revision,
      target_domain_ids: targets,
    });
    await recordProblemEducationChange(tx, problem.id);
    const target_domains = targets.length
      ? await tx.select({
        id: domains.id,
        slug: domains.slug,
        name: domains.name,
      }).from(domains).where(inArray(domains.id, targets)).orderBy(domains.slug)
      : [];
    return { ...updated, target_domains };
  });
}

/** 将可读的目标域标识转为稳定 ID；不能借共享配置探测隐藏的私有域。 */
export async function resolveSharingTargetSlugs(
  slugs: string[],
  actorId: string,
  platformAdmin: boolean,
  executor: Executor,
) {
  if (!Array.isArray(slugs) || slugs.length > 500) {
    throw new BadRequestError("目标域列表格式非法");
  }
  for (const slug of slugs) validateDomainSlug(slug);
  const unique = [...new Set(slugs)];
  if (!unique.length) return [];
  const rows = await executor.select({ id: domains.id, slug: domains.slug })
    .from(domains).where(and(
      inArray(domains.slug, unique),
      sql`${domains.status} <> 'suspended'`,
      platformAdmin
        ? undefined
        : sql`(${domains.configuration}->>'access' = 'public' OR ${domains.configuration}->>'discoverable' = 'true' OR EXISTS (
      SELECT 1 FROM domain_memberships member WHERE member.domain_id = ${domains.id} AND member.user_id = ${actorId} AND member.status = 'active'))`,
    ));
  if (rows.length !== unique.length) {
    throw new NotFoundError("目标工作空间不存在或不可读取");
  }
  return rows.map((row) => row.id);
}

/** 共享政策读取也允许本域已下架题，便于管理员撤销与恢复授权。 */
export async function readDomainProblemSharing(
  slug: string,
  reference: string,
  actorId: string,
) {
  const parsed = parseDomainProblemReference(reference);
  if (parsed.sourceSlug && parsed.sourceSlug !== slug) {
    throw new NotFoundError("此题不属于源域");
  }
  const workspace = await loadLegacyWorkspace(slug, actorId);
  const db = getDb();
  const [problem] = await db.select({ id: problems.id }).from(problems).where(
    and(
      eq(problems.domain_id, workspace.domain.id),
      eq(problems.number, parsed.number),
    ),
  );
  if (!problem) throw new NotFoundError("源题不存在");
  assertLegacyWorkspacePermission(workspace.context, "problem:share");
  const [policy] = await db.select().from(problemShareSettings).where(
    eq(problemShareSettings.problem_id, problem.id),
  );
  const targets = await db.select({
    id: domains.id,
    slug: domains.slug,
    name: domains.name,
  }).from(problemShareTargets).innerJoin(
    domains,
    eq(domains.id, problemShareTargets.domain_id),
  ).where(eq(problemShareTargets.problem_id, problem.id)).orderBy(domains.slug);
  return {
    enabled: policy?.enabled ?? false,
    scope: policy?.scope ?? "all",
    revision: policy?.revision ?? 0,
    target_domains: targets,
  };
}

/** 公开来源发现只返回当前向使用域开放引用的条目；计数与分页同步执行授权过滤。 */
export async function listSharedDomainResources(
  slug: string,
  actorId: string,
  query: {
    kind: "problem" | "training";
    page: number;
    limit: number;
    sourceSlug?: string;
    keyword?: string;
  },
) {
  const workspace = await loadLegacyWorkspace(slug, actorId), db = getDb();
  assertLegacyWorkspacePermission(
    workspace.context,
    query.kind === "problem"
      ? workspace.context.domainPermissions.has("problem:import")
        ? "problem:import"
        : "problem:create"
      : "training:import",
  );
  const sourceCondition = and(
    ne(domains.id, workspace.domain.id),
    sql`${domains.status} <> 'suspended'`,
    sql`${domains.configuration}->>'access' = 'public'`,
    query.sourceSlug ? eq(domains.slug, query.sourceSlug) : undefined,
  );
  if (query.kind === "problem") {
    const condition = and(
      sourceCondition,
      eq(problems.visibility, "public"),
      isNotNull(problems.latest_version_id),
      eq(domainProblemBindings.kind, "owned"),
      eq(domainProblemBindings.visibility, "public"),
      isNull(domainProblemBindings.disabled_at),
      eq(problemShareSettings.enabled, true),
      sql`(${problemShareSettings.scope}='all' OR EXISTS (SELECT 1 FROM problem_share_targets target WHERE target.problem_id=${problems.id} AND target.domain_id=${workspace.domain.id}))`,
      sql`NOT ${unendedPublicContestForProblem(problems.id, domains.id)}`,
      query.keyword
        ? ilike(
          sql`${domains.slug} || ':' || ${problems.number} || ' ' || (${problemVersions.content}->>'title')`,
          `%${query.keyword}%`,
        )
        : undefined,
    );
    const rowsQuery = () =>
      db.select({
        id: problems.id,
        domain_id: domains.id,
        source_slug: domains.slug,
        number: problems.number,
        title: sql<string>`${problemVersions.content}->>'title'`,
        kind: sql<string>`${problemVersions.content}->>'kind'`,
        version_id: problemVersions.id,
        version: problemVersions.version,
      }).from(problems).innerJoin(domains, eq(domains.id, problems.domain_id))
        .innerJoin(
          domainProblemBindings,
          and(
            eq(domainProblemBindings.domain_id, domains.id),
            eq(domainProblemBindings.problem_id, problems.id),
          ),
        ).innerJoin(
          problemShareSettings,
          eq(problemShareSettings.problem_id, problems.id),
        ).innerJoin(
          problemVersions,
          eq(problemVersions.id, problems.latest_version_id),
        ).where(condition);
    const [[total], rows] = await Promise.all([
      db.select({ total: count() }).from(
        rowsQuery().as("discoverable_shared_problems"),
      ),
      rowsQuery().orderBy(asc(domains.slug), asc(problems.number)).offset(
        (query.page - 1) * query.limit,
      ).limit(query.limit),
    ]);
    return {
      page: query.page,
      limit: query.limit,
      total: total.total,
      items: rows.map((row) => ({
        reference: domainProblemReference(
          row,
          row.source_slug,
          workspace.domain.id,
        ),
        title: row.title,
        kind: row.kind,
        version_id: row.version_id,
        version: row.version,
      })),
    };
  }
  const condition = and(
    sourceCondition,
    eq(trainings.visibility, "public"),
    eq(trainingShareSettings.enabled, true),
    sql`(${trainingShareSettings.scope}='all' OR EXISTS (SELECT 1 FROM training_share_targets target WHERE target.training_id=${trainings.id} AND target.domain_id=${workspace.domain.id}))`,
    query.keyword ? ilike(trainings.title, `%${query.keyword}%`) : undefined,
  );
  const rowsQuery = () =>
    db.select({
      id: trainings.id,
      public_id: trainings.public_id,
      title: trainings.title,
      source_domain_id: domains.id,
      source_domain_slug: domains.slug,
    }).from(trainings).innerJoin(domains, eq(domains.id, trainings.domain_id))
      .innerJoin(
        trainingShareSettings,
        eq(trainingShareSettings.training_id, trainings.id),
      ).where(condition);
  const [[total], items] = await Promise.all([
    db.select({ total: count() }).from(
      rowsQuery().as("discoverable_shared_trainings"),
    ),
    rowsQuery().orderBy(
      asc(domains.slug),
      asc(trainings.title),
      asc(trainings.id),
    ).offset((query.page - 1) * query.limit).limit(query.limit),
  ]);
  return { page: query.page, limit: query.limit, total: total.total, items };
}
