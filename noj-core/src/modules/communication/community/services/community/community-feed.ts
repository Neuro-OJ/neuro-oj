import { and, desc, eq, isNull, lt, or, sql } from "drizzle-orm";
import {
  accountNotifications,
  communityPosts,
  users,
} from "../../../../../shared/db/schema.ts";
import { ForbiddenError } from "../../../../../shared/base/errors.ts";
import { getCommunityConfig } from "./community-config.ts";
import {
  getAccountNotification,
  listAccountNotifications,
  readAccountNotifications,
} from "../../../account-notifications.ts";
import { authorProjection } from "./community-post-select.ts";
import {
  communityDb,
  communityDomainId,
  communityDomainWhere,
  communityResourceVisible,
  type CommunityScope,
} from "./community-scope.ts";
import { notGatedContestContent } from "./community-post-common.ts";

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
  scope?: CommunityScope,
) {
  const config = getCommunityConfig();
  if (!config.moments_enabled) {
    throw new ForbiddenError("该社区功能已关闭", "FEATURE_DISABLED");
  }
  const db = communityDb(scope);
  const normalizedLimit = Math.min(Math.max(limit, 1), 100);
  // 复合游标 (created_at, id)：避免同一时间戳条目在分页中重复/丢失（design.md）
  const cursorParts = cursor ? parseFeedCursor(cursor) : null;
  const conditions = [
    eq(communityPosts.type, "moment"),
    eq(communityPosts.status, "published"),
    communityDomainWhere(communityPosts.domain_id, scope),
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
    conditions.push(
      sql`EXISTS (SELECT 1 FROM community_follows WHERE follower_id = ${viewerId}
        AND followee_id = ${communityPosts.author_id})`,
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

/** 社区兼容服务沿用统一通知存储与 CRUD，保持原有调用方投影。 */
export async function listNotifications(
  userId: string,
  limit = 30,
  scope?: CommunityScope,
) {
  const result = await listAccountNotifications(
    notificationVisibleWhere(userId, scope),
    1,
    Math.min(Math.max(limit, 1), 100),
    communityDb(scope),
  );
  return result.data.map(({ notification, actor }) => ({
    notification,
    actor,
  }));
}

export async function getNotification(
  userId: string,
  notificationId: string,
  scope?: CommunityScope,
) {
  const { notification, actor } = await getAccountNotification(
    notificationVisibleWhere(userId, scope),
    notificationId,
    communityDb(scope),
  );
  return { notification, actor };
}

export async function getNotificationUnreadCount(
  userId: string,
  scope?: CommunityScope,
) {
  return (await listAccountNotifications(
    notificationVisibleWhere(userId, scope),
    1,
    1,
    communityDb(scope),
  )).unread_count;
}

export async function markNotificationsRead(
  userId: string,
  scope?: CommunityScope,
) {
  await readAccountNotifications(
    notificationVisibleWhere(userId, scope),
    undefined,
    communityDb(scope),
  );
}

export async function markNotificationRead(
  userId: string,
  notificationId: string,
  scope?: CommunityScope,
) {
  await readAccountNotifications(
    notificationVisibleWhere(userId, scope),
    notificationId,
    communityDb(scope),
  );
}

/** 摘要、未读数和已读操作都先过滤域及当前源授权，不保留被撤销的内容入口。 */
export function notificationVisibleWhere(
  userId: string,
  scope?: CommunityScope,
) {
  return and(
    eq(accountNotifications.recipient_id, userId),
    communityDomainWhere(accountNotifications.domain_id, scope),
    scope ? undefined : or(
      isNull(accountNotifications.domain_id),
      sql`EXISTS (
      SELECT 1 FROM domains notification_domain WHERE notification_domain.id = ${communityDomainId()}
        AND notification_domain.status <> 'suspended'
        AND (notification_domain.configuration->>'access' = 'public' OR EXISTS (
          SELECT 1 FROM domain_memberships notification_member WHERE notification_member.domain_id = notification_domain.id
            AND notification_member.user_id = ${userId} AND notification_member.status = 'active'))
    )`,
    ),
    or(
      isNull(accountNotifications.post_id),
      sql`EXISTS (
      SELECT 1 FROM community_posts WHERE community_posts.id = ${accountNotifications.post_id}
      AND ${communityDomainWhere(communityPosts.domain_id, scope)}
      AND ${communityResourceVisible(scope)}
      AND (${communityPosts.status} = 'published' OR ${communityPosts.author_id} = ${userId})
      AND ${scope?.moderator ? sql`true` : notGatedContestContent(scope)}
    )`,
    ),
  )!;
}
