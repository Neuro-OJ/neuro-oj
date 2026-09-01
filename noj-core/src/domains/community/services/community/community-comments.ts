import { and, eq, ne, or, sql } from "drizzle-orm";
import { getDb } from "../../../../db/connection.ts";
import {
  communityComments,
  communityModerationActions,
  communityPosts,
  users,
} from "../../../../db/schema.ts";
import {
  ForbiddenError,
  NotFoundError,
  ValidationError,
} from "../../../../lib/errors.ts";
import { logAudit } from "../../../system/index.ts";
import { createNotification } from "../notifications.ts";
import {
  assertCommunityEnabled,
  getCommunityConfig,
} from "./community-config.ts";
import { getPost } from "./community-post-crud.ts";
import { publicationStatus } from "./community-post-common.ts";
import { nowIso } from "../../../../lib/dates.ts";

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
    updated_at: nowIso(),
  }).where(eq(communityComments.id, commentId)).returning();
  await db.insert(communityModerationActions).values({
    id: crypto.randomUUID(),
    moderator_id: actorId,
    action: status,
    target_type: "comment",
    target_id: commentId,
    reason,
    metadata: {},
    created_at: nowIso(),
  });
  await logAudit(
    "community.post_moderated",
    { action: "community.post_moderated", status, reason },
    { type: "community_comment", id: commentId },
  );
  if (status === "published" && existing[0].status === "pending") {
    // 审核结果通知：评论作者本人收到 moderation 通知（community-moderation spec）
    await createNotification(
      existing[0].author_id,
      actorId,
      "moderation",
      existing[0].post_id,
      commentId,
      { status: "published" },
    );
    // 补发回复通知：pending 创建时未发，批准后通知被回复者
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

/**
 * 创建评论（或回复一级评论）。
 * 校验评论内容长度、帖子锁定状态、回复目标合法性，并按发布状态决定是否补发回复通知。
 * @param authorId 评论作者用户 UUID。
 * @param postId 所属帖子 UUID。
 * @param contentInput 评论内容（会 trim 后校验长度）。
 * @param parentId 可选，被回复的一级评论 UUID。
 * @returns 新建的评论记录。
 * @throws {ValidationError} 评论内容无效/过长、回复目标不存在或不可回复时抛出。
 * @throws {ForbiddenError} 帖子已锁定时抛出。
 */
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
  const createdAt = nowIso();
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

/**
 * 列出帖子的评论列表。
 * 非审核员仅可见已发布评论（作者本人可见自己的非删除评论）；审核员可见全部。
 * @param postId 帖子 UUID。
 * @param viewerId 可选，当前查看者用户 UUID。
 * @param moderator 是否为审核员，默认 false。
 * @returns 评论列表，每条含评论、作者信息与点赞数。
 * @throws {NotFoundError} 帖子不存在或不可见时抛出。
 */
export async function listComments(
  postId: string,
  viewerId?: string,
  moderator = false,
) {
  await getPost(postId, viewerId, moderator);
  const db = getDb();
  const conditions = [eq(communityComments.post_id, postId)];
  if (!moderator) {
    // 非审核员仅可见 published 评论；作者本人可见自己的非 deleted 评论（含 pending/hidden）
    conditions.push(
      viewerId
        ? or(
          eq(communityComments.status, "published"),
          and(
            eq(communityComments.author_id, viewerId),
            ne(communityComments.status, "deleted"),
          ),
        ) ?? sql`false`
        : eq(communityComments.status, "published"),
    );
  }
  return db.select({
    comment: communityComments,
    author: {
      id: users.id,
      username: users.username,
      avatar_url: users.avatar_url,
    },
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
    author: {
      id: users.id,
      username: users.username,
      avatar_url: users.avatar_url,
    },
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
    updated_at: nowIso(),
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
    updated_at: nowIso(),
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
