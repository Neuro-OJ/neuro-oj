import {
  commitDomainProblemCopy,
  compensateProblemCopy,
  prepareDomainProblemCopy,
  type PreparedProblemCopy,
} from "./problem-copy.ts";
import { generatePublicId } from "../../../../shared/security/public-id.ts";
import { and, asc, eq, inArray } from "drizzle-orm";
import {
  AppError,
  BadRequestError,
  ConflictError,
  NotFoundError,
} from "../../../../shared/base/errors.ts";
import { resolveSharingTargetSlugs } from "./problem-sharing.ts";
import { getDb } from "../../../../shared/db/connection.ts";
import {
  domains,
  problems,
  trainingProblems,
  trainings,
  trainingShareSettings,
  trainingShareTargets,
} from "../../../../shared/db/schema.ts";
import {
  assertWorkspacePermission,
  loadWorkspace,
} from "../../../access/contracts/cross-module/workspace_services_access.ts";
import { workspaceAudit } from "../../../access/contracts/cross-module/workspace_services_domains.ts";

/** 题单分享独立于题目分享，修改使用 revision 并保存域治理审计。 */
export async function setDomainTrainingSharing(
  slug: string,
  id: string,
  actorId: string,
  input: {
    expectedRevision: number | null;
    enabled: boolean;
    scope: "all" | "selected";
    targetDomainIds?: string[];
    targetDomainSlugs?: string[];
  },
) {
  if (
    input.expectedRevision === null ||
    !Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 0
  ) {
    throw new AppError("需要共享政策 revision", 428, "REVISION_REQUIRED");
  }
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
  ) {
    throw new BadRequestError("全部域不填写目标，定向共享必须填写目标域");
  }
  return await getDb().transaction(async (tx) => {
    const access = await loadWorkspace(slug, actorId, {
      executor: tx,
      write: true,
      lock: true,
    });
    assertWorkspacePermission(access.context, "training:share");
    const targets = input.targetDomainSlugs !== undefined
      ? await resolveSharingTargetSlugs(
        input.targetDomainSlugs,
        actorId,
        access.platformAdmin,
        tx,
      )
      : [...new Set(input.targetDomainIds ?? [])];
    const [training] = await tx.select().from(trainings).where(
      and(eq(trainings.id, id), eq(trainings.domain_id, access.domain.id)),
    ).for("update");
    if (!training) throw new NotFoundError("题单不在此域");
    if (
      input.enabled &&
      (training.visibility !== "public" ||
        access.domain.configuration.access !== "public")
    ) {
      throw new BadRequestError("只有公开域内公开题单可以共享");
    }
    if (targets.includes(access.domain.id)) {
      throw new BadRequestError("不能向源域自身授予引用");
    }
    if (targets.length) {
      const rows = await tx.select({ id: domains.id }).from(domains).where(
        inArray(domains.id, targets),
      );
      if (rows.length !== targets.length) {
        throw new BadRequestError("目标域不存在");
      }
    }
    const now = new Date().toISOString();
    await tx.insert(trainingShareSettings).values({
      training_id: id,
      updated_by: actorId,
      updated_at: now,
    }).onConflictDoNothing();
    const [existing] = await tx.select().from(trainingShareSettings).where(
      eq(trainingShareSettings.training_id, id),
    ).for("update");
    if (existing.revision !== input.expectedRevision) {
      throw new ConflictError("共享政策已变化，请重新读取");
    }
    await tx.delete(trainingShareTargets).where(
      eq(trainingShareTargets.training_id, id),
    );
    if (targets.length) {
      await tx.insert(trainingShareTargets).values(
        targets.map((domain_id) => ({ training_id: id, domain_id })),
      );
    }
    const [updated] = await tx.update(trainingShareSettings).set({
      enabled: input.enabled,
      scope: input.scope,
      revision: existing.revision + 1,
      updated_by: actorId,
      updated_at: now,
    }).where(eq(trainingShareSettings.training_id, id)).returning();
    await workspaceAudit(tx, actorId, access.domain.id, "domain.update", {
      operation: "training.share",
      training_id: id,
      ...input,
    });
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

/** 跨域题单导入复制有序集合和独立题目，整个集合在一个事务中发布。 */
export async function importDomainTraining(
  slug: string,
  trainingId: string,
  actorId: string,
) {
  const db = getDb();
  const target = await loadWorkspace(slug, actorId, { write: true });
  assertWorkspacePermission(target.context, "training:create");
  assertWorkspacePermission(target.context, "training:publish");
  const [source] = await db.select({ training: trainings, domain: domains })
    .from(trainings).innerJoin(domains, eq(domains.id, trainings.domain_id))
    .where(eq(trainings.id, trainingId));
  if (!source || source.domain.id === target.domain.id) {
    throw new NotFoundError("跨域源题单不存在");
  }
  if (source.training.state !== "published") {
    throw new BadRequestError("只能复制已发布题单");
  }
  const sourceAccess = await loadWorkspace(source.domain.slug, actorId, {
    write: true,
  });
  assertWorkspacePermission(
    sourceAccess.context,
    sourceAccess.context.domainPermissions.has("training:write_any") ||
      source.training.created_by !== actorId
      ? "training:write_any"
      : "training:write_own",
  );
  const items = await db.select({
    problem: problems,
    position: trainingProblems.position,
  })
    .from(trainingProblems).innerJoin(
      problems,
      eq(problems.id, trainingProblems.problem_id),
    )
    .where(eq(trainingProblems.training_id, trainingId)).orderBy(
      asc(trainingProblems.position),
    );
  if (items.some((item) => item.problem.domain_id !== source.domain.id)) {
    throw new BadRequestError("源题单必须只包含本域独立题目");
  }
  const copies = new Map<string, PreparedProblemCopy>();
  try {
    for (const item of items) {
      if (!copies.has(item.problem.id)) {
        copies.set(
          item.problem.id,
          await prepareDomainProblemCopy(
            slug,
            `${source.domain.slug}:${item.problem.number}`,
            actorId,
          ),
        );
      }
    }
    return await db.transaction(async (tx) => {
      await tx.select({ id: domains.id }).from(domains).where(
        inArray(domains.id, [source.domain.id, target.domain.id]),
      ).orderBy(asc(domains.id)).for("update");
      const currentTarget = await loadWorkspace(slug, actorId, {
        executor: tx,
        write: true,
      });
      assertWorkspacePermission(currentTarget.context, "training:create");
      assertWorkspacePermission(currentTarget.context, "training:publish");
      const currentSource = await loadWorkspace(source.domain.slug, actorId, {
        executor: tx,
        write: true,
      });
      const [current] = await tx.select().from(trainings).where(
        eq(trainings.id, trainingId),
      ).for("share");
      if (!current || current.revision !== source.training.revision) {
        throw new ConflictError("源题单已变化，请重新复制");
      }
      assertWorkspacePermission(
        currentSource.context,
        currentSource.context.domainPermissions.has("training:write_any") ||
          current.created_by !== actorId
          ? "training:write_any"
          : "training:write_own",
      );
      const ids = new Map<string, string>();
      for (const [id, prepared] of copies) {
        ids.set(
          id,
          (await commitDomainProblemCopy(tx, prepared)).binding.problem_id,
        );
      }
      const now = new Date().toISOString(), id = crypto.randomUUID();
      await tx.insert(trainings).values({
        id,
        public_id: generatePublicId("tr"),
        domain_id: target.domain.id,
        title: current.title,
        description: current.description,
        state: "published",
        visibility: "public",
        created_by: actorId,
        created_at: now,
        updated_at: now,
      });
      if (items.length) {
        await tx.insert(trainingProblems).values(
          items.map((item, position) => ({
            training_id: id,
            problem_id: ids.get(item.problem.id)!,
            position,
          })),
        );
      }
      await workspaceAudit(tx, actorId, target.domain.id, "domain.update", {
        operation: "training.copy",
        training_id: id,
        source_training_id: trainingId,
      });
      return {
        id,
        training_id: id,
        domain_id: target.domain.id,
        created_by: actorId,
        created_at: now,
        disabled_at: null,
      };
    });
  } catch (error) {
    await Promise.allSettled([...copies.values()].map(compensateProblemCopy));
    throw error;
  }
}

/** 本域题单共享设置及稳定目标来源；未设置时返回 revision 0。 */
export async function readDomainTrainingSharing(
  slug: string,
  id: string,
  actorId: string,
) {
  const workspace = await loadWorkspace(slug, actorId), db = getDb();
  const [training] = await db.select({ id: trainings.id }).from(trainings)
    .where(
      and(eq(trainings.domain_id, workspace.domain.id), eq(trainings.id, id)),
    );
  if (!training) throw new NotFoundError("题单不在此域");
  assertWorkspacePermission(workspace.context, "training:share");
  const [policy] = await db.select().from(trainingShareSettings).where(
    eq(trainingShareSettings.training_id, id),
  );
  const target_domains = await db.select({
    id: domains.id,
    slug: domains.slug,
    name: domains.name,
  }).from(trainingShareTargets).innerJoin(
    domains,
    eq(domains.id, trainingShareTargets.domain_id),
  ).where(eq(trainingShareTargets.training_id, id)).orderBy(domains.slug);
  return {
    enabled: policy?.enabled ?? false,
    scope: policy?.scope ?? "all",
    revision: policy?.revision ?? 0,
    target_domains,
  };
}
