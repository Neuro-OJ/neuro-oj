import {
  bigint,
  check,
  index,
  pgTable,
  primaryKey,
  text,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { domains } from "./workspace.ts";
import { storageObjects } from "./system.ts";

/** 源域上传和提交产物的计量归属；共享引用不在目标域复制此记录。 */
export const domainStorageObjects = pgTable("domain_storage_objects", {
  domain_id: text("domain_id").notNull().references(() => domains.id),
  storage_url: text("storage_url").notNull().references(() =>
    storageObjects.storage_url
  ),
  byte_size: bigint("byte_size", { mode: "number" }).notNull(),
  created_at: text("created_at").notNull(),
}, (t) => ({
  pk: primaryKey({ columns: [t.domain_id, t.storage_url] }),
  sizeCheck: check(
    "domain_storage_objects_size_check",
    sql`${t.byte_size} >= 0`,
  ),
  objectIdx: index("idx_domain_storage_objects_url").on(t.storage_url),
}));

/** 上传容量在物理写入前持久预留，结算／释放可由同一预约幂等重试。 */
export const domainStorageUploads = pgTable("domain_storage_uploads", {
  id: text("id").primaryKey(),
  domain_id: text("domain_id").notNull().references(() => domains.id),
  byte_size: bigint("byte_size", { mode: "number" }).notNull(),
  state: text("state").$type<"reserved" | "settled" | "released">().notNull()
    .default("reserved"),
  storage_url: text("storage_url").references(() => storageObjects.storage_url),
  created_at: text("created_at").notNull(),
  expires_at: text("expires_at").notNull(),
  finished_at: text("finished_at"),
}, (t) => ({
  sizeCheck: check(
    "domain_storage_uploads_size_check",
    sql`${t.byte_size} >= 0`,
  ),
  stateCheck: check(
    "domain_storage_uploads_state_check",
    sql`${t.state} IN ('reserved', 'settled', 'released')`,
  ),
  resultCheck: check(
    "domain_storage_uploads_result_check",
    sql`(${t.state} = 'settled' AND ${t.storage_url} IS NOT NULL AND ${t.finished_at} IS NOT NULL) OR (${t.state} = 'released' AND ${t.finished_at} IS NOT NULL) OR (${t.state} = 'reserved' AND ${t.finished_at} IS NULL)`,
  ),
  domainIdx: index("idx_domain_storage_uploads_domain").on(
    t.domain_id,
    t.state,
  ),
  expiryIdx: index("idx_domain_storage_uploads_expiry").on(
    t.state,
    t.expires_at,
  ),
}));
