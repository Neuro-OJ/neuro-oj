/**
 * 站内通知公共服务。
 *
 * 供社区（community.ts）与竞赛答疑（contest-clarifications.ts）等模块
 * 写入 `community_notifications` 通知并推送 SSE `notification:new` 事件。
 * 通知读取/已读等用户侧操作仍留在 community.ts（仅社区路由使用）。
 */

import { getDb } from "./../../../shared/db/connection.ts";
import { communityNotifications } from "./../../../shared/db/schema.ts";
import { nowIso } from "./../../../shared/base/dates.ts";
import { Channels, publishSseEvent } from "./../../../shared/sse/event-bus.ts";

/**
 * 通知类型：社区互动（reply/like/follow/moderation）与竞赛答疑（clarification）。
 * 与 `community_notifications_type_check` CHECK 约束保持一致。
 */
export type NotificationType =
  | "reply"
  | "like"
  | "follow"
  | "moderation"
  | "clarification"
  | "report"
  | "ban";

/**
 * 创建通知并推送 SSE。
 *
 * - recipient 与 actor 相同时跳过（自己回复自己不通知）
 * - 持久化到 `community_notifications`，随后经用户频道推送 `notification:new`，
 *   前端收到后刷新通知列表与未读计数
 */
export async function createNotification(
  recipientId: string,
  actorId: string | null,
  type: NotificationType,
  postId: string | null,
  commentId: string | null,
  data: Record<string, unknown>,
): Promise<void> {
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
    created_at: nowIso(),
  };
  const db = getDb();
  await db.insert(communityNotifications).values(notification);
  await publishSseEvent(
    Channels.user(recipientId),
    {
      type: "notification:new",
      notification_id: notification.id,
    },
  );
}
