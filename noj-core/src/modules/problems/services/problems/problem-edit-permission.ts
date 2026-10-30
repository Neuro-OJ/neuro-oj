import { eq } from "drizzle-orm";
import type { Context } from "hono";
import { getDb } from "../../../../shared/db/connection.ts";
import { domains, problems } from "../../../../shared/db/schema.ts";
import { NotFoundError } from "../../../../shared/base/errors.ts";
import { ROOT_USER_ID } from "../../../../shared/base/constants.ts";
import { DEFAULT_DOMAIN_SLUG } from "../../../../shared/workspace/types.ts";
import type { UserActor } from "../../../access/contracts/actor.ts";
import {
  assertWorkspacePermission,
  loadWorkspace,
} from "../../../access/contracts/cross-module/workspace_services_access.ts";
import { assertProblemAuthoringOutsideParticipation } from "../workspace/problem-contest-authoring.ts";

/**
 * 题目内容编辑权限（唯一判定入口）。
 *
 * 草稿读写、发布版本与既有 PUT 内容更新共用同一口径，避免"草稿接口是旁路"：
 * - 本域编辑者编辑本人资源需 `problem:write_own`；
 * - 编辑其他资源需源域 `problem:write_any`，平台治理使用真实实例权限。
 *
 * 平台治理例外取自实时实例权限。
 *
 * @throws {ForbiddenError} 权限不足
 */
export async function assertProblemEditPermission(
  c: Context | undefined,
  problem: { id: string; domain_id?: string | null; owner_id: string },
  userId?: string,
  _userRole?: string,
): Promise<void> {
  const actorId = c?.var.userId ?? userId ?? ROOT_USER_ID;
  const db = getDb();
  const [source] = await db.select().from(problems).where(
    eq(problems.id, problem.id),
  );
  if (!source) throw new NotFoundError("题目不存在");
  const [domain] = source.domain_id
    ? await db.select({ slug: domains.slug }).from(domains).where(
      eq(domains.id, source.domain_id),
    )
    : [{ slug: DEFAULT_DOMAIN_SLUG }];
  if (!domain) throw new NotFoundError("源题工作空间不存在");
  const workspace = await loadWorkspace(domain.slug, actorId, {
    write: c === undefined || !["GET", "HEAD"].includes(c.req.method),
  });
  assertWorkspacePermission(
    workspace.context,
    workspace.context.domainPermissions.has("problem:write_any") ||
      source.owner_id !== actorId
      ? "problem:write_any"
      : "problem:write_own",
  );
  await assertProblemAuthoringOutsideParticipation(workspace, source.id, db);
}

/** 应用用例专用授权入口；UserActor 是唯一用户身份来源。 */
export async function assertProblemEditPermissionForActor(
  problem: { id: string; domain_id?: string | null; owner_id: string },
  actor: UserActor,
): Promise<void> {
  await assertProblemEditPermission(undefined, problem, actor.userId);
}
