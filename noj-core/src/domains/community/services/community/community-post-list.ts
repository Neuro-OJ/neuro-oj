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
import { notGatedSolution, resolveProblemId } from "./community-post-common.ts";
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
  const cursorParts = options.cursor ? parsePostCursor(options.cursor) : null;
  if (cursorParts) {
    // 复合游标 `created_at|id`：仅按 created_at 比较时，同 created_at 的多条会在
    // 页边界被**静默丢失**（`<` 严格小于会跳过整批同刻条目）。id 作为并列时的
    // 决胜键，与 orderBy 的 created_at DESC 配对使用。
    conditions.push(
      cursorParts.id
        ? sql`(${communityPosts.created_at} < ${cursorParts.at}
            OR (${communityPosts.created_at} = ${cursorParts.at}
                AND ${communityPosts.id} < ${cursorParts.id}))`
        : lt(communityPosts.created_at, cursorParts.at),
    );
    // 置顶帖与官方题解只出现在第一页，避免游标分页时在每页顶部重复。
    // 排序键是 (is_official, is_pinned, created_at)，而游标只沿 created_at 推进，
    // 故**所有**非 created_at 的排序键都必须在此排除，否则该行会在每一页重复
    // （2026-09-14 评审：此前只排除了 is_pinned，导致官方题解每页复现）。
    conditions.push(eq(communityPosts.is_pinned, false));
    conditions.push(eq(communityPosts.is_official, false));
  }
  // 赛期题解门控：进行中竞赛的题目，其题解对普通用户整体不可见（设计 spec §6.2）
  if (!options.moderator) conditions.push(notGatedSolution());
  const limit = Math.min(Math.max(options.limit ?? 20, 1), 100);
  const rows = await db.select({
    post: communityPosts,
    author: authorProjection,
    ...postStatsProjection,
  }).from(communityPosts).innerJoin(
    users,
    eq(users.id, communityPosts.author_id),
  ).where(and(...conditions)).orderBy(
    // 官方题解置顶（题解质量优先于普通置顶与时间）
    desc(communityPosts.is_official),
    desc(communityPosts.is_pinned),
    desc(communityPosts.created_at),
    // id 决胜键：created_at 相同的多条若无稳定次序，游标分页会在页边界
    // 丢条目/重复条目（SQL 不保证同键行的返回顺序）。与 next_cursor 的
    // `created_at|id` 复合游标必须成对存在，否则游标比较与排序不一致。
    desc(communityPosts.id),
  ).limit(limit + 1);
  const hasMore = rows.length > limit;
  const data = hasMore ? rows.slice(0, limit) : rows;
  const last = data.at(-1)?.post;
  return {
    data,
    // 复合游标 `created_at|id`，与 listFeed 口径一致（后者早已用复合游标，
    // 本函数此前只用 created_at，导致同刻条目跨页丢失）
    next_cursor: hasMore && last ? `${last.created_at}|${last.id}` : null,
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
    // 被门控的题解不计入 Tab 计数（否则计数与列表不一致，暴露题解存在性）
    notGatedSolution(),
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
    // 收藏列表同受门控：赛期不展示被门控的题解
    notGatedSolution(),
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

/**
 * 解析帖子列表游标。
 *
 * 支持两种形态，保证向后兼容：
 * - 复合 `created_at|id`（当前输出）；
 * - 纯 `created_at`（历史客户端可能缓存了旧游标，或第三方直接调用 API）。
 *
 * `id` 可能含 `-`（UUID），但不含 `|`，故用 `lastIndexOf` 切分是安全的
 * （与 `community-feed.ts` 的 `parseFeedCursor` 同一约定）。
 */
function parsePostCursor(cursor: string): { at: string; id?: string } {
  const sep = cursor.lastIndexOf("|");
  if (sep === -1) return { at: cursor };
  return { at: cursor.slice(0, sep), id: cursor.slice(sep + 1) };
}
