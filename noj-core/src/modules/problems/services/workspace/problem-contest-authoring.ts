import { sql } from "drizzle-orm";
import type { AnyColumn, SQL } from "drizzle-orm";
import { ForbiddenError } from "../../../../shared/base/errors.ts";
import type { Executor } from "../../../../shared/db/executor.ts";
import { unwrapFirstRow } from "../../../../shared/base/sql-rows.ts";
import {
  DEFAULT_DOMAIN_ID,
  type loadWorkspace,
} from "../../../../domains/workspace/index.ts";
import { runningWindowCondition } from "../../../access/contest-policy.ts";

/** 列表与详情共用同一赛中维护限制，列表在一条查询中计算，避免逐题身份加载。 */
export function problemAuthoringRestrictionSql(
  workspace: Awaited<ReturnType<typeof loadWorkspace>>,
  problemId: string | AnyColumn | SQL,
): SQL {
  const actorId = workspace.context.actorId;
  if (
    !actorId || workspace.platformAdmin ||
    workspace.context.domainPermissions.has("contest:manage")
  ) return sql`false`;
  return sql`EXISTS (
    SELECT 1 FROM contests c
    JOIN contest_problems cp ON cp.contest_id = c.id
    JOIN contest_participants participant ON participant.contest_id = c.id
    WHERE cp.problem_id = ${problemId} AND participant.user_id = ${actorId}
      AND COALESCE(c.domain_id, ${DEFAULT_DOMAIN_ID}) = ${workspace.domain.id}
      AND ${runningWindowCondition(sql`c.start_time`, sql`c.end_time`)}
      ${
    workspace.context.domainPermissions.has("contest:manage_own")
      ? sql`AND c.created_by <> ${actorId}`
      : sql``
  }
  )`;
}

/** 参赛维护者不自动获得比赛组织权限；限制只作用于比赛的使用域。 */
export async function problemAuthoringRestrictedByContest(
  workspace: Awaited<ReturnType<typeof loadWorkspace>>,
  problemId: string,
  executor: Executor,
) {
  const row = unwrapFirstRow<{ restricted: boolean }>(
    await executor.execute(
      sql`SELECT ${
        problemAuthoringRestrictionSql(workspace, problemId)
      } AS restricted`,
    ) as never,
  )!;
  return row.restricted;
}

/** 赛中暂停参赛者的数据／草稿管理入口，结束后无需后台任务即可恢复。 */
export async function assertProblemAuthoringOutsideParticipation(
  workspace: Awaited<ReturnType<typeof loadWorkspace>>,
  problemId: string,
  executor: Executor,
) {
  if (
    await problemAuthoringRestrictedByContest(workspace, problemId, executor)
  ) {
    throw new ForbiddenError(
      "正在参加包含此题的比赛，比赛结束前不能访问题目管理内容",
      "CONTEST_AUTHORING_RESTRICTED",
    );
  }
}
