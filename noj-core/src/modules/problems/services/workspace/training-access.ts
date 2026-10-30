import { loadDomainProblemProtection } from "../../../access/contest-policy.ts";
import { and, asc, count, eq, ilike, inArray, or } from "drizzle-orm";
import { getDb } from "../../../../shared/db/connection.ts";
import type { Executor } from "../../../../shared/db/executor.ts";
import {
  ConflictError,
  ForbiddenError,
  NotFoundError,
} from "../../../../shared/base/errors.ts";
import {
  domainProblemBindings,
  domains,
  domainTrainingBindings,
  problems,
  trainingProblems,
  trainings,
  trainingShareSettings,
} from "../../../../shared/db/schema.ts";
import { loadWorkspace } from "../../../access/contracts/cross-module/workspace_services_access.ts";
import { resolveDomainProblem } from "./problem-binding-access.ts";

/** 只读取本域题单；作者身份不能绕过域进入政策。 */
export async function resolveDomainTraining(
  slug: string,
  trainingId: string,
  actorId: string | null,
  executor: Executor = getDb(),
) {
  const workspace = await loadWorkspace(slug, actorId, { executor });
  const [row] = await executor.select({ training: trainings, source: domains })
    .from(trainings).innerJoin(domains, eq(domains.id, trainings.domain_id))
    .where(eq(trainings.id, trainingId));
  if (!row) throw new NotFoundError("题单不存在或不可访问");
  const shared = row.source.id !== workspace.domain.id;
  if (shared) throw new NotFoundError("请先将题单独立复制到当前域");
  if (
    row.training.state !== "published" && !workspace.platformAdmin &&
    !workspace.context.domainPermissions.has("training:write_any") &&
    !(row.training.created_by === actorId &&
      workspace.context.domainPermissions.has("training:write_own"))
  ) {
    throw new NotFoundError("题单尚未发布");
  }
  const items = await executor.select({
    problem: problems,
    source: domains,
    position: trainingProblems.position,
    binding: domainProblemBindings,
  }).from(trainingProblems)
    .innerJoin(problems, eq(problems.id, trainingProblems.problem_id))
    .innerJoin(domains, eq(domains.id, problems.domain_id))
    .leftJoin(
      domainProblemBindings,
      and(
        eq(domainProblemBindings.problem_id, problems.id),
        eq(domainProblemBindings.domain_id, workspace.domain.id),
      ),
    ).where(eq(trainingProblems.training_id, trainingId))
    .orderBy(asc(trainingProblems.position), problems.id);
  return { ...workspace, ...row, shared, items };
}

/** 逐题检查本域归属和当前可用性，保护期间仍返回可展示的题目元数据。 */
export async function readDomainTraining(
  slug: string,
  trainingId: string,
  actorId: string | null,
  executor: Executor = getDb(),
) {
  const resource = await resolveDomainTraining(
    slug,
    trainingId,
    actorId,
    executor,
  );
  const protectionByProblem = await loadDomainProblemProtection(
    resource.domain.id,
    resource.items.map((item) => item.problem.id),
    executor,
  );
  const items = [];
  for (const item of resource.items) {
    const qualified = `${item.source.slug}:${item.problem.number}`;
    let sourceAvailable = true;
    let protection: unknown[] = protectionByProblem.get(item.problem.id) ?? [];
    try {
      if (item.source.id !== resource.domain.id) {
        throw new NotFoundError("题目不属于当前域，请先独立复制");
      } else {
        await resolveDomainProblem(slug, String(item.problem.number), actorId, {
          executor,
        });
      }
    } catch (error) {
      if (
        error instanceof ForbiddenError &&
        error.code === "CONTEST_PROBLEM_RESTRICTED"
      ) {
        protection = (error.meta?.contests as unknown[]) ?? [];
      } else if (error instanceof NotFoundError) {
        sourceAvailable = false;
      } else throw error;
    }
    const bindingId = item.binding?.disabled_at
      ? null
      : item.binding?.id ?? null;
    items.push({
      problem_id: item.problem.id,
      binding_id: sourceAvailable ? bindingId : null,
      resource_available: sourceAvailable && bindingId !== null,
      contest_protection: protection,
      can_read: sourceAvailable && !protection.length,
      can_practice: sourceAvailable && !protection.length,
      can_import: false,
      source_domain_id: item.source.id,
      source_domain_slug: item.source.slug,
      number: item.problem.number,
      qualified_ref: qualified,
      display_ref: item.source.id === resource.domain.id
        ? String(item.problem.number)
        : qualified,
      is_shared: item.source.id !== resource.domain.id,
      position: item.position,
    });
  }
  return {
    id: resource.training.id,
    domain_id: resource.domain.id,
    source_domain_id: resource.source.id,
    source_domain_slug: resource.source.slug,
    title: resource.training.title,
    description: resource.training.description,
    revision: resource.training.revision,
    visibility: resource.training.visibility,
    state: resource.training.state,
    can_edit: !resource.shared &&
      (resource.platformAdmin ||
        resource.context.domainPermissions.has("training:write_any") ||
        resource.training.created_by === actorId &&
          resource.context.domainPermissions.has("training:write_own")),
    can_share: false,
    is_shared: resource.shared,
    items,
  };
}

/** 发布前先按稳定 ID 锁定所有涉及的域，再由教学模块取得班级锁，避免锁升级死锁。 */
export async function lockTrainingExpansion(
  executor: Executor,
  slug: string,
  trainingId: string,
  actorId: string,
) {
  const resource = await resolveDomainTraining(
    slug,
    trainingId,
    actorId,
    executor,
  );
  await executor.select({ id: domains.id }).from(domains).where(
    inArray(domains.id, [
      ...new Set([
        resource.domain.id,
        resource.source.id,
        ...resource.items.map((item) => item.source.id),
      ]),
    ]),
  ).orderBy(asc(domains.id)).for("update");
  const [current] = await executor.select({ revision: trainings.revision })
    .from(trainings).where(eq(trainings.id, trainingId)).for("share");
  if (!current || current.revision !== resource.training.revision) {
    throw new ConflictError("题单已变化，请重新发布");
  }
}

/** 题单目录在分页前按本域可见性及实时共享授权过滤，未列出的题单仍可按授权链接读取。 */
export async function listDomainTrainings(
  slug: string,
  actorId: string | null,
  query: { page: number; limit: number; keyword?: string },
) {
  const workspace = await loadWorkspace(slug, actorId), db = getDb();
  const all = workspace.platformAdmin ||
    workspace.context.domainPermissions.has("training:write_any");
  const condition = and(
    eq(trainings.domain_id, workspace.domain.id),
    all ? undefined : or(
      eq(trainings.state, "published"),
      actorId && workspace.context.domainPermissions.has("training:write_own")
        ? eq(trainings.created_by, actorId)
        : undefined,
    ),
    query.keyword ? ilike(trainings.title, `%${query.keyword}%`) : undefined,
  );
  const rowsQuery = () =>
    db.select({
      training: trainings,
      source: { id: domains.id, slug: domains.slug },
    }).from(trainings).innerJoin(domains, eq(domains.id, trainings.domain_id))
      .leftJoin(
        domainTrainingBindings,
        and(
          eq(domainTrainingBindings.training_id, trainings.id),
          eq(domainTrainingBindings.domain_id, workspace.domain.id),
        ),
      ).leftJoin(
        trainingShareSettings,
        eq(trainingShareSettings.training_id, trainings.id),
      ).where(condition);
  const [[total], rows] = await Promise.all([
    db.select({ total: count() }).from(
      rowsQuery().as("authorized_domain_trainings"),
    ),
    rowsQuery().orderBy(asc(trainings.title), asc(trainings.id)).limit(
      query.limit,
    ).offset((query.page - 1) * query.limit),
  ]);
  return {
    page: query.page,
    limit: query.limit,
    total: total.total,
    items: rows.map(({ training, source }) => {
      const owned = source.id === workspace.domain.id;
      return {
        id: training.id,
        public_id: training.public_id,
        source_domain_id: source.id,
        source_domain_slug: source.slug,
        is_shared: !owned,
        title: training.title,
        description: training.description,
        revision: training.revision,
        visibility: training.visibility,
        state: training.state,
        can_edit: owned &&
          (all ||
            training.created_by === actorId &&
              workspace.context.domainPermissions.has("training:write_own")),
        can_share: owned &&
          (workspace.platformAdmin ||
            workspace.context.domainPermissions.has("training:share")),
      };
    }),
  };
}
