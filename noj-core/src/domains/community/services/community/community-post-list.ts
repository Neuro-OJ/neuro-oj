import {
  and,
  desc,
  eq,
  ilike,
  inArray,
  lt,
  ne,
  or,
  type SQL,
  sql,
} from "drizzle-orm";
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
  // 元素可能为 undefined（drizzle 的 or/and 允许），and(...) 会自行忽略
  const conditions: (SQL | undefined)[] = [];
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
  // 赛期题解门控：进行中竞赛的题目，其题解对普通用户整体不可见（设计 spec §6.2）
  if (!options.moderator) conditions.push(notGatedSolution());
  const limit = Math.min(Math.max(options.limit ?? 20, 1), 100);
  const cursorParts = options.cursor ? parsePostCursor(options.cursor) : null;

  // ── 两段式 keyset 分页：固定置顶区 + 普通帖区 ──
  //
  // 排序键含 is_official / is_pinned，而游标此前只沿 created_at 推进。若第一页
  // 被置顶/官方帖填满，第二页仍以"置顶帖的最后时间"过滤且强制 is_pinned=false，
  // 就会跳过其后**时间更近的普通帖**——它们永远不会出现在任何一页（评审 #4）。
  // 修复：把排序**阶段**编进游标，两个阶段各用与自身排序一致的复合 keyset；
  // 从置顶段跨入普通段时，普通段从头开始（不带普通段游标）。
  const promotedCondition = or(
    eq(communityPosts.is_pinned, true),
    eq(communityPosts.is_official, true),
  )!;
  const normalCondition = and(
    eq(communityPosts.is_pinned, false),
    eq(communityPosts.is_official, false),
  )!;
  const pinnedOrder = [
    // 官方题解置顶（题解质量优先于普通置顶与时间）
    desc(communityPosts.is_official),
    desc(communityPosts.is_pinned),
    desc(communityPosts.created_at),
    // id 决胜键：created_at 相同的多条若无稳定次序，游标分页会在页边界
    // 丢条目/重复条目（SQL 不保证同键行的返回顺序）。与 next_cursor 编码的
    // 复合 keyset 必须成对存在，否则游标比较与排序不一致。
    desc(communityPosts.id),
  ];
  const normalOrder = [
    desc(communityPosts.created_at),
    desc(communityPosts.id),
  ];
  // async 而非直接返回 builder：让返回类型是真正的 Promise<Row[]>，
  // `Awaited<ReturnType<...>>` 才能正确取到行数组类型（builder 是 thenable）。
  const fetchRows = async (
    phaseCondition: SQL,
    cursorCondition: SQL | null,
    order: SQL[],
    take: number,
  ) =>
    await db.select({
      post: communityPosts,
      author: authorProjection,
      ...postStatsProjection,
    }).from(communityPosts).innerJoin(
      users,
      eq(users.id, communityPosts.author_id),
    ).where(and(
      ...conditions,
      phaseCondition,
      ...(cursorCondition ? [cursorCondition] : []),
    )).orderBy(...order).limit(take);

  const phase: PostSortPhase = cursorParts?.phase ?? "pinned";
  const collected: Awaited<ReturnType<typeof fetchRows>> = [];
  let pinnedFetched = 0;
  if (phase === "pinned") {
    const rows = await fetchRows(
      promotedCondition,
      cursorParts?.phase === "pinned"
        ? pinnedKeysetCondition(cursorParts)
        : null,
      pinnedOrder,
      limit + 1,
    );
    pinnedFetched = rows.length;
    collected.push(...rows);
  }
  // 置顶段未填满本页 → 用普通段补齐（从普通段头部开始，除非游标本就在普通段）
  if (collected.length <= limit) {
    const rows = await fetchRows(
      normalCondition,
      cursorParts?.phase === "normal"
        ? normalKeysetCondition(cursorParts)
        : null,
      normalOrder,
      limit + 1 - collected.length,
    );
    collected.push(...rows);
  }
  const hasMore = collected.length > limit;
  const data = hasMore ? collected.slice(0, limit) : collected;
  const last = data.at(-1)?.post;
  let next_cursor: string | null = null;
  if (hasMore && last) {
    // 本页最后一条落在哪个阶段，决定下一页从哪个阶段续取
    next_cursor = data.length - 1 < pinnedFetched
      ? formatPinnedCursor(last)
      : formatNormalCursor(last);
  }
  return { data, next_cursor };
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

/** 分页阶段：置顶/官方帖区（pinned）与普通帖区（normal）。 */
type PostSortPhase = "pinned" | "normal";

/** 解析后的帖子列表游标。 */
interface PostCursorParts {
  phase: PostSortPhase;
  at: string;
  id?: string;
  /** pinned 阶段专用：游标行的 is_official / is_pinned，构成四元组 keyset。 */
  is_official?: boolean;
  is_pinned?: boolean;
}

/**
 * 编码帖子列表游标，携带**排序阶段**与阶段内复合 keyset。
 *
 * - pinned：`p:<created_at>|<id>|<is_official>|<is_pinned>`（四元组，与
 *   `(is_official, is_pinned, created_at, id)` 排序严格配对）；
 * - normal：`n:<created_at>|<id>`（二元组）。
 *
 * 字段均不含 `|`（ISO 时间无、UUID 无、布尔编码为 0/1），故 `split("|")` 安全。
 */
function formatPinnedCursor(row: {
  created_at: string;
  id: string;
  is_official: boolean;
  is_pinned: boolean;
}): string {
  return `p:${row.created_at}|${row.id}|${row.is_official ? 1 : 0}|${
    row.is_pinned ? 1 : 0
  }`;
}

/** 编码普通帖区游标。 */
function formatNormalCursor(
  row: { created_at: string; id: string },
): string {
  return `n:${row.created_at}|${row.id}`;
}

/**
 * 解析帖子列表游标，保证向后兼容：
 * - 新形态 `p:...` / `n:...`（携带阶段）；
 * - 旧形态 `created_at|id` / 纯 `created_at`：旧实现一律排除置顶帖后再按
 *   `created_at` 推进，故游标指向的是**普通帖区**，这里映射为 normal 阶段。
 */
function parsePostCursor(cursor: string): PostCursorParts {
  if (cursor.startsWith("p:")) {
    const parts = cursor.slice(2).split("|");
    return {
      phase: "pinned",
      at: parts[0] ?? "",
      id: parts[1] || undefined,
      is_official: parts[2] === "1",
      is_pinned: parts[3] === "1",
    };
  }
  const body = cursor.startsWith("n:") ? cursor.slice(2) : cursor;
  const sep = body.lastIndexOf("|");
  if (sep === -1) return { phase: "normal", at: body };
  return { phase: "normal", at: body.slice(0, sep), id: body.slice(sep + 1) };
}

/**
 * pinned 阶段的 keyset 条件：`(is_official, is_pinned, created_at, id)`
 * **严格小于**游标行（四列同为 DESC，故行比较即"排在其后"）。
 *
 * 必须四列一起比较：只比 `created_at` 会漏掉同刻但排序靠后的置顶帖。
 */
function pinnedKeysetCondition(parts: PostCursorParts): SQL {
  if (!parts.id) return sql`${communityPosts.created_at} < ${parts.at}`;
  return sql`(${communityPosts.is_official}, ${communityPosts.is_pinned},
      ${communityPosts.created_at}, ${communityPosts.id})
    < (${parts.is_official ?? false}::boolean,
       ${parts.is_pinned ?? false}::boolean,
       ${parts.at}::text, ${parts.id}::text)`;
}

/** normal 阶段的 keyset 条件：`(created_at, id)` 严格小于游标行。 */
function normalKeysetCondition(parts: PostCursorParts): SQL {
  if (!parts.id) return sql`${communityPosts.created_at} < ${parts.at}`;
  return sql`(${communityPosts.created_at}, ${communityPosts.id})
    < (${parts.at}::text, ${parts.id}::text)`;
}
