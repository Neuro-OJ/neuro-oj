import { asc, eq, inArray } from "drizzle-orm";
import { getDb } from "./../../../shared/db/connection.ts";
import {
  communityComments,
  communityPosts,
  conversations,
  messages,
  users,
} from "./../../../shared/db/schema.ts";
import { getReviewQueueItem } from "./review-queue.ts";

/**
 * 统一审查队列详情（issue #413）。
 *
 * 在 content_review_queue 记录基础上附加目标内容现状：
 * - post：作者用户名 + 当前状态/标题（快照已存原文，正文不必重复）
 * - comment：作者用户名 + 所属帖子标题 + 当前状态
 * - message：会话双方用户名 + 最近聊天记录（≤200 条，参照举报私信上下文的
 *   脱敏/权限分级），供管理员判断并处置
 */

/**
 * 获取审查队列详情（含目标内容上下文）。
 * @param id content_review_queue 记录 ID
 * @returns 队列记录 + context（按 content_type 展开）
 */
export async function getReviewQueueDetail(
  id: string,
): Promise<{
  queue:
    typeof import("./../../../shared/db/schema.ts").contentReviewQueue.$inferSelect;
  context: Record<string, unknown>;
}> {
  const row = await getReviewQueueItem(id);
  const db = getDb();
  const context: Record<string, unknown> = {};

  if (row.content_type === "post") {
    const [post] = await db.select({
      id: communityPosts.id,
      status: communityPosts.status,
      type: communityPosts.type,
      title: communityPosts.title,
      author_id: communityPosts.author_id,
    }).from(communityPosts).where(eq(communityPosts.id, row.target_id))
      .limit(1);
    if (post) {
      const [author] = post.author_id
        ? await db.select({ username: users.username }).from(users).where(
          eq(users.id, post.author_id),
        ).limit(1)
        : [];
      context.post = { ...post, author_username: author?.username ?? null };
    } else {
      context.post = null;
    }
  } else if (row.content_type === "comment") {
    const [comment] = await db.select({
      id: communityComments.id,
      status: communityComments.status,
      content: communityComments.content,
      author_id: communityComments.author_id,
      post_id: communityComments.post_id,
    }).from(communityComments).where(
      eq(communityComments.id, row.target_id),
    ).limit(1);
    if (comment) {
      const [author] = comment.author_id
        ? await db.select({ username: users.username }).from(users).where(
          eq(users.id, comment.author_id),
        ).limit(1)
        : [];
      const [post] = comment.post_id
        ? await db.select({ title: communityPosts.title }).from(communityPosts)
          .where(eq(communityPosts.id, comment.post_id)).limit(1)
        : [];
      context.comment = {
        ...comment,
        author_username: author?.username ?? null,
        post_title: post?.title ?? null,
      };
    } else {
      context.comment = null;
    }
  } else {
    // message：会话双方 + 聊天记录
    const [msg] = await db.select({
      id: messages.id,
      conversation_id: messages.conversation_id,
      sender_id: messages.sender_id,
    }).from(messages).where(eq(messages.id, row.target_id)).limit(1);
    if (!msg) {
      context.message = null;
    } else {
      const [conv] = await db.select().from(conversations)
        .where(eq(conversations.id, msg.conversation_id)).limit(1);
      if (!conv) {
        context.message = { target: msg, history: null };
      } else {
        const memberIds = [conv.user1_id, conv.user2_id];
        const memberRows = await db.select({
          id: users.id,
          username: users.username,
        }).from(users).where(inArray(users.id, memberIds));
        const memberMap = new Map(memberRows.map((u) => [u.id, u.username]));

        const history = await db.select({
          id: messages.id,
          sender_id: messages.sender_id,
          type: messages.type,
          content: messages.content,
          created_at: messages.created_at,
          recalled_at: messages.recalled_at,
        }).from(messages).where(
          eq(messages.conversation_id, msg.conversation_id),
        ).orderBy(asc(messages.created_at)).limit(200);

        context.message = {
          target: msg,
          conversation: {
            id: conv.id,
            user1: {
              id: conv.user1_id,
              username: memberMap.get(conv.user1_id) ?? "已注销用户",
            },
            user2: {
              id: conv.user2_id,
              username: memberMap.get(conv.user2_id) ?? "已注销用户",
            },
          },
          history: history.map((r) => ({
            ...r,
            sender_name: memberMap.get(r.sender_id) ?? "已注销用户",
            // 图片消息不回传存储 URL 给前端，仅占位（图片审核不在第一版范围）
            content: r.type === "image" ? "[图片]" : r.content,
          })),
        };
      }
    }
  }

  return { queue: row, context };
}
