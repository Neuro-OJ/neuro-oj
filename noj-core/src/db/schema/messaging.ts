import {
  check,
  index,
  pgTable,
  primaryKey,
  text,
  unique,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { users } from "./identity.ts";

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
