import { check, index, pgTable, text, unique } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { manyToManyPk } from "./common.ts";
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
 * 1-10000 字符文本消息。支持软删除（见 message_deletions 表）。
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
    content: text("content").notNull(),
    created_at: text("created_at").notNull(),
  },
  (table) => ({
    conv_created_idx: index("idx_messages_conversation_created").on(
      table.conversation_id,
      table.created_at,
    ),
    sender_idx: index("idx_messages_sender_id").on(table.sender_id),
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
    ...manyToManyPk([table.user_id, table.conversation_id]),
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
    ...manyToManyPk([table.user_id, table.message_id]),
    msg_idx: index("idx_message_deletions_message_id").on(table.message_id),
  }),
);
