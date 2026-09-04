import { desc, eq, sql } from "drizzle-orm";
import { getDb } from "./../../../../shared/db/connection.ts";
import {
  communityBoards,
  communityPosts,
  problems,
  userRoles,
  users,
} from "./../../../../shared/db/schema.ts";
import {
  ForbiddenError,
  NotFoundError,
  ValidationError,
} from "./../../../../shared/base/errors.ts";
import { nowIso } from "./../../../../shared/base/dates.ts";
import {
  generatePublicId,
  resolvePublicId,
} from "./../../../../shared/security/public-id.ts";
import type {
  CommunityPostInput,
  CommunityPostType,
} from "./../../types/community.ts";
import {
  assertCommunityEnabled,
  getCommunityConfig,
} from "./community-config.ts";
import { listBoardRoleGrants } from "./community-boards.ts";
import { createActivity } from "./community-feed.ts";
import {
  featureForType,
  hasAcceptedSolution,
  publicationStatus,
  resolveProblemId,
} from "./community-post-common.ts";
import {
  authorProjection,
  postStatsProjection,
} from "./community-post-select.ts";
import { reviewUgcContent } from "./community-review.ts";

/**
 * 校验题解发布门槛：若配置要求通过题目，则作者必须已通过对应题目。
 * @param authorId 作者用户 UUID。
 * @param problemId 题目 UUID。
 * @throws {ForbiddenError} 未通过题目时抛出（SOLUTION_NOT_ACCEPTED）。
 */
async function ensureSolutionAccepted(
  authorId: string,
  problemId: string,
): Promise<void> {
  if (!getCommunityConfig().solution_requires_accepted) return;
  if (!(await hasAcceptedSolution(authorId, problemId))) {
    throw new ForbiddenError(
      "通过对应题目后才能发布题解",
      "SOLUTION_NOT_ACCEPTED",
    );
  }
}

/**
 * 判断用户是否可在指定板块发帖：无角色授权时默认允许，否则需拥有可发帖的角色授权。
 * @param userId 用户 UUID。
 * @param boardId 板块 UUID。
 * @returns 是否允许发帖。
 */
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

/**
 * 创建社区帖子（题解 / 讨论 / 短动态）。
 * 校验内容长度、标题规则、题解门槛、板块权限与发布频率限制，并按发布状态生成动态事件。
 * @param authorId 作者用户 UUID。
 * @param input 帖子输入：type、title、content、problem_id、board_id 等。
 * @param moderator 是否为审核员，默认 false（审核员不受题解门槛与板块权限限制）。
 * @returns 新建的帖子记录。
 * @throws {ValidationError} 内容/标题无效、题解未关联题目、板块不存在或已归档时抛出。
 * @throws {ForbiddenError} 未通过题解门槛、无板块发帖权限或发布过于频繁时抛出。
 */
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
    // 通过门槛仅约束普通用户：管理员/审核员不受限（community-content spec）
    if (!moderator) await ensureSolutionAccepted(authorId, resolvedProblemId);
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
  // 发布频率限制：配置的间隔秒数内禁止再次发布（0 为不限制）
  const postIntervalSeconds = getCommunityConfig().post_interval_seconds;
  if (postIntervalSeconds > 0) {
    const lastRows = await getDb().select({
      created_at: communityPosts.created_at,
    })
      .from(communityPosts).where(eq(communityPosts.author_id, authorId))
      .orderBy(desc(communityPosts.created_at)).limit(1);
    const lastCreatedAt = lastRows[0]?.created_at;
    if (
      lastCreatedAt &&
      Date.now() - Date.parse(lastCreatedAt) < postIntervalSeconds * 1000
    ) {
      throw new ForbiddenError(
        "发布过于频繁，请稍后再试",
        "POST_RATE_LIMITED",
      );
    }
  }
  const createdAt = nowIso();
  const status = await publicationStatus(authorId);
  const post = {
    id: crypto.randomUUID(),
    public_id: generatePublicId("post"),
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
  // 内容合规同步审核（issue #413）：高置信违规直接拒绝发布
  await reviewUgcContent({
    content_type: "post",
    target_id: post.id,
    title: title ?? undefined,
    content,
    author_id: authorId,
    moderator,
    finalStatus: status === "pending" ? "pending" : "published",
  });
  const db = getDb();
  await db.insert(communityPosts).values(post);
  if (status === "published" && input.type === "solution") {
    await createActivity(authorId, "solution_published", "post", post.id, {
      problem_id: input.problem_id,
    });
  }
  return post;
}

/** 将 UUID 或 public_id 解析为内部帖子 UUID；其它格式按主键兜底。 */
export function resolvePostId(value: string): Promise<string> {
  return resolvePublicId(
    communityPosts,
    communityPosts.id,
    communityPosts.public_id,
    "post",
    value,
    "社区内容不存在",
  );
}

/**
 * 获取帖子详情（含作者、题目标题、点赞/评论数及当前查看者的收藏/点赞状态）。
 * 非审核员仅可见已发布帖子（作者本人可见自己的非发布帖子）。
 * @param postId 帖子 UUID。
 * @param viewerId 可选，当前查看者用户 UUID。
 * @param moderator 是否为审核员，默认 false。
 * @returns 帖子详情对象。
 * @throws {NotFoundError} 帖子不存在或不可见时抛出。
 */
export async function getPost(
  postId: string,
  viewerId?: string,
  moderator = false,
) {
  const db = getDb();
  const rows = await db.select({
    post: communityPosts,
    author: authorProjection,
    problem_title: problems.title,
    ...postStatsProjection,
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
  // 模块关闭时详情同样返回 FEATURE_DISABLED（configuration spec：既有数据不删除）
  assertCommunityEnabled(featureForType(row.post.type as CommunityPostType));
  if (
    row.post.status !== "published" && row.post.author_id !== viewerId &&
    !moderator
  ) throw new NotFoundError("社区内容不存在");
  return row;
}

/**
 * 更新帖子标题/内容：仅作者或审核员，已删除帖子不可编辑，编辑同样受长度限制约束。
 * @param postId 帖子 UUID。
 * @param actorId 操作用户 UUID。
 * @param moderator 是否为审核员。
 * @param input 需要更新的字段：title / content（部分可选）。
 * @returns 更新后的帖子记录。
 * @throws {ForbiddenError} 非作者且非审核员时抛出。
 * @throws {ValidationError} 已删除帖子或内容/标题超限时抛出。
 */
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
  // 内容合规同步审核（issue #413）：编辑后仍公开的内容高置信违规时拒绝保存
  await reviewUgcContent({
    content_type: "post",
    target_id: postId,
    title: title ?? undefined,
    content,
    author_id: actorId,
    moderator,
    finalStatus: current.post.status === "pending" ? "pending" : "published",
  });
  const db = getDb();
  const rows = await db.update(communityPosts).set({
    content,
    title: title || null,
    updated_at: nowIso(),
  }).where(eq(communityPosts.id, postId)).returning();
  return rows[0]!;
}
