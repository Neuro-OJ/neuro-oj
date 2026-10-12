import { and, eq, isNull } from "drizzle-orm";
import {
  ForbiddenError,
  NotFoundError,
} from "../../../../shared/base/errors.ts";
import { getDb } from "../../../../shared/db/connection.ts";
import type { Executor } from "../../../../shared/db/executor.ts";
import {
  domainProblemBindings,
  problems,
} from "../../../../shared/db/schema.ts";
import {
  assertWorkspacePermission,
  loadWorkspace,
  lockActiveWorkspaceAccount,
} from "../../../workspace/index.ts";
import type { ProblemDraftContent } from "../../types/problem-content.ts";
import { getProblemDraft, saveProblemDraft } from "../versioning/draft.ts";
import { parseDomainProblemReference } from "./problem-reference.ts";
import type { Context } from "hono";
import { publishProblemVersion } from "../versioning/publish.ts";

/** 域题库管理只能编辑本域源题；来源引用不授予源域编辑权限。 */
export async function loadEditableDomainProblem(
  slug: string,
  reference: string,
  actorId: string,
  options: { executor?: Executor; write?: boolean } = {},
) {
  const executor = options.executor ?? getDb();
  if (options.write) await lockActiveWorkspaceAccount(executor, actorId);
  const workspace = await loadWorkspace(slug, actorId, {
    executor,
    write: options.write,
    lock: options.write,
  });
  const parsed = parseDomainProblemReference(reference);
  if (parsed.sourceSlug && parsed.sourceSlug !== slug) {
    throw new NotFoundError("此域不能编辑来源题");
  }
  const [row] = await executor.select({
    problem: problems,
    binding: domainProblemBindings,
  }).from(problems)
    .innerJoin(
      domainProblemBindings,
      and(
        eq(domainProblemBindings.problem_id, problems.id),
        eq(domainProblemBindings.domain_id, workspace.domain.id),
      ),
    )
    .where(
      and(
        eq(problems.domain_id, workspace.domain.id),
        eq(problems.number, parsed.number),
        eq(domainProblemBindings.kind, "owned"),
        isNull(domainProblemBindings.disabled_at),
      ),
    );
  if (!row) throw new NotFoundError("本域题目不存在");
  if (
    !workspace.platformAdmin &&
    !workspace.context.domainPermissions.has("problem:write_any") &&
    !(row.problem.owner_id === actorId &&
      workspace.context.domainPermissions.has("problem:write_own"))
  ) {
    throw new ForbiddenError("无权编辑此域题目", "DOMAIN_PERMISSION_DENIED");
  }
  return { ...workspace, ...row };
}

/** 编辑者可读取未发布的共享草稿，不复用普通题面公开条件。 */
export async function readDomainProblemDraft(
  slug: string,
  reference: string,
  actorId: string,
) {
  const resource = await loadEditableDomainProblem(slug, reference, actorId);
  return await getProblemDraft(resource.problem.id, resource.problem);
}

/** 域授权与草稿 revision 写入在同一事务，撤权不会在检查后继续保存。 */
export async function saveDomainProblemDraft(
  slug: string,
  reference: string,
  actorId: string,
  content: ProblemDraftContent,
  expectedRevision: number | null,
  context?: Context,
) {
  return await getDb().transaction(async (tx) => {
    const resource = await loadEditableDomainProblem(slug, reference, actorId, {
      executor: tx,
      write: true,
    });
    return await saveProblemDraft(resource.problem.id, {
      content,
      expectedRevision,
      actorId,
      context,
    }, tx);
  });
}

/** 发布复用既有不可变版本流程，事务内确认当前域和编辑关系。 */
export async function publishDomainProblemVersion(
  slug: string,
  reference: string,
  actorId: string,
  expectedRevision: number,
  changeNote: string,
  context?: Context,
) {
  const resource = await loadEditableDomainProblem(slug, reference, actorId);
  assertWorkspacePermission(resource.context, "problem:publish");
  return await publishProblemVersion(resource.problem.id, {
    expectedRevision,
    changeNote,
    actorId,
    context,
    authorize: async (tx) => {
      const current = await loadEditableDomainProblem(
        slug,
        reference,
        actorId,
        { executor: tx, write: true },
      );
      assertWorkspacePermission(current.context, "problem:publish");
    },
  });
}
