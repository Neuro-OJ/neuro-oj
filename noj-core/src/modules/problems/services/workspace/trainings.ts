import { and, eq } from "drizzle-orm";
import {
  AppError,
  BadRequestError,
  ConflictError,
  NotFoundError,
} from "../../../../shared/base/errors.ts";
import { getDb } from "../../../../shared/db/connection.ts";
import {
  domainTrainingBindings,
  trainingProblems,
  trainings,
  trainingShareSettings,
  trainingShareTargets,
} from "../../../../shared/db/schema.ts";
import { generatePublicId } from "../../../../shared/security/public-id.ts";
import {
  assertWorkspacePermission,
  loadWorkspace,
} from "../../../access/contracts/cross-module/workspace_services_access.ts";
import { workspaceAudit } from "../../../access/contracts/cross-module/workspace_services_domains.ts";
import { resolveDomainProblem } from "./problem-binding-access.ts";

/** 域题单只编排本域题目；跨域复用先复制为独立资源。 */
export interface DomainTrainingInput {
  state?: "draft" | "published";
  title: string;
  description?: string;
  visibility?: "private" | "unlisted" | "public";
  problems: string[];
}

function validate(input: DomainTrainingInput) {
  if (
    input.state !== undefined &&
      !["draft", "published"].includes(input.state) ||
    typeof input.title !== "string" || !input.title.trim() ||
    input.title.length > 100 ||
    input.description !== undefined &&
      (typeof input.description !== "string" ||
        input.description.length > 30000) ||
    !Array.isArray(input.problems) || input.problems.length > 200 ||
    input.problems.some((ref) => typeof ref !== "string") ||
    new Set(input.problems).size !== input.problems.length
  ) {
    throw new BadRequestError(
      "题单标题、发布状态或题目列表格式错误（最多 200 道题）",
    );
  }
}

/** 创建及编辑只作用于 URL 所属域，使用班级以外的独立资源编辑权限。 */
export async function saveDomainTraining(
  slug: string,
  actorId: string,
  input: DomainTrainingInput,
  existing?: { id: string; revision: number | null },
) {
  validate(input);
  const state = input.state ??
    (input.visibility === "public" || input.visibility === "unlisted"
      ? "published"
      : "draft");
  return await getDb().transaction(async (tx) => {
    const access = await loadWorkspace(slug, actorId, {
      executor: tx,
      write: true,
      lock: true,
    });
    const [previous] = existing
      ? await tx.select().from(trainings).where(and(
        eq(trainings.id, existing.id),
        eq(trainings.domain_id, access.domain.id),
      )).for("update")
      : [];
    if (existing && !previous) throw new NotFoundError("题单不在此域");
    assertWorkspacePermission(
      access.context,
      previous
        ? previous.created_by === actorId
          ? "training:write_own"
          : "training:write_any"
        : "training:create",
    );
    if (state === "published") {
      assertWorkspacePermission(access.context, "training:publish");
    }
    if (existing) {
      if (
        existing.revision === null ||
        !Number.isSafeInteger(existing.revision) || existing.revision < 0
      ) {
        throw new AppError("需要题单 revision", 428, "REVISION_REQUIRED");
      }
      if (existing.revision !== previous.revision) {
        throw new ConflictError("题单已变化，请重新读取");
      }
    }
    const resources = [];
    for (const reference of input.problems) {
      resources.push(
        await resolveDomainProblem(slug, reference, actorId, { executor: tx }),
      );
    }
    if (
      new Set(resources.map((resource) => resource.problem.id)).size !==
        resources.length
    ) {
      throw new BadRequestError("同一道源题不能重复加入题单");
    }
    const now = new Date().toISOString(),
      id = previous?.id ?? crypto.randomUUID();
    const values = {
      title: input.title.trim(),
      description: input.description?.trim() ?? "",
      state,
      visibility: state === "published" ? "public" : "private",
      revision: previous ? previous.revision + 1 : 0,
      updated_at: now,
    };
    const [saved] = previous
      ? await tx.update(trainings).set(values).where(eq(trainings.id, id))
        .returning()
      : await tx.insert(trainings).values({
        id,
        domain_id: access.domain.id,
        public_id: generatePublicId("tr"),
        created_by: actorId,
        created_at: now,
        ...values,
      }).returning();
    await tx.delete(trainingProblems).where(
      eq(trainingProblems.training_id, id),
    );
    if (resources.length) {
      await tx.insert(trainingProblems).values(
        resources.map((resource, position) => ({
          training_id: id,
          problem_id: resource.problem.id,
          position,
        })),
      );
    }
    await workspaceAudit(tx, actorId, access.domain.id, "domain.update", {
      operation: "training.save",
      training_id: id,
      revision: saved.revision,
    });
    return saved;
  });
}

/** 删除本域自有题单；存在跨域引用时拒绝，避免历史题单链接失效。 */
export async function deleteDomainTraining(
  slug: string,
  actorId: string,
  trainingId: string,
): Promise<void> {
  await getDb().transaction(async (tx) => {
    const workspace = await loadWorkspace(slug, actorId, {
      executor: tx,
      write: true,
      lock: true,
    });
    const [training] = await tx.select().from(trainings).where(and(
      eq(trainings.id, trainingId),
      eq(trainings.domain_id, workspace.domain.id),
    )).for("update");
    if (!training) throw new NotFoundError("题单不在此域");
    assertWorkspacePermission(
      workspace.context,
      training.created_by === actorId
        ? "training:delete_own"
        : "training:delete_any",
    );
    const [reference] = await tx.select({ id: domainTrainingBindings.id })
      .from(domainTrainingBindings)
      .where(eq(domainTrainingBindings.training_id, trainingId))
      .limit(1);
    if (reference) {
      throw new ConflictError("题单已有共享引用，请停止共享并保留历史");
    }
    await tx.delete(trainingProblems).where(
      eq(trainingProblems.training_id, trainingId),
    );
    await tx.delete(trainingShareTargets).where(
      eq(trainingShareTargets.training_id, trainingId),
    );
    await tx.delete(trainingShareSettings).where(
      eq(trainingShareSettings.training_id, trainingId),
    );
    await tx.delete(trainings).where(eq(trainings.id, trainingId));
    await workspaceAudit(tx, actorId, workspace.domain.id, "domain.update", {
      operation: "training.delete",
      training_id: trainingId,
    });
  });
}
