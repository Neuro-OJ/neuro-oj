import { desc, eq, sql } from "drizzle-orm";
import { getDb } from "./../../../../shared/db/connection.ts";
import { publishSearchIndexEvent } from "./../../../../shared/search-events.ts";
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
import { isProblemInUnendedPublicContest } from "./../../../contest/index.ts";

/**
 * 判断用户是否为指定题目的所有者（用于官方题解标记的写入校验）。
 *
 * @param userId 用户 UUID。
 * @param problemId 题目 UUID；缺省时返回 false。
 * @returns 是该题目 owner 时为 true。
 */
async function isProblemOwner(
  userId: string,
  problemId: string | undefined,
): Promise<boolean> {
  if (!problemId) return false;
  const [problem] = await getDb().select({ owner_id: problems.owner_id })
    .from(problems)
    .where(eq(problems.id, problemId))
    .limit(1);
  return problem?.owner_id === userId;
}

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
  // ── 公开赛保密写入门控（审计 VULN-02）──
  //
  // 此前**只有前端**的 `/solutions/eligibility` 提示"竞赛进行中"，底层落库的
  // createPost **完全没有**公开赛归属校验：直接发包即可在赛中发布题解；讨论帖
  // 同样不受任何限制。前端置灰按钮不是访问控制。
  //
  // 现由服务层强制：只要关联题目归属于尚未结束的公开赛（含赛前筹备期 pending），
  // 非审核员一律禁止发布相关题解/讨论。判据复用 contest 域单一真相源
  // `isProblemInUnendedPublicContest`，与列表/详情读取门控同口径。
  // moderator（审核员）免门控，用于赛后归档与官方说明。
  if (!moderator && input.type !== "moment" && input.problem_id) {
    // 题解已在上面解析为 UUID；讨论帖的 problem_id 不落库，但同样必须过门控
    const guardedProblemId = input.type === "solution"
      ? input.problem_id
      : await resolveProblemId(input.problem_id);
    if (
      guardedProblemId &&
      await isProblemInUnendedPublicContest(guardedProblemId)
    ) {
      throw new ForbiddenError(
        "该题目当前归属于公开赛，赛前及赛中禁止发布题解或讨论",
        "CONTEST_SECRECY",
      );
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
    // 官方标记：仅**题解**且题目 owner 或审核员的声明被信任。
    // 必须限定 type === "solution"（2026-09-14 评审）：此前只校验 isProblemOwner，
    // 而 discussion/moment 不会规范化 problem_id，客户端夹带任意 public 题的 id
    // 即可让 isProblemOwner 为真；又因 listPosts 无条件按 is_official 置顶排序，
    // 这类帖子会**置顶社区列表**，绕过 setPostOfficial 的"仅题解可标记"规则。
    is_official: input.is_official === true && input.type === "solution" &&
      (moderator || await isProblemOwner(authorId, input.problem_id)),
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
  // 注：社区自动动态（community_activity_events）已按审计 VULN-08 整体下线，
  // 不再产生 solution_published 动态事件（该事件会实时广播题目被解出，击穿封榜）。

  await publishSearchIndexEvent("community_post", post.id, "upsert");

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
  // 公开赛保密读取门控（审计 VULN-02）：归属于尚未结束的公开赛（含赛前筹备期）
  // 的题解与讨论，对普通用户（含作者本人）一律按"不存在"处理。
  // - 覆盖 `discussion`（此前只门控 solution，讨论区全量放行）；
  // - 覆盖赛前 pending 窗口（此前只查 running，赛前是最严重的泄密通道）；
  // - 含作者本人是为了避免"自己能看到 = 该题有内容"的侧信道确认。
  if (
    !moderator && row.post.problem_id &&
    (row.post.type === "solution" || row.post.type === "discussion")
  ) {
    if (await isProblemInUnendedPublicContest(row.post.problem_id)) {
      throw new NotFoundError("社区内容不存在");
    }
  }
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

  await publishSearchIndexEvent("community_post", postId, "upsert");

  return rows[0]!;
}

/**
 * 设置/取消题解的官方标记。
 *
 * 权限：题目 owner 或审核员。**服务层强制**——前端隐藏不作为保障。
 *
 * @param postId 帖子 UUID。
 * @param actorId 操作用户 UUID。
 * @param moderator 是否为审核员。
 * @param value 目标标记值。
 * @throws {NotFoundError} 帖子不存在或不可见。
 * @throws {ValidationError} 帖子不是题解类型。
 * @throws {ForbiddenError} 非题目 owner 且非审核员。
 */
export async function setPostOfficial(
  postId: string,
  actorId: string,
  moderator: boolean,
  value: boolean,
): Promise<void> {
  const post = await getPost(postId, actorId, moderator);
  if (post.post.type !== "solution") {
    throw new ValidationError("仅题解可标记为官方题解");
  }
  if (
    !moderator &&
    !await isProblemOwner(actorId, post.post.problem_id ?? undefined)
  ) {
    throw new ForbiddenError("仅题目所有者可设置官方题解");
  }
  await getDb().update(communityPosts)
    .set({ is_official: value, updated_at: nowIso() })
    .where(eq(communityPosts.id, postId));
}
