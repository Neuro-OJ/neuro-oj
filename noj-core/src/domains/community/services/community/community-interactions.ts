import { and, eq } from "drizzle-orm";
import { getDb } from "./../../../../shared/db/connection.ts";
import {
  communityBookmarks,
  communityCommentLikes,
  communityComments,
  communityFollows,
  communityPostLikes,
  users,
} from "./../../../../shared/db/schema.ts";
import {
  NotFoundError,
  ValidationError,
} from "./../../../../shared/base/errors.ts";
import { createNotification } from "../notifications.ts";
import { assertCommunityEnabled } from "./community-config.ts";
import { getPost } from "./community-post-crud.ts";
import type { CommunityConfig } from "./../../types/community.ts";
import { ROOT_USER_ID } from "./../../../../shared/base/constants.ts";
import { nowIso } from "./../../../../shared/base/dates.ts";

/**
 * 切换帖子点赞/收藏关系：已存在则删除（返回 false），否则插入（返回 true）。
 * @param table 目标关系表（帖子点赞或收藏）。
 * @param columns 关系键：post_id 与 user_id。
 * @param enabled 对应的功能开关配置项。
 * @returns 切换后是否处于已点赞/已收藏状态。
 * @throws {ForbiddenError} 对应功能关闭时抛出。
 */
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
  await db.insert(table).values({ ...columns, created_at: nowIso() });
  return true;
}

/**
 * 切换帖子点赞状态，点赞时向帖子作者发送 like 通知（自己点赞自己除外）。
 * @param userId 操作用户 UUID。
 * @param postId 帖子 UUID。
 * @returns 切换后是否处于已点赞状态。
 */
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

/**
 * 切换帖子收藏状态。
 * @param userId 操作用户 UUID。
 * @param postId 帖子 UUID。
 * @returns 切换后是否处于已收藏状态。
 */
export function toggleBookmark(userId: string, postId: string) {
  return toggleRelation(communityBookmarks, {
    post_id: postId,
    user_id: userId,
  }, "bookmarks_enabled");
}

/**
 * 切换评论点赞状态，点赞时向评论作者发送 like 通知（自己点赞自己除外）。
 * 仅可点赞已发布评论。
 * @param userId 操作用户 UUID。
 * @param commentId 评论 UUID。
 * @returns 切换后是否处于已点赞状态。
 * @throws {NotFoundError} 评论不存在或未发布时抛出。
 */
export async function toggleCommentLike(userId: string, commentId: string) {
  assertCommunityEnabled("reactions_enabled");
  const db = getDb();
  const comment = await db.select({
    author_id: communityComments.author_id,
    post_id: communityComments.post_id,
    status: communityComments.status,
  }).from(communityComments).where(eq(communityComments.id, commentId))
    .limit(1);
  if (!comment[0]) throw new NotFoundError("评论不存在");
  // 仅可点赞已发布评论，避免与 pending/hidden/deleted 内容互动
  if (comment[0].status !== "published") {
    throw new NotFoundError("评论不存在");
  }
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
    created_at: nowIso(),
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

/**
 * 切换关注关系：已关注则取消（返回 false），否则建立关注并通知被关注者（返回 true）。
 * @param followerId 关注者用户 UUID。
 * @param followeeId 被关注者用户 UUID。
 * @returns 切换后是否处于已关注状态。
 * @throws {ValidationError} 不能关注自己或 root 用户时抛出。
 */
export async function toggleFollow(followerId: string, followeeId: string) {
  assertCommunityEnabled("follows_enabled");
  if (followerId === followeeId || followeeId === ROOT_USER_ID) {
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
    created_at: nowIso(),
  });
  await createNotification(followeeId, followerId, "follow", null, null, {});
  return true;
}

/**
 * 更新用户的活动可见性设置。
 * @param userId 用户 UUID。
 * @param visibility 可见性：hidden（隐藏）/ following（仅关注者）/ everyone（所有人）。
 * @returns 更新后的用户 id 与活动可见性。
 * @throws {NotFoundError} 用户不存在时抛出。
 */
export async function updateActivityVisibility(
  userId: string,
  visibility: "hidden" | "following" | "everyone",
) {
  const db = getDb();
  const rows = await db.update(users).set({
    community_activity_visibility: visibility,
    updated_at: nowIso(),
  }).where(eq(users.id, userId)).returning({
    id: users.id,
    community_activity_visibility: users.community_activity_visibility,
  });
  if (!rows[0]) throw new NotFoundError("用户不存在");
  return rows[0];
}
