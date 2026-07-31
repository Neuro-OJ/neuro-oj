import {
  and,
  desc,
  eq,
  ilike,
  inArray,
  isNull,
  lt,
  or,
  sql,
} from "drizzle-orm";
import { getDb } from "../db/connection.ts";
import {
  communityActivityEvents,
  communityBoardRoleGrants,
  communityBoards,
  communityBookmarks,
  communityCommentLikes,
  communityComments,
  communityFollows,
  communityModerationActions,
  communityNotifications,
  communityPostLikes,
  communityPosts,
  communityReports,
  communitySanctions,
  evaluationResults,
  problems,
  submissions,
  userRoles,
  users,
} from "../db/schema.ts";
import {
  ConflictError,
  ForbiddenError,
  NotFoundError,
  ValidationError,
} from "../lib/errors.ts";
import { Channels, publishEvent } from "../lib/event-bus.ts";
import { logAudit } from "./audit-log.ts";
import { getSetting, updateSetting } from "./system-settings.ts";
import type {
  CommunityConfig,
  CommunityPostInput,
  CommunityPostStatus,
  CommunityPostType,
} from "../types/community.ts";

function now(): string {
  return new Date().toISOString();
}

function settingBoolean(key: string): boolean {
  return getSetting(key)?.value === true;
}

function settingNumber(key: string): number {
  const value = Number(getSetting(key)?.value);
  return Number.isFinite(value) ? value : 0;
}

export function getCommunityConfig(): CommunityConfig {
  return {
    enabled: settingBoolean("community_enabled"),
    guest_read_enabled: settingBoolean("community_guest_read_enabled"),
    read_only: settingBoolean("community_read_only"),
    solutions_enabled: settingBoolean("community_solutions_enabled"),
    discussions_enabled: settingBoolean("community_discussions_enabled"),
    moments_enabled: settingBoolean("community_moments_enabled"),
    activities_enabled: settingBoolean("community_activities_enabled"),
    comments_enabled: settingBoolean("community_comments_enabled"),
    reactions_enabled: settingBoolean("community_reactions_enabled"),
    bookmarks_enabled: settingBoolean("community_bookmarks_enabled"),
    follows_enabled: settingBoolean("community_follows_enabled"),
    private_messaging_enabled: settingBoolean("private_messaging_enabled"),
    external_images_enabled: settingBoolean(
      "community_external_images_enabled",
    ),
    solution_requires_accepted: settingBoolean(
      "community_solution_requires_accepted",
    ),
    new_user_review_hours: settingNumber("community_new_user_review_hours"),
    post_max_length: settingNumber("community_post_max_length"),
    moment_max_length: settingNumber("community_moment_max_length"),
    comment_max_length: settingNumber("community_comment_max_length"),
  };
}

export function assertCommunityEnabled(feature?: keyof CommunityConfig): void {
  const config = getCommunityConfig();
  if (!config.enabled || (feature && config[feature] === false)) {
    throw new ForbiddenError("该社区功能已关闭", "FEATURE_DISABLED");
  }
}

export async function assertCommunityWritable(
  userId: string,
  isModerator: boolean,
): Promise<void> {
  const config = getCommunityConfig();
  if (config.read_only && !isModerator) {
    throw new ForbiddenError("社区当前为只读模式", "COMMUNITY_READ_ONLY");
  }
  if (isModerator) return;
  const db = getDb();
  const rows = await db.select().from(communitySanctions).where(and(
    eq(communitySanctions.user_id, userId),
    isNull(communitySanctions.revoked_at),
  )).limit(1);
  const sanction = rows[0];
  if (sanction && (!sanction.expires_at || sanction.expires_at > now())) {
    throw new ForbiddenError("你已被限制社区互动", "COMMUNITY_SANCTIONED", {
      reason: sanction.reason,
      until: sanction.expires_at,
    });
  }
}

function featureForType(type: CommunityPostType): keyof CommunityConfig {
  return type === "solution"
    ? "solutions_enabled"
    : type === "discussion"
    ? "discussions_enabled"
    : "moments_enabled";
}

async function publicationStatus(
  authorId: string,
): Promise<CommunityPostStatus> {
  const reviewHours = getCommunityConfig().new_user_review_hours;
  if (reviewHours <= 0) return "published";
  const db = getDb();
  const row = await db.select({ created_at: users.created_at }).from(users)
    .where(eq(users.id, authorId)).limit(1);
  if (!row[0]) throw new NotFoundError("用户不存在");
  return Date.parse(row[0].created_at) + reviewHours * 3600_000 > Date.now()
    ? "pending"
    : "published";
}

/**
 * 解析题目引用为 problems.id（UUID）。
 * 支持 UUID、display_id（P1001 / U42）、纯数字（兼容旧 seed 数据 1001/1002/1003）。
 * 题目不存在时返回 null。
 */
async function resolveProblemId(reference: string): Promise<string | null> {
  const db = getDb();
  const uuidPattern =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (uuidPattern.test(reference)) {
    const row = await db.select({ id: problems.id }).from(problems)
      .where(eq(problems.id, reference)).limit(1);
    return row[0]?.id ?? null;
  }
  const match = reference.match(/^([UuPp])(\d+)$/);
  if (match) {
    const row = await db.select({ id: problems.id }).from(problems).where(and(
      eq(problems.type, match[1].toUpperCase()),
      eq(problems.number, parseInt(match[2], 10)),
    )).limit(1);
    return row[0]?.id ?? null;
  }
  // 纯数字：先按 PK 查找（旧 seed 数据 1001/1002/1003 以数字为 id），再按 type=P+number 兜底
  if (/^\d+$/.test(reference)) {
    const row = await db.select({ id: problems.id }).from(problems)
      .where(eq(problems.id, reference)).limit(1);
    if (row[0]) return row[0].id;
    const fallback = await db.select({ id: problems.id }).from(problems)
      .where(and(
        eq(problems.type, "P"),
        eq(problems.number, parseInt(reference, 10)),
      )).limit(1);
    return fallback[0]?.id ?? null;
  }
  const row = await db.select({ id: problems.id }).from(problems)
    .where(eq(problems.id, reference)).limit(1);
  return row[0]?.id ?? null;
}

async function ensureSolutionAccepted(
  authorId: string,
  problemId: string,
): Promise<void> {
  if (!getCommunityConfig().solution_requires_accepted) return;
  const db = getDb();
  const rows = await db.select({ id: submissions.id }).from(submissions)
    .innerJoin(
      evaluationResults,
      eq(evaluationResults.submission_id, submissions.id),
    )
    .where(and(
      eq(submissions.user_id, authorId),
      eq(submissions.problem_id, problemId),
      eq(evaluationResults.status, "Accepted"),
    )).limit(1);
  if (!rows[0]) {
    throw new ForbiddenError(
      "通过对应题目后才能发布题解",
      "SOLUTION_NOT_ACCEPTED",
    );
  }
}

export async function listBoards(includeArchived = false) {
  const db = getDb();
  return await db.select().from(communityBoards)
    .where(includeArchived ? undefined : eq(communityBoards.is_archived, false))
    .orderBy(communityBoards.sort_order, communityBoards.created_at);
}

export async function createBoard(
  input: {
    slug: string;
    name: string;
    description?: string;
    sort_order?: number;
  },
) {
  const db = getDb();
  const createdAt = now();
  const board = {
    id: crypto.randomUUID(),
    slug: input.slug,
    name: input.name,
    description: input.description ?? "",
    sort_order: input.sort_order ?? 0,
    is_archived: false,
    created_at: createdAt,
    updated_at: createdAt,
  };
  await db.insert(communityBoards).values(board);
  return board;
}

export async function updateBoard(
  id: string,
  input: Partial<
    {
      name: string;
      description: string;
      sort_order: number;
      is_archived: boolean;
    }
  >,
) {
  const db = getDb();
  const rows = await db.update(communityBoards).set({
    ...input,
    updated_at: now(),
  }).where(eq(communityBoards.id, id)).returning();
  if (!rows[0]) throw new NotFoundError("板块不存在");
  return rows[0];
}

export async function listBoardRoleGrants(boardId: string) {
  const db = getDb();
  return await db.select().from(communityBoardRoleGrants).where(
    eq(communityBoardRoleGrants.board_id, boardId),
  );
}

export async function updateBoardRoleGrant(
  boardId: string,
  roleId: string,
  input: { can_read?: boolean; can_post?: boolean; can_moderate?: boolean },
) {
  const db = getDb();
  await db.insert(communityBoardRoleGrants).values({
    board_id: boardId,
    role_id: roleId,
    can_read: input.can_read ?? true,
    can_post: input.can_post ?? false,
    can_moderate: input.can_moderate ?? false,
  }).onConflictDoUpdate({
    target: [
      communityBoardRoleGrants.board_id,
      communityBoardRoleGrants.role_id,
    ],
    set: input,
  });
  const rows = await db.select().from(communityBoardRoleGrants).where(and(
    eq(communityBoardRoleGrants.board_id, boardId),
    eq(communityBoardRoleGrants.role_id, roleId),
  )).limit(1);
  return rows[0]!;
}

export async function deleteBoardRoleGrant(boardId: string, roleId: string) {
  const db = getDb();
  await db.delete(communityBoardRoleGrants).where(and(
    eq(communityBoardRoleGrants.board_id, boardId),
    eq(communityBoardRoleGrants.role_id, roleId),
  ));
}

async function canPostToBoard(
  userId: string,
  boardId: string,
): Promise<boolean> {
  const db = getDb();
  const grants = await listBoardRoleGrants(boardId);
  if (grants.length === 0) return true;
  const roleRows = await db.select({ role_id: userRoles.role_id }).from(
    userRoles,
  )
    .where(eq(userRoles.user_id, userId));
  const roleIds = new Set(roleRows.map((row) => row.role_id));
  return grants.some((grant) => grant.can_post && roleIds.has(grant.role_id));
}

export async function createPost(
  authorId: string,
  input: CommunityPostInput,
  moderator = false,
): Promise<typeof communityPosts.$inferSelect> {
  assertCommunityEnabled(featureForType(input.type));
  const config = getCommunityConfig();
  const title = input.title?.trim() || undefined;
  const content = input.content.trim();
  if (!content) throw new ValidationError("内容不能为空");
  if (
    content.length >
      (input.type === "moment"
        ? config.moment_max_length
        : config.post_max_length)
  ) throw new ValidationError("内容超过长度限制");
  if (input.type === "moment" && title) {
    throw new ValidationError("短动态不能包含标题");
  }
  if (input.type !== "moment" && !title) {
    throw new ValidationError("标题不能为空");
  }
  if (input.type === "solution") {
    if (!input.problem_id) throw new ValidationError("题解必须关联题目");
    const resolvedProblemId = await resolveProblemId(input.problem_id);
    if (!resolvedProblemId) throw new ValidationError("题目不存在");
    await ensureSolutionAccepted(authorId, resolvedProblemId);
    input.problem_id = resolvedProblemId;
  }
  if (input.type === "discussion") {
    if (!input.board_id) throw new ValidationError("讨论必须选择板块");
    const db = getDb();
    const board = await db.select({
      id: communityBoards.id,
      is_archived: communityBoards.is_archived,
    }).from(communityBoards).where(eq(communityBoards.id, input.board_id))
      .limit(1);
    if (!board[0] || board[0].is_archived) {
      throw new ValidationError("板块不存在或已归档");
    }
    if (!moderator && !await canPostToBoard(authorId, input.board_id)) {
      throw new ForbiddenError("你没有在该板块发帖的权限");
    }
  }
  const createdAt = now();
  const status = await publicationStatus(authorId);
  const post = {
    id: crypto.randomUUID(),
    type: input.type,
    author_id: authorId,
    problem_id: input.type === "solution" ? input.problem_id! : null,
    board_id: input.type === "discussion" ? input.board_id! : null,
    title: title ?? null,
    content,
    status,
    is_locked: false,
    is_pinned: false,
    moderation_reason: null,
    published_at: status === "published" ? createdAt : null,
    created_at: createdAt,
    updated_at: createdAt,
  };
  const db = getDb();
  await db.insert(communityPosts).values(post);
  if (status === "published" && input.type === "solution") {
    await createActivity(authorId, "solution_published", "post", post.id, {
      problem_id: input.problem_id,
    });
  }
  return post;
}

export async function getPost(
  postId: string,
  viewerId?: string,
  moderator = false,
) {
  const db = getDb();
  const rows = await db.select({
    post: communityPosts,
    author: { id: users.id, username: users.username },
    problem_title: problems.title,
    likes: sql<
      number
    >`(select count(*) from community_post_likes where post_id = ${communityPosts.id})`,
    comments: sql<
      number
    >`(select count(*) from community_comments where post_id = ${communityPosts.id} and status = 'published')`,
    bookmarked: viewerId
      ? sql<
        boolean
      >`exists(select 1 from community_bookmarks where post_id = ${communityPosts.id} and user_id = ${viewerId})`
      : sql<boolean>`false`,
    liked: viewerId
      ? sql<
        boolean
      >`exists(select 1 from community_post_likes where post_id = ${communityPosts.id} and user_id = ${viewerId})`
      : sql<boolean>`false`,
  }).from(communityPosts).innerJoin(
    users,
    eq(users.id, communityPosts.author_id),
  ).leftJoin(problems, eq(problems.id, communityPosts.problem_id)).where(
    eq(communityPosts.id, postId),
  ).limit(1);
  const row = rows[0];
  if (!row) throw new NotFoundError("社区内容不存在");
  if (
    row.post.status !== "published" && row.post.author_id !== viewerId &&
    !moderator
  ) throw new NotFoundError("社区内容不存在");
  return row;
}

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
  }
  if (options.cursor) {
    conditions.push(lt(communityPosts.created_at, options.cursor));
    // 置顶帖只出现在第一页，避免游标分页时在每页顶部重复
    conditions.push(eq(communityPosts.is_pinned, false));
  }
  const limit = Math.min(Math.max(options.limit ?? 20, 1), 100);
  const rows = await db.select({
    post: communityPosts,
    author: { id: users.id, username: users.username },
    likes: sql<
      number
    >`(select count(*) from community_post_likes where post_id = ${communityPosts.id})`,
    comments: sql<
      number
    >`(select count(*) from community_comments where post_id = ${communityPosts.id} and status = 'published')`,
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
    author: { id: users.id, username: users.username },
    bookmarked_at: communityBookmarks.created_at,
    likes: sql<
      number
    >`(select count(*) from community_post_likes where post_id = ${communityPosts.id})`,
    comments: sql<
      number
    >`(select count(*) from community_comments where post_id = ${communityPosts.id} and status = 'published')`,
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

export async function updatePost(
  postId: string,
  actorId: string,
  moderator: boolean,
  input: Partial<Pick<CommunityPostInput, "title" | "content">>,
) {
  const current = await getPost(postId, actorId, moderator);
  if (current.post.author_id !== actorId && !moderator) {
    throw new ForbiddenError("无权编辑该内容");
  }
  if (current.post.status === "deleted") {
    throw new ValidationError("已删除内容不能编辑");
  }
  const content = input.content === undefined
    ? current.post.content
    : input.content.trim();
  const title = input.title === undefined
    ? current.post.title
    : input.title.trim();
  if (!content) throw new ValidationError("内容不能为空");
  // 编辑同样受长度限制约束，避免绕过 createPost 的校验
  const config = getCommunityConfig();
  const maxLength = current.post.type === "moment"
    ? config.moment_max_length
    : config.post_max_length;
  if (content.length > maxLength) throw new ValidationError("内容超过长度限制");
  if (title && title.length > 200) throw new ValidationError("标题过长");
  const db = getDb();
  const rows = await db.update(communityPosts).set({
    content,
    title: title || null,
    updated_at: now(),
  }).where(eq(communityPosts.id, postId)).returning();
  return rows[0]!;
}

export async function changePostStatus(
  postId: string,
  actorId: string,
  status: CommunityPostStatus,
  reason = "",
) {
  const db = getDb();
  const rows = await db.update(communityPosts).set({
    status,
    moderation_reason: reason || null,
    published_at: status === "published" ? now() : null,
    updated_at: now(),
  }).where(eq(communityPosts.id, postId)).returning();
  if (!rows[0]) throw new NotFoundError("社区内容不存在");
  await db.insert(communityModerationActions).values({
    id: crypto.randomUUID(),
    moderator_id: actorId,
    action: status,
    target_type: "post",
    target_id: postId,
    reason,
    metadata: {},
    created_at: now(),
  });
  if (rows[0].author_id !== actorId) {
    await createNotification(
      rows[0].author_id,
      actorId,
      "moderation",
      postId,
      null,
      { status, reason },
    );
  }
  // 作者自删与审核员处置在审计 detail 中区分，便于追溯删除性质
  const isSelfDelete = status === "deleted" && rows[0].author_id === actorId;
  await logAudit(
    "community.post_moderated",
    {
      action: "community.post_moderated",
      status,
      reason,
      self_delete: isSelfDelete,
    },
    { type: "community_post", id: postId },
  );
  return rows[0];
}

/** 审核/处置评论状态：批准待审评论时补发回复通知（原 pending 创建时不发）。 */
export async function changeCommentStatus(
  commentId: string,
  actorId: string,
  status: "published" | "hidden" | "deleted",
  reason = "",
) {
  const db = getDb();
  const existing = await db.select({
    id: communityComments.id,
    post_id: communityComments.post_id,
    author_id: communityComments.author_id,
    parent_id: communityComments.parent_id,
    status: communityComments.status,
  }).from(communityComments).where(eq(communityComments.id, commentId))
    .limit(1);
  if (!existing[0]) throw new NotFoundError("评论不存在");
  const rows = await db.update(communityComments).set({
    status,
    moderation_reason: reason || null,
    updated_at: now(),
  }).where(eq(communityComments.id, commentId)).returning();
  await db.insert(communityModerationActions).values({
    id: crypto.randomUUID(),
    moderator_id: actorId,
    action: status,
    target_type: "comment",
    target_id: commentId,
    reason,
    metadata: {},
    created_at: now(),
  });
  await logAudit(
    "community.post_moderated",
    { action: "community.post_moderated", status, reason },
    { type: "community_comment", id: commentId },
  );
  if (status === "published" && existing[0].status === "pending") {
    const recipient = existing[0].parent_id
      ? (await db.select({ author_id: communityComments.author_id }).from(
        communityComments,
      ).where(eq(communityComments.id, existing[0].parent_id)).limit(1))[0]
        ?.author_id
      : (await db.select({ author_id: communityPosts.author_id }).from(
        communityPosts,
      ).where(eq(communityPosts.id, existing[0].post_id)).limit(1))[0]
        ?.author_id;
    if (recipient && recipient !== existing[0].author_id) {
      await createNotification(
        recipient,
        existing[0].author_id,
        "reply",
        existing[0].post_id,
        commentId,
        {},
      );
    }
  }
  return rows[0]!;
}

export async function togglePostFlag(
  postId: string,
  actorId: string,
  field: "is_locked" | "is_pinned",
  value: boolean,
) {
  const db = getDb();
  const rows = await db.update(communityPosts).set({
    [field]: value,
    updated_at: now(),
  }).where(eq(communityPosts.id, postId)).returning();
  if (!rows[0]) throw new NotFoundError("社区内容不存在");
  await db.insert(communityModerationActions).values({
    id: crypto.randomUUID(),
    moderator_id: actorId,
    action: field,
    target_type: "post",
    target_id: postId,
    reason: "",
    metadata: { value },
    created_at: now(),
  });
  await logAudit(
    "community.post_moderated",
    { action: "community.post_moderated", status: field, reason: "" },
    { type: "community_post", id: postId },
  );
  return rows[0];
}

export async function createComment(
  authorId: string,
  postId: string,
  contentInput: string,
  parentId?: string,
) {
  assertCommunityEnabled("comments_enabled");
  const content = contentInput.trim();
  if (!content || content.length > getCommunityConfig().comment_max_length) {
    throw new ValidationError("评论内容无效或过长");
  }
  const post = await getPost(postId, authorId);
  if (post.post.is_locked) throw new ForbiddenError("该内容已锁定");
  const db = getDb();
  if (parentId) {
    const parent = await db.select().from(communityComments).where(
      eq(communityComments.id, parentId),
    ).limit(1);
    if (!parent[0] || parent[0].post_id !== postId) {
      throw new ValidationError("回复目标不存在");
    }
    if (parent[0].parent_id) throw new ValidationError("仅支持回复一级评论");
    // 仅允许回复已发布的评论，防止回复 pending/hidden/deleted 的孤儿评论
    if (parent[0].status !== "published") {
      throw new ValidationError("不能回复未发布或已删除的评论");
    }
  }
  const createdAt = now();
  const status = await publicationStatus(authorId);
  const comment = {
    id: crypto.randomUUID(),
    post_id: postId,
    author_id: authorId,
    parent_id: parentId ?? null,
    content,
    status,
    moderation_reason: null,
    created_at: createdAt,
    updated_at: createdAt,
  };
  await db.insert(communityComments).values(comment);
  const recipient = parentId
    ? (await db.select({ author_id: communityComments.author_id }).from(
      communityComments,
    ).where(eq(communityComments.id, parentId)).limit(1))[0]?.author_id
    : post.post.author_id;
  if (status === "published" && recipient && recipient !== authorId) {
    await createNotification(
      recipient,
      authorId,
      "reply",
      postId,
      comment.id,
      {},
    );
  }
  return comment;
}

export async function listComments(
  postId: string,
  viewerId?: string,
  moderator = false,
) {
  await getPost(postId, viewerId, moderator);
  const db = getDb();
  const conditions = [eq(communityComments.post_id, postId)];
  if (!moderator) conditions.push(eq(communityComments.status, "published"));
  return await db.select({
    comment: communityComments,
    author: { id: users.id, username: users.username },
    likes: sql<
      number
    >`(select count(*) from community_comment_likes where comment_id = ${communityComments.id})`,
  }).from(communityComments).innerJoin(
    users,
    eq(users.id, communityComments.author_id),
  ).where(and(...conditions)).orderBy(communityComments.created_at);
}

/** 待审核评论列表（供管理后台审核队列），含所属帖子标题用于上下文。 */
export async function listPendingComments(limit = 50) {
  const db = getDb();
  const rows = await db.select({
    comment: communityComments,
    author: { id: users.id, username: users.username },
    post_title: communityPosts.title,
  }).from(communityComments).innerJoin(
    users,
    eq(users.id, communityComments.author_id),
  ).innerJoin(
    communityPosts,
    eq(communityPosts.id, communityComments.post_id),
  ).where(eq(communityComments.status, "pending")).orderBy(
    communityComments.created_at,
  ).limit(Math.min(Math.max(limit, 1), 100));
  return rows;
}

/** 编辑评论内容：仅作者或审核员，已删除评论不可编辑。 */
export async function updateComment(
  commentId: string,
  actorId: string,
  moderator: boolean,
  contentInput: string,
) {
  const db = getDb();
  const existing = await db.select().from(communityComments).where(
    eq(communityComments.id, commentId),
  ).limit(1);
  if (!existing[0]) throw new NotFoundError("评论不存在");
  const current = existing[0];
  if (current.author_id !== actorId && !moderator) {
    throw new ForbiddenError("无权编辑该评论");
  }
  if (current.status === "deleted") {
    throw new ValidationError("已删除评论不能编辑");
  }
  const content = contentInput.trim();
  if (!content || content.length > getCommunityConfig().comment_max_length) {
    throw new ValidationError("评论内容无效或过长");
  }
  const rows = await db.update(communityComments).set({
    content,
    updated_at: now(),
  }).where(eq(communityComments.id, commentId)).returning();
  return rows[0]!;
}

/** 软删除评论：仅作者或审核员，状态置为 deleted。 */
export async function deleteComment(
  commentId: string,
  actorId: string,
  moderator: boolean,
) {
  const db = getDb();
  const existing = await db.select().from(communityComments).where(
    eq(communityComments.id, commentId),
  ).limit(1);
  if (!existing[0]) throw new NotFoundError("评论不存在");
  const current = existing[0];
  if (current.author_id !== actorId && !moderator) {
    throw new ForbiddenError("无权删除该评论");
  }
  if (current.status === "deleted") {
    throw new ValidationError("评论已删除");
  }
  const rows = await db.update(communityComments).set({
    status: "deleted",
    updated_at: now(),
  }).where(eq(communityComments.id, commentId)).returning();
  // 审核员删除他人评论属治理操作，写入审计日志（复用 post_moderated 动作）
  if (moderator && current.author_id !== actorId) {
    await logAudit(
      "community.post_moderated",
      {
        action: "community.post_moderated",
        status: "deleted",
        reason: "评论被审核员删除",
      },
      { type: "community_comment", id: commentId },
    );
  }
  return rows[0]!;
}

async function toggleRelation(
  table: typeof communityPostLikes | typeof communityBookmarks,
  columns: { post_id: string; user_id: string },
  enabled: keyof CommunityConfig,
) {
  assertCommunityEnabled(enabled);
  const db = getDb();
  const existing = await db.select().from(table).where(
    and(eq(table.post_id, columns.post_id), eq(table.user_id, columns.user_id)),
  ).limit(1);
  if (existing[0]) {
    await db.delete(table).where(
      and(
        eq(table.post_id, columns.post_id),
        eq(table.user_id, columns.user_id),
      ),
    );
    return false;
  }
  await db.insert(table).values({ ...columns, created_at: now() });
  return true;
}

export async function togglePostLike(userId: string, postId: string) {
  const liked = await toggleRelation(communityPostLikes, {
    post_id: postId,
    user_id: userId,
  }, "reactions_enabled");
  if (liked) {
    const post = await getPost(postId, userId);
    if (post.post.author_id !== userId) {
      await createNotification(
        post.post.author_id,
        userId,
        "like",
        postId,
        null,
        {},
      );
    }
  }
  return liked;
}

export async function toggleBookmark(userId: string, postId: string) {
  return await toggleRelation(communityBookmarks, {
    post_id: postId,
    user_id: userId,
  }, "bookmarks_enabled");
}

export async function toggleCommentLike(userId: string, commentId: string) {
  assertCommunityEnabled("reactions_enabled");
  const db = getDb();
  const comment = await db.select({
    author_id: communityComments.author_id,
    post_id: communityComments.post_id,
  }).from(communityComments).where(eq(communityComments.id, commentId))
    .limit(1);
  if (!comment[0]) throw new NotFoundError("评论不存在");
  const existing = await db.select().from(communityCommentLikes).where(
    and(
      eq(communityCommentLikes.comment_id, commentId),
      eq(communityCommentLikes.user_id, userId),
    ),
  ).limit(1);
  if (existing[0]) {
    await db.delete(communityCommentLikes).where(
      and(
        eq(communityCommentLikes.comment_id, commentId),
        eq(communityCommentLikes.user_id, userId),
      ),
    );
    return false;
  }
  await db.insert(communityCommentLikes).values({
    comment_id: commentId,
    user_id: userId,
    created_at: now(),
  });
  if (comment[0].author_id !== userId) {
    await createNotification(
      comment[0].author_id,
      userId,
      "like",
      comment[0].post_id,
      commentId,
      {},
    );
  }
  return true;
}

export async function toggleFollow(followerId: string, followeeId: string) {
  assertCommunityEnabled("follows_enabled");
  if (followerId === followeeId || followeeId === "0") {
    throw new ValidationError("不能关注该用户");
  }
  const db = getDb();
  const existing = await db.select().from(communityFollows).where(
    and(
      eq(communityFollows.follower_id, followerId),
      eq(communityFollows.followee_id, followeeId),
    ),
  ).limit(1);
  if (existing[0]) {
    await db.delete(communityFollows).where(
      and(
        eq(communityFollows.follower_id, followerId),
        eq(communityFollows.followee_id, followeeId),
      ),
    );
    return false;
  }
  await db.insert(communityFollows).values({
    follower_id: followerId,
    followee_id: followeeId,
    created_at: now(),
  });
  await createNotification(followeeId, followerId, "follow", null, null, {});
  return true;
}

export async function updateActivityVisibility(
  userId: string,
  visibility: "hidden" | "following" | "everyone",
) {
  const db = getDb();
  const rows = await db.update(users).set({
    community_activity_visibility: visibility,
    updated_at: now(),
  }).where(eq(users.id, userId)).returning({
    id: users.id,
    community_activity_visibility: users.community_activity_visibility,
  });
  if (!rows[0]) throw new NotFoundError("用户不存在");
  return rows[0];
}

export async function createActivity(
  actorId: string,
  type: "first_accepted" | "solution_published" | "contest_joined",
  subjectType: string,
  subjectId: string,
  metadata: Record<string, unknown>,
) {
  if (!getCommunityConfig().activities_enabled) return;
  const db = getDb();
  await db.insert(communityActivityEvents).values({
    id: crypto.randomUUID(),
    actor_id: actorId,
    type,
    subject_type: subjectType,
    subject_id: subjectId,
    metadata,
    created_at: now(),
  }).onConflictDoNothing();
}

export async function listFeed(
  view: "latest" | "following",
  viewerId?: string,
  cursor?: string,
  limit = 20,
) {
  const config = getCommunityConfig();
  if (!config.moments_enabled && !config.activities_enabled) {
    throw new ForbiddenError("该社区功能已关闭", "FEATURE_DISABLED");
  }
  const db = getDb();
  const normalizedLimit = Math.min(Math.max(limit, 1), 100);
  const conditions = [
    eq(communityPosts.type, "moment"),
    eq(communityPosts.status, "published"),
  ];
  if (cursor) conditions.push(lt(communityPosts.created_at, cursor));
  if (view === "following") {
    if (!viewerId) throw new ForbiddenError("登录后可查看关注动态");
    const follows = await db.select({ id: communityFollows.followee_id }).from(
      communityFollows,
    ).where(eq(communityFollows.follower_id, viewerId));
    if (!follows.length) return { data: [], next_cursor: null };
    conditions.push(
      inArray(communityPosts.author_id, follows.map((f) => f.id)),
    );
  }
  const momentRows = config.moments_enabled
    ? await db.select({
      post: communityPosts,
      author: { id: users.id, username: users.username },
    }).from(communityPosts).innerJoin(
      users,
      eq(users.id, communityPosts.author_id),
    ).where(and(...conditions)).orderBy(desc(communityPosts.created_at)).limit(
      normalizedLimit + 1,
    )
    : [];

  const activityConditions = [];
  if (cursor) {
    activityConditions.push(lt(communityActivityEvents.created_at, cursor));
  }
  if (view === "following") {
    if (!viewerId) throw new ForbiddenError("登录后可查看关注动态");
    const follows = await db.select({ id: communityFollows.followee_id }).from(
      communityFollows,
    ).where(eq(communityFollows.follower_id, viewerId));
    if (follows.length) {
      activityConditions.push(
        inArray(
          communityActivityEvents.actor_id,
          follows.map((item) => item.id),
        ),
      );
    } else {
      activityConditions.push(sql`false`);
    }
  }
  if (getCommunityConfig().activities_enabled) {
    activityConditions.push(
      view === "following"
        ? sql`${users.community_activity_visibility} IN ('following', 'everyone')`
        : sql`${users.community_activity_visibility} = 'everyone'${
          viewerId
            ? sql` OR ${communityActivityEvents.actor_id} = ${viewerId}`
            : sql``
        }`,
    );
  } else {
    activityConditions.push(sql`false`);
  }
  const activityRows = await db.select({
    activity: communityActivityEvents,
    author: { id: users.id, username: users.username },
  }).from(communityActivityEvents).innerJoin(
    users,
    eq(users.id, communityActivityEvents.actor_id),
  ).where(and(...activityConditions)).orderBy(
    desc(communityActivityEvents.created_at),
  ).limit(normalizedLimit + 1);

  const data = [
    ...momentRows.map((item) => ({ kind: "moment" as const, ...item })),
    ...activityRows.map((item) => ({ kind: "activity" as const, ...item })),
  ].sort((left, right) => {
    const leftCreatedAt = left.kind === "moment"
      ? left.post.created_at
      : left.activity.created_at;
    const rightCreatedAt = right.kind === "moment"
      ? right.post.created_at
      : right.activity.created_at;
    return rightCreatedAt.localeCompare(leftCreatedAt);
  });
  const hasMore = data.length > normalizedLimit;
  const page = hasMore ? data.slice(0, normalizedLimit) : data;
  const last = page.at(-1);
  const lastCreatedAt = last?.kind === "moment"
    ? last.post.created_at
    : last?.activity.created_at;
  return {
    data: page,
    next_cursor: hasMore ? lastCreatedAt ?? null : null,
  };
}

async function createNotification(
  recipientId: string,
  actorId: string | null,
  type: "reply" | "like" | "follow" | "moderation",
  postId: string | null,
  commentId: string | null,
  data: Record<string, unknown>,
) {
  if (recipientId === actorId) return;
  const notification = {
    id: crypto.randomUUID(),
    recipient_id: recipientId,
    actor_id: actorId,
    type,
    post_id: postId,
    comment_id: commentId,
    data,
    read_at: null,
    created_at: now(),
  };
  const db = getDb();
  await db.insert(communityNotifications).values(notification);
  publishEvent(
    Channels.user(recipientId),
    JSON.stringify({
      type: "notification:new",
      notification_id: notification.id,
    }),
  );
}

export async function listNotifications(userId: string, limit = 30) {
  const db = getDb();
  return await db.select({
    notification: communityNotifications,
    actor: { id: users.id, username: users.username },
  }).from(communityNotifications).leftJoin(
    users,
    eq(users.id, communityNotifications.actor_id),
  ).where(eq(communityNotifications.recipient_id, userId)).orderBy(
    desc(communityNotifications.created_at),
  ).limit(Math.min(limit, 100));
}
export async function getNotificationUnreadCount(userId: string) {
  const db = getDb();
  const rows = await db.select({ count: sql<number>`count(*)` }).from(
    communityNotifications,
  ).where(
    and(
      eq(communityNotifications.recipient_id, userId),
      isNull(communityNotifications.read_at),
    ),
  );
  return Number(rows[0]?.count ?? 0);
}
export async function markNotificationsRead(userId: string) {
  const db = getDb();
  await db.update(communityNotifications).set({ read_at: now() }).where(
    and(
      eq(communityNotifications.recipient_id, userId),
      isNull(communityNotifications.read_at),
    ),
  );
}
/** 标记单条通知已读：仅本人通知，已读重复调用幂等。 */
export async function markNotificationRead(
  userId: string,
  notificationId: string,
) {
  const db = getDb();
  const existing = await db.select({ id: communityNotifications.id }).from(
    communityNotifications,
  ).where(
    and(
      eq(communityNotifications.id, notificationId),
      eq(communityNotifications.recipient_id, userId),
    ),
  ).limit(1);
  if (!existing[0]) throw new NotFoundError("通知不存在");
  await db.update(communityNotifications).set({ read_at: now() }).where(
    eq(communityNotifications.id, notificationId),
  );
}

export async function createReport(
  reporterId: string,
  input: { post_id?: string; comment_id?: string; reason: string },
) {
  assertCommunityEnabled();
  if (!!input.post_id === !!input.comment_id) {
    throw new ValidationError("必须指定一个举报目标");
  }
  const db = getDb();
  const target = input.post_id
    ? await db.select({
      id: communityPosts.id,
      content: communityPosts.content,
      status: communityPosts.status,
    }).from(communityPosts).where(eq(communityPosts.id, input.post_id)).limit(1)
    : await db.select({
      id: communityComments.id,
      content: communityComments.content,
      status: communityComments.status,
    }).from(communityComments).where(
      eq(communityComments.id, input.comment_id!),
    ).limit(1);
  if (!target[0] || target[0].status === "deleted") {
    throw new NotFoundError("举报目标不存在");
  }
  const existing = await db.select({ id: communityReports.id }).from(
    communityReports,
  ).where(
    and(
      eq(communityReports.reporter_id, reporterId),
      input.post_id
        ? eq(communityReports.post_id, input.post_id)
        : eq(communityReports.comment_id, input.comment_id!),
      eq(communityReports.status, "pending"),
    ),
  ).limit(1);
  if (existing[0]) throw new ConflictError("已举报该内容");
  const reason = input.reason.trim();
  if (!reason) throw new ValidationError("举报原因不能为空");
  if (reason.length > 500) throw new ValidationError("举报原因最多 500 个字符");
  const report = {
    id: crypto.randomUUID(),
    reporter_id: reporterId,
    post_id: input.post_id ?? null,
    comment_id: input.comment_id ?? null,
    reason,
    content_snapshot: target[0].content,
    status: "pending",
    resolution: null,
    resolved_by: null,
    resolved_at: null,
    created_at: now(),
  };
  await db.insert(communityReports).values(report);
  return report;
}

export async function listReports() {
  const db = getDb();
  return await db.select().from(communityReports).where(
    eq(communityReports.status, "pending"),
  ).orderBy(communityReports.created_at);
}
export async function resolveReport(
  reportId: string,
  actorId: string,
  status: "resolved" | "dismissed",
  resolution = "",
) {
  const db = getDb();
  const rows = await db.update(communityReports).set({
    status,
    resolution,
    resolved_by: actorId,
    resolved_at: now(),
  }).where(eq(communityReports.id, reportId)).returning();
  if (!rows[0]) throw new NotFoundError("举报不存在");
  await logAudit(
    "community.report_resolved",
    { action: "community.report_resolved", status, resolution },
    { type: "community_report", id: reportId },
  );
  return rows[0];
}

export async function createSanction(
  actorId: string,
  userId: string,
  reason: string,
  expiresAt?: string,
) {
  const db = getDb();
  const sanction = {
    id: crypto.randomUUID(),
    user_id: userId,
    reason,
    expires_at: expiresAt ?? null,
    created_by: actorId,
    created_at: now(),
    revoked_at: null,
    revoked_by: null,
  };
  await db.insert(communitySanctions).values(sanction);
  await logAudit(
    "community.sanction_created",
    {
      action: "community.sanction_created",
      reason,
      expires_at: expiresAt ?? null,
    },
    { type: "user", id: userId },
  );
  return sanction;
}
export async function revokeSanction(actorId: string, sanctionId: string) {
  const db = getDb();
  const rows = await db.update(communitySanctions).set({
    revoked_at: now(),
    revoked_by: actorId,
  }).where(eq(communitySanctions.id, sanctionId)).returning();
  if (!rows[0]) throw new NotFoundError("社区处罚不存在");
  await logAudit(
    "community.sanction_revoked",
    { action: "community.sanction_revoked" },
    { type: "community_sanction", id: sanctionId },
  );
  return rows[0];
}
export async function listSanctions() {
  const db = getDb();
  return await db.select().from(communitySanctions).orderBy(
    desc(communitySanctions.created_at),
  );
}
/** 某用户的全部社区处罚历史（含已撤销记录），按创建时间倒序。 */
export async function listUserSanctions(userId: string) {
  const db = getDb();
  return await db.select().from(communitySanctions).where(
    eq(communitySanctions.user_id, userId),
  ).orderBy(desc(communitySanctions.created_at));
}

const PRESETS: Record<
  "public" | "private" | "knowledge",
  Record<string, boolean>
> = {
  public: {
    community_enabled: true,
    community_guest_read_enabled: true,
    community_read_only: false,
    community_solutions_enabled: true,
    community_discussions_enabled: true,
    community_moments_enabled: true,
    community_activities_enabled: true,
    community_comments_enabled: true,
    community_reactions_enabled: true,
    community_bookmarks_enabled: true,
    community_follows_enabled: true,
    private_messaging_enabled: true,
    community_external_images_enabled: true,
  },
  private: {
    community_enabled: true,
    community_guest_read_enabled: false,
    community_read_only: false,
    community_solutions_enabled: true,
    community_discussions_enabled: true,
    community_moments_enabled: true,
    community_activities_enabled: true,
    community_comments_enabled: true,
    community_reactions_enabled: true,
    community_bookmarks_enabled: true,
    community_follows_enabled: true,
    private_messaging_enabled: true,
    community_external_images_enabled: false,
  },
  knowledge: {
    community_enabled: true,
    community_guest_read_enabled: false,
    community_read_only: true,
    community_solutions_enabled: true,
    community_discussions_enabled: true,
    community_moments_enabled: false,
    community_activities_enabled: false,
    community_comments_enabled: false,
    community_reactions_enabled: false,
    community_bookmarks_enabled: false,
    community_follows_enabled: false,
    private_messaging_enabled: false,
    community_external_images_enabled: false,
  },
};
export async function applyCommunityPreset(
  actorId: string,
  preset: keyof typeof PRESETS,
) {
  for (const [key, value] of Object.entries(PRESETS[preset])) {
    await updateSetting(key, value, actorId);
  }
  await logAudit(
    "community.preset_applied",
    { action: "community.preset_applied", preset },
    { type: "community_preset", id: preset },
  );
  return getCommunityConfig();
}
