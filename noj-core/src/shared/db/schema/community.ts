import {
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  unique,
} from "drizzle-orm/pg-core";
import type { AnyPgColumn } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { manyToManyPk, publicIdColumn } from "./common.ts";
import { roles, userBans, users } from "./identity.ts";
import { problems } from "./catalog.ts";
import { messages } from "./messaging.ts";

/** 社区讨论板块。 */
export const communityBoards = pgTable(
  "community_boards",
  {
    id: text("id").primaryKey(),
    slug: text("slug").notNull().unique(),
    name: text("name").notNull(),
    description: text("description").notNull().default(""),
    sort_order: integer("sort_order").notNull().default(0),
    is_archived: boolean("is_archived").notNull().default(false),
    created_at: text("created_at").notNull(),
    updated_at: text("updated_at").notNull(),
  },
  (table) => ({
    sortIdx: index("idx_community_boards_sort").on(
      table.is_archived,
      table.sort_order,
    ),
  }),
);

/** 板块级角色授权；没有授权记录时沿用全局社区 RBAC。 */
export const communityBoardRoleGrants = pgTable(
  "community_board_role_grants",
  {
    board_id: text("board_id").notNull().references(() => communityBoards.id, {
      onDelete: "cascade",
    }),
    role_id: text("role_id").notNull().references(() => roles.id, {
      onDelete: "cascade",
    }),
    can_read: boolean("can_read").notNull().default(true),
    can_post: boolean("can_post").notNull().default(false),
    can_moderate: boolean("can_moderate").notNull().default(false),
  },
  (table) => ({
    ...manyToManyPk([table.board_id, table.role_id]),
    roleIdx: index("idx_community_board_role_grants_role").on(table.role_id),
  }),
);

/** 题解、讨论和短动态统一内容表。 */
export const communityPosts = pgTable(
  "community_posts",
  {
    id: text("id").primaryKey(),
    public_id: publicIdColumn("post"),
    type: text("type").notNull(),
    author_id: text("author_id").notNull().references(() => users.id, {
      onDelete: "cascade",
    }),
    problem_id: text("problem_id").references(() => problems.id, {
      onDelete: "cascade",
    }),
    board_id: text("board_id").references(() => communityBoards.id, {
      onDelete: "set null",
    }),
    title: text("title"),
    content: text("content").notNull(),
    status: text("status").notNull().default("published"),
    is_locked: boolean("is_locked").notNull().default(false),
    is_pinned: boolean("is_pinned").notNull().default(false),
    moderation_reason: text("moderation_reason"),
    published_at: text("published_at"),
    created_at: text("created_at").notNull(),
    updated_at: text("updated_at").notNull(),
  },
  (table) => ({
    publicIdUnique: unique("community_posts_public_id_unique").on(
      table.public_id,
    ),
    typeCheck: check(
      "community_posts_type_check",
      sql`${table.type} IN ('solution', 'discussion', 'moment')`,
    ),
    statusCheck: check(
      "community_posts_status_check",
      sql`${table.status} IN ('draft', 'pending', 'published', 'hidden', 'deleted')`,
    ),
    contextCheck: check(
      "community_posts_context_check",
      sql`(
        (${table.type} = 'solution' AND ${table.problem_id} IS NOT NULL AND ${table.board_id} IS NULL AND ${table.title} IS NOT NULL)
        OR (${table.type} = 'discussion' AND ${table.board_id} IS NOT NULL AND ${table.problem_id} IS NULL AND ${table.title} IS NOT NULL)
        OR (${table.type} = 'moment' AND ${table.problem_id} IS NULL AND ${table.board_id} IS NULL AND ${table.title} IS NULL)
      )`,
    ),
    authorIdx: index("idx_community_posts_author").on(
      table.author_id,
      table.created_at,
    ),
    problemIdx: index("idx_community_posts_problem").on(
      table.problem_id,
      table.created_at,
    ),
    boardIdx: index("idx_community_posts_board").on(
      table.board_id,
      table.created_at,
    ),
    publishedIdx: index("idx_community_posts_published").on(
      table.type,
      table.is_pinned,
      table.created_at,
    ).where(sql`${table.status} = 'published'`),
    pendingIdx: index("idx_community_posts_pending").on(table.created_at).where(
      sql`${table.status} = 'pending'`,
    ),
  }),
);

/** 社区评论，仅允许一级回复。 */
export const communityComments = pgTable(
  "community_comments",
  {
    id: text("id").primaryKey(),
    post_id: text("post_id").notNull().references(() => communityPosts.id, {
      onDelete: "cascade",
    }),
    author_id: text("author_id").notNull().references(() => users.id, {
      onDelete: "cascade",
    }),
    parent_id: text("parent_id").references(
      (): AnyPgColumn => communityComments.id,
      { onDelete: "cascade" },
    ),
    content: text("content").notNull(),
    status: text("status").notNull().default("published"),
    moderation_reason: text("moderation_reason"),
    created_at: text("created_at").notNull(),
    updated_at: text("updated_at").notNull(),
  },
  (table) => ({
    statusCheck: check(
      "community_comments_status_check",
      sql`${table.status} IN ('pending', 'published', 'hidden', 'deleted')`,
    ),
    postIdx: index("idx_community_comments_post").on(
      table.post_id,
      table.created_at,
    ),
    authorIdx: index("idx_community_comments_author").on(table.author_id),
    parentIdx: index("idx_community_comments_parent").on(table.parent_id),
  }),
);

/** 帖子点赞。 */
export const communityPostLikes = pgTable(
  "community_post_likes",
  {
    post_id: text("post_id").notNull().references(() => communityPosts.id, {
      onDelete: "cascade",
    }),
    user_id: text("user_id").notNull().references(() => users.id, {
      onDelete: "cascade",
    }),
    created_at: text("created_at").notNull(),
  },
  (table) => ({
    ...manyToManyPk([table.post_id, table.user_id]),
    userIdx: index("idx_community_post_likes_user").on(table.user_id),
  }),
);

/** 评论点赞。 */
export const communityCommentLikes = pgTable(
  "community_comment_likes",
  {
    comment_id: text("comment_id").notNull().references(
      () => communityComments.id,
      { onDelete: "cascade" },
    ),
    user_id: text("user_id").notNull().references(() => users.id, {
      onDelete: "cascade",
    }),
    created_at: text("created_at").notNull(),
  },
  (table) => ({
    ...manyToManyPk([table.comment_id, table.user_id]),
    userIdx: index("idx_community_comment_likes_user").on(table.user_id),
  }),
);

/** 帖子收藏。 */
export const communityBookmarks = pgTable(
  "community_bookmarks",
  {
    post_id: text("post_id").notNull().references(() => communityPosts.id, {
      onDelete: "cascade",
    }),
    user_id: text("user_id").notNull().references(() => users.id, {
      onDelete: "cascade",
    }),
    created_at: text("created_at").notNull(),
  },
  (table) => ({
    ...manyToManyPk([table.post_id, table.user_id]),
    userIdx: index("idx_community_bookmarks_user").on(
      table.user_id,
      table.created_at,
    ),
  }),
);

/** 用户关注关系。 */
export const communityFollows = pgTable(
  "community_follows",
  {
    follower_id: text("follower_id").notNull().references(() => users.id, {
      onDelete: "cascade",
    }),
    followee_id: text("followee_id").notNull().references(() => users.id, {
      onDelete: "cascade",
    }),
    created_at: text("created_at").notNull(),
  },
  (table) => ({
    ...manyToManyPk([table.follower_id, table.followee_id]),
    notSelfCheck: check(
      "community_follows_not_self_check",
      sql`${table.follower_id} <> ${table.followee_id}`,
    ),
    followeeIdx: index("idx_community_follows_followee").on(
      table.followee_id,
      table.created_at,
    ),
  }),
);

/** 可展示在动态流中的系统活动。 */
export const communityActivityEvents = pgTable(
  "community_activity_events",
  {
    id: text("id").primaryKey(),
    actor_id: text("actor_id").notNull().references(() => users.id, {
      onDelete: "cascade",
    }),
    type: text("type").notNull(),
    subject_type: text("subject_type").notNull(),
    subject_id: text("subject_id").notNull(),
    metadata: jsonb("metadata").notNull().default({}),
    created_at: text("created_at").notNull(),
  },
  (table) => ({
    typeCheck: check(
      "community_activity_events_type_check",
      sql`${table.type} IN ('first_accepted', 'solution_published', 'contest_joined')`,
    ),
    dedupeUnique: unique("community_activity_events_dedupe_unique").on(
      table.actor_id,
      table.type,
      table.subject_type,
      table.subject_id,
    ),
    actorIdx: index("idx_community_activity_events_actor").on(
      table.actor_id,
      table.created_at,
    ),
  }),
);

/** 帖子或评论举报。 */
export const communityReports = pgTable(
  "community_reports",
  {
    id: text("id").primaryKey(),
    reporter_id: text("reporter_id").notNull().references(() => users.id, {
      onDelete: "cascade",
    }),
    post_id: text("post_id").references(() => communityPosts.id, {
      onDelete: "set null",
    }),
    comment_id: text("comment_id").references(() => communityComments.id, {
      onDelete: "set null",
    }),
    /** 私信消息举报目标（复用社区举报处理流程） */
    message_id: text("message_id").references(() => messages.id, {
      onDelete: "set null",
    }),
    content_type: text("content_type").notNull().default("post"),
    sanction_id: text("sanction_id").references(() => communitySanctions.id, {
      onDelete: "set null",
    }),
    /** 举报处理时创建的封禁记录（复用 user_bans 封禁逻辑） */
    ban_id: text("ban_id").references(() => userBans.id, {
      onDelete: "set null",
    }),
    /** 举报分类（用户必选） */
    category: text("category").notNull().default("其他"),
    reason: text("reason").notNull(),
    content_snapshot: text("content_snapshot").notNull(),
    status: text("status").notNull().default("pending"),
    resolution: text("resolution"),
    resolved_by: text("resolved_by").references(() => users.id, {
      onDelete: "set null",
    }),
    resolved_at: text("resolved_at"),
    created_at: text("created_at").notNull(),
  },
  (table) => ({
    targetCheck: check(
      "community_reports_target_check",
      sql`num_nonnulls(${table.post_id}, ${table.comment_id}, ${table.message_id}) = 1`,
    ),
    statusCheck: check(
      "community_reports_status_check",
      sql`${table.status} IN ('pending', 'resolved', 'dismissed')`,
    ),
    categoryCheck: check(
      "community_reports_category_check",
      sql`${table.category} IN ('违法违规', '人身侵权', '涉嫌欺诈', '侵权抄袭', '垃圾信息', '站外风险引流', 'AI生成内容问题', '其他')`,
    ),
    pendingIdx: index("idx_community_reports_pending").on(table.created_at)
      .where(sql`${table.status} = 'pending'`),
    reporterIdx: index("idx_community_reports_reporter").on(table.reporter_id),
    postIdx: index("idx_community_reports_post").on(table.post_id),
    commentIdx: index("idx_community_reports_comment").on(table.comment_id),
    messageIdx: index("idx_community_reports_message").on(table.message_id),
  }),
);

/** 审核动作历史。 */
export const communityModerationActions = pgTable(
  "community_moderation_actions",
  {
    id: text("id").primaryKey(),
    moderator_id: text("moderator_id").references(() => users.id, {
      onDelete: "set null",
    }),
    action: text("action").notNull(),
    target_type: text("target_type").notNull(),
    target_id: text("target_id").notNull(),
    reason: text("reason").notNull().default(""),
    metadata: jsonb("metadata").notNull().default({}),
    created_at: text("created_at").notNull(),
  },
  (table) => ({
    targetIdx: index("idx_community_moderation_actions_target").on(
      table.target_type,
      table.target_id,
      table.created_at,
    ),
    moderatorIdx: index("idx_community_moderation_actions_moderator").on(
      table.moderator_id,
    ),
  }),
);

/** 社区写操作处罚，不影响评测与账号登录。 */
export const communitySanctions = pgTable(
  "community_sanctions",
  {
    id: text("id").primaryKey(),
    user_id: text("user_id").notNull().references(() => users.id, {
      onDelete: "cascade",
    }),
    reason: text("reason").notNull(),
    expires_at: text("expires_at"),
    created_by: text("created_by").references(() => users.id, {
      onDelete: "set null",
    }),
    created_at: text("created_at").notNull(),
    revoked_at: text("revoked_at"),
    revoked_by: text("revoked_by").references(() => users.id, {
      onDelete: "set null",
    }),
  },
  (table) => ({
    activeIdx: index("idx_community_sanctions_active").on(table.user_id).where(
      sql`${table.revoked_at} IS NULL`,
    ),
    creatorIdx: index("idx_community_sanctions_creator").on(table.created_by),
  }),
);

/** 社区通知。 */
export const communityNotifications = pgTable(
  "community_notifications",
  {
    id: text("id").primaryKey(),
    recipient_id: text("recipient_id").notNull().references(() => users.id, {
      onDelete: "cascade",
    }),
    actor_id: text("actor_id").references(() => users.id, {
      onDelete: "set null",
    }),
    type: text("type").notNull(),
    post_id: text("post_id").references(() => communityPosts.id, {
      onDelete: "set null",
    }),
    comment_id: text("comment_id").references(() => communityComments.id, {
      onDelete: "set null",
    }),
    data: jsonb("data").notNull().default({}),
    read_at: text("read_at"),
    created_at: text("created_at").notNull(),
  },
  (table) => ({
    typeCheck: check(
      "community_notifications_type_check",
      sql`${table.type} IN ('reply', 'like', 'follow', 'moderation', 'clarification', 'report', 'ban')`,
    ),
    recipientIdx: index("idx_community_notifications_recipient").on(
      table.recipient_id,
      table.created_at,
    ),
    unreadIdx: index("idx_community_notifications_unread").on(
      table.recipient_id,
      table.created_at,
    ).where(sql`${table.read_at} IS NULL`),
    actorIdx: index("idx_community_notifications_actor").on(table.actor_id),
    postIdx: index("idx_community_notifications_post").on(table.post_id),
    commentIdx: index("idx_community_notifications_comment").on(
      table.comment_id,
    ),
  }),
);
