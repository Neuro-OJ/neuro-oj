import { and, eq, inArray } from "drizzle-orm";
import {
  AppError,
  BadRequestError,
  ConflictError,
  NotFoundError,
} from "../../../../shared/base/errors.ts";
import { getDb } from "../../../../shared/db/connection.ts";
import {
  domainProblemBindings,
  domains,
  problems,
  problemShareSettings,
  problemShareTargets,
} from "../../../../shared/db/schema.ts";
import {
  assertWorkspacePermission,
  loadWorkspace,
  workspaceAudit,
} from "../../../workspace/index.ts";
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
    targetDomainIds: string[];
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
    !Array.isArray(input.targetDomainIds) ||
    input.targetDomainIds.length > 500 ||
    input.targetDomainIds.some((id) => typeof id !== "string" || !id)
  ) throw new BadRequestError("共享配置非法");
  const targets = [...new Set(input.targetDomainIds)];
  if (
    input.scope === "all" && targets.length ||
    input.enabled && input.scope === "selected" && !targets.length
  ) throw new BadRequestError("全部域模式不填写目标；定向共享必须填写目标域");
  return await getDb().transaction(async (tx) => {
    const { domain, context } = await loadWorkspace(slug, actorId, {
      executor: tx,
      write: true,
      lock: true,
    });
    assertWorkspacePermission(context, "problem:share");
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
    return updated;
  });
}
