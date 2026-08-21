import { and, desc, eq, inArray, isNull, lt, sql } from "drizzle-orm";
import { getDb } from "../../db/connection.ts";
import {
  communityActivityEvents,
  communityFollows,
  communityNotifications,
  communityPosts,
  users,
} from "../../db/schema.ts";
import { ForbiddenError, NotFoundError } from "../../lib/errors.ts";
import { getCommunityConfig } from "./community-config.ts";
import { nowIso } from "../../lib/dates.ts";

export async function createActivity(
  actorId: string,
  type: "first_accepted" | "solution_published" | "contest_joined",
  subjectType: string,
  subjectId: string,
  metadata: Record<string, unknown>,
) {
  if (!getCommunityConfig().activities_enabled) return;
  const db = getDb();
  await db.insert(communityActivityEvents).values({
    id: crypto.randomUUID(),
    actor_id: actorId,
    type,
    subject_type: subjectType,
    subject_id: subjectId,
    metadata,
    created_at: nowIso(),
  }).onConflictDoNothing();
}

export async function listFeed(
  view: "latest" | "following",
  viewerId?: string,
  cursor?: string,
  limit = 20,
) {
  const config = getCommunityConfig();
  if (!config.moments_enabled && !config.activities_enabled) {
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
  const momentRows = config.moments_enabled
    ? await db.select({
      post: communityPosts,
      author: {
        id: users.id,
        username: users.username,
        avatar_url: users.avatar_url,
      },
    }).from(communityPosts).innerJoin(
      users,
      eq(users.id, communityPosts.author_id),
    ).where(and(...conditions)).orderBy(
      desc(communityPosts.created_at),
      desc(communityPosts.id),
    ).limit(
      normalizedLimit + 1,
    )
    : [];

  const activityConditions = [];
  if (cursorParts) {
    activityConditions.push(
      cursorParts.id
        ? sql`(${communityActivityEvents.created_at} < ${cursorParts.at} OR (${communityActivityEvents.created_at} = ${cursorParts.at} AND ${communityActivityEvents.id} < ${cursorParts.id}))`
        : lt(communityActivityEvents.created_at, cursorParts.at),
    );
  }
  if (view === "following") {
    if (!viewerId) throw new ForbiddenError("登录后可查看关注动态");
    const follows = await db.select({ id: communityFollows.followee_id }).from(
      communityFollows,
    ).where(eq(communityFollows.follower_id, viewerId));
    if (follows.length) {
      activityConditions.push(
        inArray(
          communityActivityEvents.actor_id,
          follows.map((item) => item.id),
        ),
      );
    } else {
      activityConditions.push(sql`false`);
    }
  }
  if (getCommunityConfig().activities_enabled) {
    activityConditions.push(
      view === "following"
        ? sql`${users.community_activity_visibility} IN ('following', 'everyone')`
        : sql`${users.community_activity_visibility} = 'everyone'${
          viewerId
            ? sql` OR ${communityActivityEvents.actor_id} = ${viewerId}`
            : sql``
        }`,
    );
  } else {
    activityConditions.push(sql`false`);
  }
  const activityRows = await db.select({
    activity: communityActivityEvents,
    author: {
      id: users.id,
      username: users.username,
      avatar_url: users.avatar_url,
    },
  }).from(communityActivityEvents).innerJoin(
    users,
    eq(users.id, communityActivityEvents.actor_id),
  ).where(and(...activityConditions)).orderBy(
    desc(communityActivityEvents.created_at),
    desc(communityActivityEvents.id),
  ).limit(normalizedLimit + 1);

  const data = [
    ...momentRows.map((item) => ({ kind: "moment" as const, ...item })),
    ...activityRows.map((item) => ({ kind: "activity" as const, ...item })),
  ].sort((left, right) => {
    const leftCreatedAt = left.kind === "moment"
      ? left.post.created_at
      : left.activity.created_at;
    const rightCreatedAt = right.kind === "moment"
      ? right.post.created_at
      : right.activity.created_at;
    const atCompare = rightCreatedAt.localeCompare(leftCreatedAt);
    if (atCompare !== 0) return atCompare;
    const leftId = left.kind === "moment" ? left.post.id : left.activity.id;
    const rightId = right.kind === "moment" ? right.post.id : right.activity.id;
    return rightId.localeCompare(leftId);
  });
  const hasMore = data.length > normalizedLimit;
  const page = hasMore ? data.slice(0, normalizedLimit) : data;
  const last = page.at(-1);
  const lastCreatedAt = last?.kind === "moment"
    ? last.post.created_at
    : last?.activity.created_at;
  const lastId = last?.kind === "moment" ? last.post.id : last?.activity.id;
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
