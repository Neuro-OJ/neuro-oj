/**
 * community 动态流子域：活动可见性 + 动态事件 + 关注流。
 * 对应 OpenSpec spec: openspec/specs/community-social-feed/spec.md
 *
 * 跨子域依赖：本文件导出 createActivity，被 ./community-content.ts 的
 * createPost 在题解发布时调用以写入动态事件。
 */

import { and, desc, eq, inArray, lt, sql } from "drizzle-orm";
import { getDb } from "../db/connection.ts";
import {
  communityActivityEvents,
  communityFollows,
  communityPosts,
  users,
} from "../db/schema.ts";
import { ForbiddenError, NotFoundError } from "../lib/errors.ts";
import { getCommunityConfig } from "./community-config.ts";
import { nowIso } from "../lib/dates.ts";

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
      author: { id: users.id, username: users.username },
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
    author: { id: users.id, username: users.username },
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
