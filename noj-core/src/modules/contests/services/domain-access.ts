import { and, eq, or } from "drizzle-orm";
import { getDb } from "../../../shared/db/connection.ts";
import type { Executor } from "../../../shared/db/executor.ts";
import { contests } from "../../../shared/db/schema.ts";
import { ForbiddenError, NotFoundError } from "../../../shared/base/errors.ts";
import {
  assertWorkspacePermission,
  loadWorkspace,
  workspaceAudit,
} from "../../../domains/workspace/index.ts";
import { isParticipant } from "./contests.ts";

/** 先解析域，再解析比赛 ID；有效 ID 不能绕过路径域及当前成员关系。 */
export async function loadDomainContest(
  slug: string,
  reference: string,
  actorId: string | null,
  options: {
    write?: boolean;
    manage?: boolean;
    executor?: Executor;
    lock?: boolean;
    joining?: boolean;
  } = {},
) {
  const db = options.executor ?? getDb();
  const workspace = await loadWorkspace(slug, actorId, {
    executor: db,
    write: options.write,
    lock: options.write ? "share" : undefined,
  });
  const query = db.select().from(contests).where(and(
    eq(contests.domain_id, workspace.domain.id),
    or(eq(contests.id, reference), eq(contests.public_id, reference)),
  ));
  const [contest] = options.lock ? await query.for("update") : await query;
  if (!contest) throw new NotFoundError("竞赛不存在");
  const organizer = workspace.platformAdmin ||
    workspace.context.domainPermissions.has("contest:manage") ||
    actorId === contest.created_by &&
      workspace.context.domainPermissions.has("contest:manage_own");
  const registered = actorId !== null &&
    (workspace.membership !== null || workspace.platformAdmin) &&
    await isParticipant(contest.id, actorId, db);
  if (!contest.is_public && !organizer && !registered && !options.joining) {
    throw new NotFoundError("竞赛不存在");
  }
  if (options.manage && !organizer) {
    throw new ForbiddenError("仅比赛组织者可以操作");
  }
  if (options.write && !organizer) {
    assertWorkspacePermission(workspace.context, "contest:participate");
  }
  if (workspace.platformAdmin && actorId) {
    await workspaceAudit(db, actorId, workspace.domain.id, "domain.update", {
      operation: options.manage
        ? "contest.manage_access"
        : "contest.read_access",
      contest_id: contest.id,
    });
  }
  return { ...workspace, contest, organizer, registered };
}
