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
