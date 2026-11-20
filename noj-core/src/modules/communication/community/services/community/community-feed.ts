import { and, eq, isNull, or, sql } from "drizzle-orm";
import {
  accountNotifications,
  communityPosts,
} from "../../../../../shared/db/schema.ts";
import {
  getAccountNotification,
  listAccountNotifications,
  readAccountNotifications,
} from "../../../account-notifications.ts";
import {
  communityDb,
  communityDomainId,
  communityDomainWhere,
  communityResourceVisible,
  type CommunityScope,
} from "./community-scope.ts";
import { notGatedContestContent } from "./community-post-common.ts";

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
