import { and, desc, eq, inArray, isNull, lt, sql } from "drizzle-orm";
import { getDb } from "./../../../../shared/db/connection.ts";
import {
  communityFollows,
  communityNotifications,
  communityPosts,
  users,
} from "./../../../../shared/db/schema.ts";
import {
  ForbiddenError,
  NotFoundError,
} from "./../../../../shared/base/errors.ts";
import { getCommunityConfig } from "./community-config.ts";
import { nowIso } from "./../../../../shared/base/dates.ts";
import { authorProjection } from "./community-post-select.ts";

/**
 * 列出社区动态流（最新 / 关注），按时间倒序返回短动态（moment）。
 *
 * **2026-09-28 安全整改（审计 VULN-08）：自动动态功能整体下线。**
 * 此前这里把 `community_activity_events` 的三类自动动态（`first_accepted`
 * 首次过题 / `solution_published` 发布题解 / `contest_joined` 参加竞赛）与短动态
 * 混排返回。该功能与「讨论」高度重叠且缺乏实质内容，更严重的是**击穿竞赛封榜与
 * 保密**：`first_accepted` 事件不携带竞赛上下文，比赛中（含封榜期）任何人只要刷新
 * 动态流就能实时看到"某选手首次通过题目 X"；事件 metadata 还直接暴露内部
 * `submission_id`，`contest_joined` 会广播私密邀请赛标题。
 *
 * 现彻底移除事件流查询，动态流只保留用户短动态（有实质内容的用户自述）。
 *
 * @param view 视图：latest（最新）或 following（仅关注用户）。
 * @param viewerId 可选，当前查看者用户 UUID（following 视图必填）。
 * @param cursor 可选，复合游标 `createdAt|id`，用于分页。
 * @param limit 每页条数，默认 20，限制在 1-100。
 * @returns 分页结果：data 为动态列表，next_cursor 为下一页游标（无更多时为 null）。
 * @throws {ForbiddenError} 功能关闭或 following 视图未登录时抛出。
 */
export async function listFeed(
  view: "latest" | "following",
  viewerId?: string,
  cursor?: string,
  limit = 20,
) {
  const config = getCommunityConfig();
  if (!config.moments_enabled) {
    throw new ForbiddenError("该社区功能已关闭", "FEATURE_DISABLED");
  }
  const db = getDb();
  const normalizedLimit = Math.min(Math.max(limit, 1), 100);
  // 复合游标 (created_at, id)：避免同一时间戳条目在分页中重复/丢失（design.md）
  const cursorParts = cursor ? parseFeedCursor(cursor) : null;
  const conditions = [
    eq(communityPosts.type, "moment"),
    eq(communityPosts.status, "published"),
  ];
  if (cursorParts) {
    conditions.push(
      cursorParts.id
        ? sql`(${communityPosts.created_at} < ${cursorParts.at} OR (${communityPosts.created_at} = ${cursorParts.at} AND ${communityPosts.id} < ${cursorParts.id}))`
        : lt(communityPosts.created_at, cursorParts.at),
    );
  }
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
  const momentRows = await db.select({
    post: communityPosts,
    author: authorProjection,
  }).from(communityPosts).innerJoin(
    users,
    eq(users.id, communityPosts.author_id),
  ).where(and(...conditions)).orderBy(
    desc(communityPosts.created_at),
    desc(communityPosts.id),
  ).limit(normalizedLimit + 1);

  const data = momentRows.map((item) => ({ kind: "moment" as const, ...item }));
  const hasMore = data.length > normalizedLimit;
  const page = hasMore ? data.slice(0, normalizedLimit) : data;
  const last = page.at(-1);
  const lastCreatedAt = last?.post.created_at;
  const lastId = last?.post.id;
  return {
    data: page,
    next_cursor: hasMore && lastCreatedAt ? `${lastCreatedAt}|${lastId}` : null,
  };
}

/** 解析动态流复合游标 `createdAt|id`；兼容旧版纯时间戳游标。 */
function parseFeedCursor(cursor: string): { at: string; id?: string } {
  const sep = cursor.lastIndexOf("|");
  if (sep === -1) return { at: cursor };
  return { at: cursor.slice(0, sep), id: cursor.slice(sep + 1) };
}

/**
 * 列出用户的通知列表（含触发者信息），按创建时间倒序。
 * @param userId 接收者用户 UUID。
 * @param limit 每页条数，默认 30，上限 100。
 * @returns 通知列表，每条含通知记录与触发者信息。
 */
export function listNotifications(userId: string, limit = 30) {
  const db = getDb();
  return db.select({
    notification: communityNotifications,
    actor: {
      id: users.id,
      username: users.username,
      avatar_url: users.avatar_url,
    },
  }).from(communityNotifications).leftJoin(
    users,
    eq(users.id, communityNotifications.actor_id),
  ).where(eq(communityNotifications.recipient_id, userId)).orderBy(
    desc(communityNotifications.created_at),
  ).limit(Math.min(limit, 100));
}

/**
 * 获取单条通知详情（含触发者信息）。
 *
 * 投影与 {@link listNotifications} 保持一致，供通知详情页直接复用。
 * 仅接收者本人可读：非本人或不存在统一抛 404，不泄露他人通知是否存在。
 *
 * @param userId 接收者用户 UUID。
 * @param notificationId 通知 UUID。
 * @returns 通知记录与触发者信息。
 * @throws {NotFoundError} 通知不存在或不属于该用户时抛出。
 */
export async function getNotification(
  userId: string,
  notificationId: string,
) {
  const db = getDb();
  const rows = await db.select({
    notification: communityNotifications,
    actor: {
      id: users.id,
      username: users.username,
      avatar_url: users.avatar_url,
    },
  }).from(communityNotifications).leftJoin(
    users,
    eq(users.id, communityNotifications.actor_id),
  ).where(
    and(
      eq(communityNotifications.id, notificationId),
      eq(communityNotifications.recipient_id, userId),
    ),
  ).limit(1);
  if (!rows[0]) throw new NotFoundError("通知不存在");
  return rows[0];
}

/**
 * 获取用户未读通知数量。
 * @param userId 接收者用户 UUID。
 * @returns 未读通知数量。
 */
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

/**
 * 将用户全部未读通知标记为已读。
 * @param userId 接收者用户 UUID。
 */
export async function markNotificationsRead(userId: string) {
  const db = getDb();
  await db.update(communityNotifications).set({ read_at: nowIso() }).where(
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
  await db.update(communityNotifications).set({ read_at: nowIso() }).where(
    eq(communityNotifications.id, notificationId),
  );
}
