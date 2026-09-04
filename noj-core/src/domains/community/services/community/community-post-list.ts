import { and, desc, eq, ilike, inArray, lt, ne, or, sql } from "drizzle-orm";
import { getDb } from "./../../../../shared/db/connection.ts";
import {
  communityBookmarks,
  communityPosts,
  users,
} from "./../../../../shared/db/schema.ts";
import type { CommunityPostType } from "./../../types/community.ts";
import {
  assertCommunityEnabled,
  getCommunityConfig,
} from "./community-config.ts";
import { resolveProblemId } from "./community-post-common.ts";
import {
  authorProjection,
  postStatsProjection,
} from "./community-post-select.ts";

/**
 * 列出社区帖子（支持按类型、题目、板块、作者、关键词筛选与游标分页）。
 * 未指定类型时仅返回启用模块的内容；审核员可查看 pending/hidden（已删除除外）。
 * @param options 查询选项：type、problemId、boardId、authorId、query、cursor、limit、viewerId、moderator。
 * @returns 分页结果：data 为帖子列表，next_cursor 为下一页游标（无更多时为 null）。
 */
export async function listPosts(
  options: {
    type?: CommunityPostType;
    problemId?: string;
    boardId?: string;
    authorId?: string;
    query?: string;
    cursor?: string;
    limit?: number;
    viewerId?: string;
    moderator?: boolean;
  },
) {
  const db = getDb();
  const conditions = [];
  if (options.type) conditions.push(eq(communityPosts.type, options.type));
  // 未指定类型时仅返回启用模块的内容；审核员查询不受模块开关限制（需审核历史内容）
  if (!options.type && !options.moderator) {
    const enabledTypes: CommunityPostType[] = [];
    const config = getCommunityConfig();
    if (config.solutions_enabled) enabledTypes.push("solution");
    if (config.discussions_enabled) enabledTypes.push("discussion");
    if (config.moments_enabled) enabledTypes.push("moment");
    if (enabledTypes.length > 0) {
      conditions.push(inArray(communityPosts.type, enabledTypes));
    } else {
      conditions.push(sql`false`);
    }
  }
  if (options.problemId) {
    // 支持 UUID / display_id（P1001）/ 纯数字引用，题目不存在时返回空结果
    const resolvedProblemId = await resolveProblemId(options.problemId);
    if (resolvedProblemId) {
      conditions.push(eq(communityPosts.problem_id, resolvedProblemId));
    } else {
      conditions.push(sql`false`);
    }
  }
  if (options.boardId) {
    conditions.push(eq(communityPosts.board_id, options.boardId));
  }
  if (options.authorId) {
    conditions.push(eq(communityPosts.author_id, options.authorId));
  }
  if (options.query) {
    const keyword = `%${options.query}%`;
    conditions.push(or(
      ilike(communityPosts.title, keyword),
      ilike(communityPosts.content, keyword),
    ));
  }
  if (!options.moderator) {
    conditions.push(eq(communityPosts.status, "published"));
  } else {
    // moderator 跳过 published 过滤以看到 pending/hidden（管理后台审核用），
    // 但已删除内容仍应在任何列表中隐藏，避免删除后仍出现在社区主页。
    conditions.push(ne(communityPosts.status, "deleted"));
  }
  if (options.cursor) {
    conditions.push(lt(communityPosts.created_at, options.cursor));
    // 置顶帖只出现在第一页，避免游标分页时在每页顶部重复
    conditions.push(eq(communityPosts.is_pinned, false));
  }
  const limit = Math.min(Math.max(options.limit ?? 20, 1), 100);
  const rows = await db.select({
    post: communityPosts,
    author: authorProjection,
    ...postStatsProjection,
  }).from(communityPosts).innerJoin(
    users,
    eq(users.id, communityPosts.author_id),
  ).where(and(...conditions)).orderBy(
    desc(communityPosts.is_pinned),
    desc(communityPosts.created_at),
  ).limit(limit + 1);
  const hasMore = rows.length > limit;
  const data = hasMore ? rows.slice(0, limit) : rows;
  return {
    data,
    next_cursor: hasMore ? data.at(-1)?.post.created_at ?? null : null,
  };
}

/** 统计各类型已发布帖子的数量，供社区首页 Tab 计数。 */
export async function countPostsByType(): Promise<
  Record<CommunityPostType, number>
> {
  assertCommunityEnabled();
  const db = getDb();
  const config = getCommunityConfig();
  const enabledTypes: CommunityPostType[] = [];
  if (config.solutions_enabled) enabledTypes.push("solution");
  if (config.discussions_enabled) enabledTypes.push("discussion");
  if (config.moments_enabled) enabledTypes.push("moment");
  const result: Record<CommunityPostType, number> = {
    solution: 0,
    discussion: 0,
    moment: 0,
  };
  // 全部模块关闭时直接返回全零，避免空 IN 列表的 SQL 错误
  if (enabledTypes.length === 0) return result;
  const rows = await db.select({
    type: communityPosts.type,
    count: sql<number>`count(*)::int`,
  }).from(communityPosts).where(and(
    eq(communityPosts.status, "published"),
    inArray(communityPosts.type, enabledTypes),
  )).groupBy(communityPosts.type);
  for (const row of rows) {
    result[row.type as CommunityPostType] = Number(row.count);
  }
  return result;
}

/** 列出用户收藏且仍可见的帖子。 */
export async function listBookmarks(
  userId: string,
  cursor?: string,
  requestedLimit?: number,
) {
  assertCommunityEnabled("bookmarks_enabled");
  const conditions = [
    eq(communityBookmarks.user_id, userId),
    eq(communityPosts.status, "published"),
  ];
  if (cursor) conditions.push(lt(communityBookmarks.created_at, cursor));
  const limit = Math.min(Math.max(requestedLimit ?? 20, 1), 100);
  const rows = await getDb().select({
    post: communityPosts,
    author: authorProjection,
    bookmarked_at: communityBookmarks.created_at,
    ...postStatsProjection,
  }).from(communityBookmarks).innerJoin(
    communityPosts,
    eq(communityPosts.id, communityBookmarks.post_id),
  ).innerJoin(
    users,
    eq(users.id, communityPosts.author_id),
  ).where(and(...conditions)).orderBy(
    desc(communityBookmarks.created_at),
  ).limit(limit + 1);
  const hasMore = rows.length > limit;
  const data = hasMore ? rows.slice(0, limit) : rows;
  return {
    data,
    next_cursor: hasMore ? data.at(-1)?.bookmarked_at ?? null : null,
  };
}
