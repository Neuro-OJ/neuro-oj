import { sql } from "drizzle-orm";
import {
  boolean,
  index,
  jsonb,
  pgTable,
  text,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { tsvector } from "./common.ts";

/**
 * 统一搜索索引表。
 * 唯一写者是 search domain；源域通过事件通知更新。
 */
export const searchEntries = pgTable(
  "search_entries",
  {
    id: text("id").primaryKey().default(sql`gen_random_uuid()`),
    entity_type: text("entity_type").notNull(),
    entity_id: text("entity_id").notNull(),
    title: text("title").notNull().default(""),
    body: text("body").notNull().default(""),
    /** tsvector 列，GENERATED 自动维护，ORM 不可写入 */
    searchVector: tsvector("search_vector"),
    metadata: jsonb("metadata").notNull().default({}),
    owner_id: text("owner_id"),
    participant_ids: text("participant_ids").array().notNull().default(
      sql`'{}'`,
    ),
    /** 已删除该消息的用户 id 列表；这些用户在该消息的搜索结果中不可见。 */
    deleted_by_user_ids: text("deleted_by_user_ids").array().notNull().default(
      sql`'{}'`,
    ),
    is_public: boolean("is_public").notNull().default(false),
    admin_only: boolean("admin_only").notNull().default(false),
    is_active: boolean("is_active").notNull().default(true),
    created_at: text("created_at").notNull(),
    updated_at: text("updated_at").notNull(),
  },
  (table) => ({
    entityUnique: uniqueIndex("idx_search_entries_entity").on(
      table.entity_type,
      table.entity_id,
    ),
    searchVectorIdx: index("idx_search_entries_vector").using(
      "gin",
      table.searchVector,
    ),
    titleTrgmIdx: index("idx_search_entries_title_trgm").using(
      "gin",
      table.title.op("gin_trgm_ops"),
    ),
    bodyTrgmIdx: index("idx_search_entries_body_trgm").using(
      "gin",
      table.body.op("gin_trgm_ops"),
    ),
    ownerIdx: index("idx_search_entries_owner").on(table.owner_id),
    participantsIdx: index("idx_search_entries_participants").using(
      "gin",
      table.participant_ids,
    ),
    publicIdx: index("idx_search_entries_public").on(table.is_public),
    updatedIdx: index("idx_search_entries_updated").on(table.updated_at),
  }),
);
