import {
  boolean,
  check,
  index,
  pgTable,
  primaryKey,
  text,
  unique,
} from "drizzle-orm/pg-core";
import type { AnyPgColumn } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { users } from "./identity.ts";

/**
 * 私信会话表。
 * 每对用户只有一个会话，通过 user1_id < user2_id 约束确保去重。
 * last_message_at 为反范式缓存，用于会话列表排序。
 */
export const conversations = pgTable(
  "conversations",
  {
    id: text("id").primaryKey(),
    user1_id: text("user1_id")
      .notNull()
      .references(() => users.id),
    user2_id: text("user2_id")
      .notNull()
      .references(() => users.id),
    /** ISO 8601，最后一条消息时间（用于列表排序） */
    last_message_at: text("last_message_at").notNull(),
    created_at: text("created_at").notNull(),
  },
  (table) => ({
    userPairUnique: unique("conversations_user_pair_unique").on(
      table.user1_id,
      table.user2_id,
    ),
    userOrderCheck: check(
      "conversations_user_order_check",
      sql`${table.user1_id} < ${table.user2_id}`,
    ),
    user1_idx: index("idx_conversations_user1_id").on(table.user1_id),
    user2_idx: index("idx_conversations_user2_id").on(table.user2_id),
    last_msg_idx: index("idx_conversations_last_message_at").on(
      table.last_message_at,
    ),
  }),
);

/**
 * 私信消息表。
 * 支持文本与图片消息（type: text | image）。
 * 引用回复（reply_to_message_id）、转发（forwarded_from_user_id）。
 * 支持软删除（见 message_deletions 表）。
 * 物理删除使用 ON DELETE CASCADE 从会话级联清理。
 */
export const messages = pgTable(
  "messages",
  {
    id: text("id").primaryKey(),
    conversation_id: text("conversation_id")
      .notNull()
      .references(() => conversations.id, { onDelete: "cascade" }),
    sender_id: text("sender_id")
      .notNull()
      .references(() => users.id),
    /** 消息类型：text（默认）| image */
    type: text("type").notNull().default("text"),
    /** 图片消息的存储 URL（noj-storage://），type=image 时必填 */
    image_url: text("image_url"),
    /** 引用回复：被引用的消息 ID（同会话内） */
    reply_to_message_id: text("reply_to_message_id").references(
      (): AnyPgColumn => messages.id,
      { onDelete: "set null" },
    ),
    /** 转发来源用户 ID（快照复制时记录来源） */
    forwarded_from_user_id: text("forwarded_from_user_id").references(
      () => users.id,
      { onDelete: "set null" },
    ),
    content: text("content").notNull(),
    created_at: text("created_at").notNull(),
    /** 编辑时间（null 表示未编辑；编辑后前端显示"已编辑"小字） */
    edited_at: text("edited_at"),
    /** 撤回时间（null 表示未撤回；撤回后前端显示系统提示） */
    recalled_at: text("recalled_at"),
    /** 编辑历史（JSON 数组，仅后台保存，不对外展示） */
    edit_history: text("edit_history"),
  },
  (table) => ({
    conv_created_idx: index("idx_messages_conversation_created").on(
      table.conversation_id,
      table.created_at,
    ),
    sender_idx: index("idx_messages_sender_id").on(table.sender_id),
    typeCheck: check(
      "messages_type_check",
      sql`${table.type} IN ('text', 'image')`,
    ),
  }),
);

/**
 * 消息表情反应表。
 * 同一用户对同一消息仅保留一个 reaction（复合主键保证），重复提交替换。
 * 消息或用户物理删除时通过 CASCADE 自动清理。
 */
export const messageReactions = pgTable(
  "message_reactions",
  {
    message_id: text("message_id")
      .notNull()
      .references(() => messages.id, { onDelete: "cascade" }),
    user_id: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    /** 表情符号（取自固定常用集合，见 messages service 的 REACTION_EMOJIS） */
    emoji: text("emoji").notNull(),
    created_at: text("created_at").notNull(),
  },
  (table) => ({
    // 主键含 emoji：同一用户对同一消息可添加多个不同 reaction
    pk: primaryKey({ columns: [table.message_id, table.user_id, table.emoji] }),
    msg_idx: index("idx_message_reactions_message_id").on(table.message_id),
  }),
);

/**
 * 会话已读状态表。
 * 记录每个用户在每个会话中的最后阅读位置。
 * last_read_message_id 为 NULL 表示从未阅读。
 */
export const conversationReads = pgTable(
  "conversation_reads",
  {
    user_id: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    conversation_id: text("conversation_id")
      .notNull()
      .references(() => conversations.id, { onDelete: "cascade" }),
    last_read_message_id: text("last_read_message_id"),
    updated_at: text("updated_at").notNull(),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.user_id, table.conversation_id] }),
  }),
);

/**
 * 消息单用户删除记录表。
 * 用户删除消息仅删除自己视角，原始消息仍保留（对方可见）。
 * 用户或消息物理删除时通过 CASCADE 自动清理。
 */
export const messageDeletions = pgTable(
  "message_deletions",
  {
    user_id: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    message_id: text("message_id")
      .notNull()
      .references(() => messages.id, { onDelete: "cascade" }),
    deleted_at: text("deleted_at").notNull(),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.user_id, table.message_id] }),
    msg_idx: index("idx_message_deletions_message_id").on(table.message_id),
  }),
);

/**
 * 会话偏好表（每用户每会话视角配置）。
 * - remark_name：备注名（非空时列表/顶部栏显示备注名）
 * - is_muted：消息免打扰（开启后仅显示红点不显示数量）
 */
export const conversationPreferences = pgTable(
  "conversation_preferences",
  {
    user_id: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    conversation_id: text("conversation_id")
      .notNull()
      .references(() => conversations.id, { onDelete: "cascade" }),
    /** 备注名（NULL/空 = 使用对方真实用户名） */
    remark_name: text("remark_name"),
    /** 消息免打扰：true = 新消息仅显示红点不显示数量 */
    is_muted: boolean("is_muted").notNull().default(false),
    updated_at: text("updated_at").notNull(),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.user_id, table.conversation_id] }),
    convIdx: index("idx_conversation_preferences_conv").on(
      table.conversation_id,
    ),
  }),
);
