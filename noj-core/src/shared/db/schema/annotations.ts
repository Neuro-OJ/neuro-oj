import {
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  unique,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { domains } from "./workspace.ts";
import { users } from "./identity.ts";
import type {
  AnnotationAnchor,
  AnnotationTarget,
} from "../../annotation-types.ts";

/** 原文快照按使用域、稳定目标及内容指纹去重；读取仍检查当前原文授权。 */
export const annotationSources = pgTable("annotation_sources", {
  id: text("id").primaryKey(),
  domain_id: text("domain_id").notNull().references(() => domains.id),
  target: jsonb("target").$type<AnnotationTarget>().notNull(),
  target_key: text("target_key").notNull(),
  content_hash: text("content_hash").notNull(),
  content: text("content").notNull(),
  created_at: text("created_at").notNull(),
}, (t) => ({
  identity: unique("annotation_sources_domain_identity_unique").on(
    t.domain_id,
    t.id,
  ),
  version: unique("annotation_sources_version_unique").on(
    t.domain_id,
    t.target_key,
    t.content_hash,
  ),
  hash: check(
    "annotation_sources_hash_check",
    sql`${t.content_hash} ~ '^[a-f0-9]{64}$'`,
  ),
}));

/** 私密笔记与一名学生、现任教师组之间的会话，二者不隐式相互同步。 */
export const annotationThreads = pgTable("annotation_threads", {
  id: text("id").primaryKey(),
  domain_id: text("domain_id").notNull().references(() => domains.id),
  source_id: text("source_id").notNull(),
  owner_id: text("owner_id").notNull().references(() => users.id),
  student_id: text("student_id").references(() => users.id),
  visibility: text("visibility").$type<"private" | "teaching">().notNull()
    .default("private"),
  anchor: jsonb("anchor").$type<AnnotationAnchor>().notNull(),
  state: text("state").$type<"open" | "resolved">().notNull().default("open"),
  revision: integer("revision").notNull().default(0),
  created_at: text("created_at").notNull(),
  updated_at: text("updated_at").notNull(),
  withdrawn_at: text("withdrawn_at"),
}, (t) => ({
  identity: unique("annotation_threads_domain_identity_unique").on(
    t.domain_id,
    t.id,
  ),
  source: foreignKey({
    name: "annotation_threads_source_domain_fk",
    columns: [t.domain_id, t.source_id],
    foreignColumns: [annotationSources.domain_id, annotationSources.id],
  }),
  audience: check(
    "annotation_threads_audience_check",
    sql`(${t.visibility} = 'private' AND ${t.student_id} IS NULL) OR (${t.visibility} = 'teaching' AND ${t.student_id} IS NOT NULL)`,
  ),
  state: check(
    "annotation_threads_state_check",
    sql`${t.state} IN ('open','resolved') AND ${t.revision} >= 0`,
  ),
  owner: index("idx_annotation_threads_owner").on(
    t.domain_id,
    t.owner_id,
    t.created_at,
    t.id,
  ),
  student: index("idx_annotation_threads_student").on(
    t.domain_id,
    t.student_id,
    t.created_at,
    t.id,
  ),
  sourceIndex: index("idx_annotation_threads_source").on(
    t.domain_id,
    t.source_id,
  ),
}));

/** 消息编辑保留稳定作者，撤回不删除原文定位和审计依据。 */
export const annotationMessages = pgTable("annotation_messages", {
  id: text("id").primaryKey(),
  domain_id: text("domain_id").notNull(),
  thread_id: text("thread_id").notNull(),
  author_id: text("author_id").notNull().references(() => users.id),
  body: text("body").notNull(),
  revision: integer("revision").notNull().default(0),
  created_at: text("created_at").notNull(),
  updated_at: text("updated_at").notNull(),
  withdrawn_at: text("withdrawn_at"),
}, (t) => ({
  thread: foreignKey({
    name: "annotation_messages_thread_domain_fk",
    columns: [t.domain_id, t.thread_id],
    foreignColumns: [annotationThreads.domain_id, annotationThreads.id],
  }),
  revision: check(
    "annotation_messages_revision_check",
    sql`${t.revision} >= 0 AND length(${t.body}) BETWEEN 1 AND 30000`,
  ),
  threadIndex: index("idx_annotation_messages_thread").on(
    t.thread_id,
    t.created_at,
    t.id,
  ),
}));

/** 幂等结果仅保存资源身份；重试仍重新授权，不缓存私密正文。 */
export const annotationOperations = pgTable(
  "annotation_operations",
  {
    id: text("id").primaryKey(),
    domain_id: text("domain_id").notNull().references(() => domains.id),
    actor_id: text("actor_id").notNull().references(() => users.id),
    operation: text("operation").notNull(),
    key: text("key").notNull(),
    request_hash: text("request_hash").notNull(),
    resource_id: text("resource_id").notNull(),
    created_at: text("created_at").notNull(),
  },
  (t) => ({
    identity: unique("annotation_operations_identity_unique").on(
      t.domain_id,
      t.actor_id,
      t.operation,
      t.key,
    ),
  }),
);

/** 通知不保存正文、原文引用或姓名，列表和未读数重查当前会话授权。 */
export const annotationNotifications = pgTable("annotation_notifications", {
  id: text("id").primaryKey(),
  domain_id: text("domain_id").notNull(),
  thread_id: text("thread_id").notNull(),
  message_id: text("message_id").notNull().references(() =>
    annotationMessages.id
  ),
  user_id: text("user_id").notNull().references(() => users.id),
  created_at: text("created_at").notNull(),
  read_at: text("read_at"),
}, (t) => ({
  thread: foreignKey({
    name: "annotation_notifications_thread_domain_fk",
    columns: [t.domain_id, t.thread_id],
    foreignColumns: [annotationThreads.domain_id, annotationThreads.id],
  }),
  identity: unique("annotation_notifications_message_user_unique").on(
    t.message_id,
    t.user_id,
  ),
  inbox: index("idx_annotation_notifications_inbox").on(
    t.domain_id,
    t.user_id,
    t.created_at,
  ),
}));
