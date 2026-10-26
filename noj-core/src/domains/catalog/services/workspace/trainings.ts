import { and, eq } from "drizzle-orm";
import {
  AppError,
  BadRequestError,
  ConflictError,
  NotFoundError,
} from "../../../../shared/base/errors.ts";
import { getDb } from "../../../../shared/db/connection.ts";
import { trainingProblems, trainings } from "../../../../shared/db/schema.ts";
import { generatePublicId } from "../../../../shared/security/public-id.ts";
import {
  assertWorkspacePermission,
  loadWorkspace,
  workspaceAudit,
} from "../../../workspace/index.ts";
import { resolveDomainProblem } from "./problem-binding-access.ts";

/** 域题单完整编辑表单使用来源题号；题单不复制源题内容。 */
export interface DomainTrainingInput {
  title: string;
  description?: string;
  visibility: "private" | "unlisted" | "public";
  problems: string[];
}

function validate(input: DomainTrainingInput) {
  if (
    typeof input.title !== "string" || !input.title.trim() ||
    input.title.length > 100 ||
    input.description !== undefined &&
      (typeof input.description !== "string" ||
        input.description.length > 30000) ||
    !["private", "unlisted", "public"].includes(input.visibility) ||
    !Array.isArray(input.problems) || input.problems.length > 200 ||
    input.problems.some((ref) => typeof ref !== "string") ||
    new Set(input.problems).size !== input.problems.length
  ) {
    throw new BadRequestError(
      "题单标题、可见性或题目列表格式错误（最多 200 道题）",
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
    if (
      input.visibility === "public" &&
      resources.some((r) =>
        r.binding.visibility !== "public" || r.problem.visibility !== "public"
      )
    ) {
      throw new BadRequestError("公开题单只能包含本域公开展示的公开题");
    }
    const now = new Date().toISOString(),
      id = previous?.id ?? crypto.randomUUID();
    const values = {
      title: input.title.trim(),
      description: input.description?.trim() ?? "",
      visibility: input.visibility,
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
