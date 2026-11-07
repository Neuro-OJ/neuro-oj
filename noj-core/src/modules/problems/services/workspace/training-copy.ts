import {
  commitDomainProblemCopy,
  compensateProblemCopy,
  prepareDomainProblemCopy,
  type PreparedProblemCopy,
} from "./problem-copy.ts";
import { generatePublicId } from "../../../../shared/security/public-id.ts";
import { asc, eq, inArray } from "drizzle-orm";
import {
  BadRequestError,
  ConflictError,
  NotFoundError,
} from "../../../../shared/base/errors.ts";
import { getDb } from "../../../../shared/db/connection.ts";
import {
  domains,
  problems,
  trainingProblems,
  trainings,
} from "../../../../shared/db/schema.ts";
import {
  assertWorkspacePermission,
  loadWorkspace,
} from "../../../access/contracts/cross-module/workspace_services_access.ts";
import { workspaceAudit } from "../../../access/contracts/cross-module/workspace_services_domains.ts";
import { lockActiveWorkspaceAccount } from "../../../access/contracts/cross-module/workspace_services_account-lifecycle.ts";

/** 跨域题单复制：独立复制有序集合和题目，整个集合在一个事务中发布。 */
export async function copyDomainTraining(
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
  // 源域要求管理题单的能力；创建者身份不再额外授予或取消权限。
  const sourceAccess = await loadWorkspace(source.domain.slug, actorId, {
    write: true,
  });
  assertWorkspacePermission(sourceAccess.context, "training:write_any");
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
      // 与题目复制一致：账号锁先于域锁，多个域按 ID 排序，避免与成员治理
      // 和账号注销形成反向等待。
      await lockActiveWorkspaceAccount(tx, actorId);
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
      assertWorkspacePermission(currentSource.context, "training:write_any");
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
