import { and, eq } from "drizzle-orm";
import { getDb } from "../../db/connection.ts";
import {
  communityBookmarks,
  communityCommentLikes,
  communityComments,
  communityFollows,
  communityPostLikes,
  users,
} from "../../db/schema.ts";
import { NotFoundError, ValidationError } from "../../lib/errors.ts";
import { createNotification } from "../notifications.ts";
import { assertCommunityEnabled } from "./community-config.ts";
import { getPost } from "./community-post-crud.ts";
import type { CommunityConfig } from "../../types/community.ts";
import { ROOT_USER_ID } from "../../lib/constants.ts";
import { nowIso } from "../../lib/dates.ts";

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

export function toggleBookmark(userId: string, postId: string) {
  return toggleRelation(communityBookmarks, {
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
