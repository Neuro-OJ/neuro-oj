import { sql } from "drizzle-orm";
import { searchEntries } from "../../../shared/db/schema.ts";
import { unendedPublicContestForProblem } from "../../contest/index.ts";
import { DEFAULT_DOMAIN_ID } from "../../workspace/index.ts";
import {
  domainProblemAvailableWhere,
  domainProblemBindingAvailableWhere,
} from "../../catalog/index.ts";
import { currentTeacherSubmissionAccessWhere } from "../../education/index.ts";
import { submissionQueryVisibility } from "../../query/index.ts";

export interface SearchPermissionContext {
  userId?: string;
  isAdmin: boolean;
  guestReadEnabled: boolean;
  /** 社区功能是否可用；缺省视为可用，避免未传该字段的测试/调用方行为变化。 */
  communityEnabled?: boolean;
  domainId?: string;
  member?: boolean;
  communityModerator?: boolean;
  problemWriteAny?: boolean;
  problemWriteOwn?: boolean;
  contestManageAny?: boolean;
  contestManageOwn?: boolean;
  submissionReadAll?: boolean;
  accountEntities?: boolean;
}

export function permissionWhere(ctx: SearchPermissionContext) {
  const userId = ctx.userId ?? "";
  return sql`(
    ${searchEntries.is_public} = true
    OR ${searchEntries.entity_type} IN ('problem','community_post','community_comment','contest','submission')
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
 * 公开赛题目条目隐藏（审计 VULN-07）：搜索不得成为题库列表隐藏的旁路。
 *
 * 判定复用 contest 域单一真相源谓词（`kind='public' AND now < end_time`，含赛前
 * 筹备期），作用于题目条目的 `entity_id`（题目条目把题目 id 存在 `entity_id`，
 * 而非 `metadata.problem_id`）。管理员与题目 owner 不受限（与题库列表口径一致）。
 *
 * `owner_id` 为 NULL 时比较结果为 NULL → 整行被排除：fail-closed（宁可搜索少一条，
 * 也不泄露赛题），与列表路径一致。
 */
export function contestSecrecyProblemWhere(ctx: SearchPermissionContext) {
  if (ctx.isAdmin || ctx.problemWriteAny) return sql`true`;
  const userId = ctx.userId ?? "";
  return sql`NOT (
    ${searchEntries.entity_type} = 'problem'
    AND ${
    unendedPublicContestForProblem(
      searchEntries.entity_id,
      sql`${ctx.domainId ?? DEFAULT_DOMAIN_ID}`,
    )
  }
    AND NOT (${
    ctx.domainId === undefined || ctx.problemWriteOwn === true
  } AND EXISTS (
      SELECT 1 FROM problems current_owner WHERE current_owner.id=${searchEntries.entity_id} AND current_owner.owner_id=${userId}))
  )`;
}

/**
 * 公开赛保密门控：排除「所属题目归属于尚未结束的公开赛」的**题解与讨论**搜索条目。
 *
 * 自包含 SQL（不依赖调用方传入题目集合），时间窗口在 SQL 内实时比较，
 * 竞赛结束后自动放行、无需重建索引或调度任务。
 *
 * 依赖 `search_entries.metadata` 中的 `post_type` / `problem_id`
 * （由 index-writer 的 `buildCommunityPostEntry` 写入，无需重建索引）。
 * 非管理员一律受限，与社区读路径门控口径一致。
 *
 * **2026-09-28 审计 VULN-02 修正**：口径由"进行中竞赛"改为"尚未结束的公开赛"
 * （含赛前筹备期），并覆盖 `discussion`（此前只门控 `solution`，讨论区搜索全量放行）。
 *
 * ## 为何同时覆盖 `community_comment`（2026-09-14 评审 High#5）
 *
 * 注释条目的 `body` 与 `metadata.post_title` 都携带**被评论帖子的标题**
 * （`index-writer.ts` 的 `buildCommunityCommentEntry`）。若只门控 `community_post`，
 * 赛期题解的标题仍会从评论条目泄露。此处按 `metadata->>'post_id'` **实时 join**
 * `community_posts`，而非依赖索引里新增字段——后者对存量索引行不生效，
 * 修复会在重建索引前形同虚设。
 *
 * `problem_id IS NOT NULL` 守卫同样必要：`NULL IN (...)` 求值为 NULL，
 * 使 `NOT (... AND NULL)` 整体为 NULL 而**永久排除**该行（对普通帖子是误杀）。
 */
export function notGatedContestContentWhere(ctx: SearchPermissionContext) {
  if (ctx.communityModerator ?? ctx.isAdmin) return sql`true`;
  return sql`NOT (
    (
      ${searchEntries.entity_type} = 'community_post'
      AND ${searchEntries.metadata}->>'post_type' IN ('solution', 'discussion')
      AND ${searchEntries.metadata}->>'problem_id' IS NOT NULL
      AND ${
    unendedPublicContestForProblem(
      sql`(${searchEntries.metadata}->>'problem_id')`,
      sql`${ctx.domainId ?? DEFAULT_DOMAIN_ID}`,
    )
  }
    )
    OR (
      ${searchEntries.entity_type} = 'community_comment'
      AND EXISTS (
        SELECT 1 FROM community_posts p
        WHERE p.id = ${searchEntries.metadata}->>'post_id'
          AND p.type IN ('solution', 'discussion')
          AND p.problem_id IS NOT NULL
          AND ${
    unendedPublicContestForProblem(
      sql`p.problem_id`,
      sql`${ctx.domainId ?? DEFAULT_DOMAIN_ID}`,
    )
  }
      )
    )
  )`;
}

/**
 * 兼容别名：{@link notGatedContestContentWhere} 的旧名。
 *
 * 保留旧名是因为既有调用点/测试在用；两者是同一实现的别名（无口径漂移风险）。
 */
export const runningContestSolutionWhere = notGatedContestContentWhere;

/** 索引只提供候选；实际域、成员、资源状态与授权必须在分页前读取源事实。 */
export function currentSearchResourceWhere(ctx: SearchPermissionContext) {
  const domainId = ctx.domainId ?? DEFAULT_DOMAIN_ID,
    userId = ctx.userId ?? "",
    member = ctx.member ?? false;
  const postVisible =
    sql`coalesce(search_post.domain_id,${DEFAULT_DOMAIN_ID})=${domainId}
    AND (search_post.status='published' OR (${
      ctx.communityModerator ?? ctx.isAdmin
    } AND search_post.status<>'deleted'))
    AND (search_post.problem_id IS NULL OR (search_post.domain_id IS NULL AND ${
      domainId === DEFAULT_DOMAIN_ID
    })
      OR ${
      domainProblemBindingAvailableWhere(
        sql`search_post.domain_problem_binding_id`,
        sql`${domainId}`,
        { member },
      )
    })`;
  return sql`CASE ${searchEntries.entity_type}
    WHEN 'problem' THEN ${
    domainProblemAvailableWhere(
      searchEntries.entity_id,
      sql`${domainId}`,
      { member },
    )
  }
    WHEN 'community_post' THEN EXISTS (SELECT 1 FROM community_posts search_post
      WHERE search_post.id=${searchEntries.entity_id} AND ${postVisible})
    WHEN 'community_comment' THEN EXISTS (SELECT 1 FROM community_comments comment
      JOIN community_posts search_post ON search_post.id=comment.post_id WHERE comment.id=${searchEntries.entity_id}
        AND coalesce(comment.domain_id,${DEFAULT_DOMAIN_ID})=${domainId} AND comment.status='published' AND ${postVisible})
    WHEN 'contest' THEN EXISTS (SELECT 1 FROM contests c WHERE c.id=${searchEntries.entity_id}
      AND coalesce(c.domain_id,${DEFAULT_DOMAIN_ID})=${domainId}
      AND (c.is_public OR ${ctx.isAdmin} OR ${ctx.contestManageAny ?? false}
        OR (${ctx.contestManageOwn ?? false} AND c.created_by=${userId})
        OR EXISTS (SELECT 1 FROM contest_participants participant WHERE participant.contest_id=c.id AND participant.user_id=${userId})))
    WHEN 'submission' THEN EXISTS (SELECT 1 FROM submissions s WHERE s.id=${searchEntries.entity_id}
      AND ${
    submissionQueryVisibility({ domainId, member }, {
      domainId: sql`s.domain_id`,
      bindingId: sql`s.domain_problem_binding_id`,
      contestId: sql`s.contest_id`,
    })
  }
      AND (s.user_id=${userId} OR ${ctx.isAdmin} OR ${
    ctx.submissionReadAll ?? false
  }
        OR ${
    currentTeacherSubmissionAccessWhere(
      sql`s.user_id`,
      sql`${domainId}`,
      userId,
    )
  }))
    WHEN 'message' THEN ${
    ctx.accountEntities ?? ctx.domainId === undefined
  } AND EXISTS (
      SELECT 1 FROM messages m JOIN conversations c ON c.id=m.conversation_id
      WHERE m.id=${searchEntries.entity_id} AND m.recalled_at IS NULL
        AND NOT EXISTS (SELECT 1 FROM message_deletions deletion WHERE deletion.message_id=m.id AND deletion.user_id=${userId})
        AND (c.user1_id=${userId} OR c.user2_id=${userId}))
    WHEN 'user' THEN ${
    ctx.accountEntities ?? ctx.domainId === undefined
  } AND ${ctx.isAdmin}
      AND EXISTS (SELECT 1 FROM users u WHERE u.id=${searchEntries.entity_id} AND u.deleted_at IS NULL)
    WHEN 'announcement' THEN EXISTS (SELECT 1 FROM announcements a WHERE a.id=${searchEntries.entity_id} AND a.is_active)
    ELSE false END`;
}
