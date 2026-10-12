import { and, asc, eq, inArray } from "drizzle-orm";
import {
  AppError,
  BadRequestError,
  ConflictError,
  NotFoundError,
} from "../../../../shared/base/errors.ts";
import { getDb } from "../../../../shared/db/connection.ts";
import {
  domains,
  domainTrainingBindings,
  trainings,
  trainingShareSettings,
  trainingShareTargets,
} from "../../../../shared/db/schema.ts";
import {
  assertWorkspacePermission,
  loadWorkspace,
  workspaceAudit,
} from "../../../workspace/index.ts";

/** 题单分享独立于题目分享，修改使用 revision 并保存域治理审计。 */
export async function setDomainTrainingSharing(
  slug: string,
  id: string,
  actorId: string,
  input: {
    expectedRevision: number | null;
    enabled: boolean;
    scope: "all" | "selected";
    targetDomainIds: string[];
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
    !Array.isArray(input.targetDomainIds) ||
    input.targetDomainIds.length > 500 ||
    input.targetDomainIds.some((id) => typeof id !== "string" || !id)
  ) throw new BadRequestError("共享配置非法");
  const targets = [...new Set(input.targetDomainIds)];
  if (
    input.scope === "all" && targets.length ||
    input.enabled && input.scope === "selected" && !targets.length
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
    return updated;
  });
}

/** 引用只保存题单来源；题目绑定在作业发布事务中按当前集合建立。 */
export async function importDomainTraining(
  slug: string,
  trainingId: string,
  actorId: string,
) {
  return await getDb().transaction(async (tx) => {
    const target = await loadWorkspace(slug, actorId, {
      executor: tx,
      write: true,
    });
    assertWorkspacePermission(target.context, "training:import");
    const [source] = await tx.select({ training: trainings, domain: domains })
      .from(trainings)
      .innerJoin(domains, eq(domains.id, trainings.domain_id)).where(
        eq(trainings.id, trainingId),
      );
    if (!source || source.domain.id === target.domain.id) {
      throw new NotFoundError("跨域源题单不存在");
    }
    await tx.select({ id: domains.id }).from(domains).where(
      inArray(domains.id, [source.domain.id, target.domain.id]),
    ).orderBy(asc(domains.id)).for("update");
    const currentTarget = await loadWorkspace(slug, actorId, {
      executor: tx,
      write: true,
    });
    assertWorkspacePermission(currentTarget.context, "training:import");
    const [training] = await tx.select().from(trainings).where(
      eq(trainings.id, trainingId),
    ).for("share");
    const [currentSource] = await tx.select().from(domains).where(
      eq(domains.id, source.domain.id),
    );
    const [policy] = await tx.select().from(trainingShareSettings).where(
      eq(trainingShareSettings.training_id, trainingId),
    );
    if (
      !training || training.visibility !== "public" ||
      currentSource.status === "suspended" ||
      currentSource.configuration.access !== "public" || !policy?.enabled
    ) throw new NotFoundError("题单不可引用");
    if (policy.scope === "selected") {
      const [grant] = await tx.select().from(trainingShareTargets).where(
        and(
          eq(trainingShareTargets.training_id, trainingId),
          eq(trainingShareTargets.domain_id, target.domain.id),
        ),
      );
      if (!grant) throw new NotFoundError("题单未授权此工作空间");
    }
    const [binding] = await tx.insert(domainTrainingBindings).values({
      id: crypto.randomUUID(),
      domain_id: target.domain.id,
      training_id: trainingId,
      created_by: actorId,
      created_at: new Date().toISOString(),
    }).onConflictDoUpdate({
      target: [
        domainTrainingBindings.domain_id,
        domainTrainingBindings.training_id,
      ],
      set: { disabled_at: null },
    }).returning();
    await workspaceAudit(tx, actorId, target.domain.id, "domain.update", {
      operation: "training.import",
      training_id: trainingId,
    });
    return binding;
  });
}
