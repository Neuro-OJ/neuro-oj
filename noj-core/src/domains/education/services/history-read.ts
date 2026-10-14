import { and, count, desc, eq, sql } from "drizzle-orm";
import { getDb } from "../../../shared/db/connection.ts";
import {
  assignmentItemHistory,
  assignmentItems,
  domains,
  problems,
  problemVersions,
  users,
} from "../../../shared/db/schema.ts";
import { BadRequestError } from "../../../shared/base/errors.ts";
import { loadAssignment } from "./assignment-access.ts";
import { workspaceAudit } from "../../workspace/index.ts";

/** 作业变化历史保留策略依据，源题撤销后也不返回题面、评测配置或数据路径。 */
export async function getAssignmentHistory(
  slug: string,
  id: string,
  actorId: string,
  page = 1,
) {
  if (!Number.isSafeInteger(page) || page < 1 || page > 100000) {
    throw new BadRequestError("沿革分页格式错误");
  }
  const access = await loadAssignment(slug, id, actorId), db = getDb();
  const where = and(
    eq(assignmentItems.assignment_id, id),
    eq(assignmentItemHistory.domain_id, access.domain.id),
  );
  const [total] = await db.select({ count: count() }).from(
    assignmentItemHistory,
  )
    .innerJoin(
      assignmentItems,
      eq(assignmentItems.id, assignmentItemHistory.item_id),
    ).where(where);
  const rows = await db.select({
    id: assignmentItemHistory.id,
    item_id: assignmentItemHistory.item_id,
    answer_version_id: assignmentItemHistory.answer_version_id,
    answer_version: problemVersions.version,
    policy_mode: assignmentItemHistory.policy_mode,
    required_version_id: assignmentItemHistory.required_version_id,
    policy_revision: assignmentItemHistory.policy_revision,
    reason: assignmentItemHistory.reason,
    created_at: assignmentItemHistory.created_at,
    actor_name: sql<
      string
    >`CASE WHEN ${users.deleted_at} IS NOT NULL THEN '已注销账号' WHEN ${users.id} IS NULL THEN '系统' ELSE ${users.username} END`,
    display_ref: sql<
      string
    >`CASE WHEN ${domains.id} = ${access.domain.id} THEN ${problems.number}::text ELSE ${domains.slug} || ':' || ${problems.number}::text END`,
  })
    .from(assignmentItemHistory).innerJoin(
      assignmentItems,
      eq(assignmentItems.id, assignmentItemHistory.item_id),
    )
    .innerJoin(problems, eq(problems.id, assignmentItemHistory.problem_id))
    .innerJoin(domains, eq(domains.id, problems.domain_id))
    .leftJoin(
      problemVersions,
      eq(problemVersions.id, assignmentItemHistory.answer_version_id),
    )
    .leftJoin(users, eq(users.id, assignmentItemHistory.actor_id)).where(where)
    .orderBy(
      desc(assignmentItemHistory.created_at),
      desc(assignmentItemHistory.policy_revision),
      assignmentItemHistory.id,
    ).limit(50).offset((page - 1) * 50);
  if (access.platformAdmin) {
    await workspaceAudit(db, actorId, access.domain.id, "domain.update", {
      operation: "assignment.history.read",
      assignment_id: id,
    });
  }
  return { page, per_page: 50, total: total.count, data: rows };
}
