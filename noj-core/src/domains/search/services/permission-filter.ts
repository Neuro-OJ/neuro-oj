import { sql } from "drizzle-orm";
import { searchEntries } from "../../../shared/db/schema.ts";

export interface SearchPermissionContext {
  userId?: string;
  isAdmin: boolean;
  guestReadEnabled: boolean;
  /** 社区功能是否可用；缺省视为可用，避免未传该字段的测试/调用方行为变化。 */
  communityEnabled?: boolean;
}

export function permissionWhere(ctx: SearchPermissionContext) {
  const userId = ctx.userId ?? "";
  return sql`(
    ${searchEntries.is_public} = true
    OR ${searchEntries.owner_id} = ${userId}
    OR ${userId} = ANY(${searchEntries.participant_ids})
    OR ${ctx.isAdmin} = true
  ) AND (${searchEntries.admin_only} = false OR ${ctx.isAdmin} = true)
  AND (
    ${searchEntries.entity_type} <> 'message'
    OR ${userId} = ''
    OR NOT (${userId} = ANY(${searchEntries.deleted_by_user_ids}))
  )`;
}

export function communityVisibilityWhere(ctx: SearchPermissionContext) {
  if (
    !ctx.userId && !ctx.guestReadEnabled ||
    ctx.communityEnabled === false
  ) {
    return sql`${searchEntries.entity_type} NOT IN ('community_post', 'community_comment')`;
  }
  return sql`true`;
}

/**
 * 赛期题解门控：排除「所属题目正在进行竞赛」的题解搜索条目。
 *
 * 自包含 SQL（不依赖调用方传入题目集合），时间窗口在 SQL 内实时比较，
 * 竞赛结束后自动放行、无需重建索引或调度任务。
 *
 * 依赖 `search_entries.metadata` 中的 `post_type` / `problem_id`
 * （由 index-writer 的 `buildCommunityPostEntry` 写入，无需重建索引）。
 * 非管理员一律受限，与社区读路径门控口径一致。
 */
export function runningContestSolutionWhere(ctx: SearchPermissionContext) {
  if (ctx.isAdmin) return sql`true`;
  return sql`NOT (
    ${searchEntries.entity_type} = 'community_post'
    AND ${searchEntries.metadata}->>'post_type' = 'solution'
    AND ${searchEntries.metadata}->>'problem_id' IN (
      SELECT cp.problem_id FROM contest_problems cp
      JOIN contests c ON c.id = cp.contest_id
      WHERE c.start_time <= to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
        AND c.end_time > to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
    )
  )`;
}
