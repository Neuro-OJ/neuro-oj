import {
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  unique,
} from "drizzle-orm/pg-core";
import type { AnyPgColumn } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { users } from "./identity.ts";
import { problems } from "./catalog.ts";

/**
 * 竞赛主表。
 * 竞赛状态由 start_time/end_time 动态计算，不持久化状态字段。
 */
export const contests = pgTable(
  "contests",
  {
    id: text("id").primaryKey(),
    public_id: text("public_id").notNull().default(
      sql`'ct-' || substr(md5(random()::text), 1, 8)`,
    ),
    title: text("title").notNull(),
    description: text("description").notNull().default(""),
    start_time: text("start_time").notNull(),
    end_time: text("end_time").notNull(),
    type: text("type").notNull(),
    config: jsonb("config").notNull().default({}),
    is_public: boolean("is_public").notNull().default(true),
    password: text("password"),
    affect_global_ranking: boolean("affect_global_ranking").notNull().default(
      false,
    ),
    created_by: text("created_by").references(() => users.id, {
      onDelete: "set null",
    }),
    announcement: text("announcement").notNull().default(""),
    created_at: text("created_at").notNull(),
    updated_at: text("updated_at").notNull(),
  },
  (table) => ({
    publicIdUnique: unique("contests_public_id_unique").on(table.public_id),
    typeCheck: check(
      "contests_type_check",
      sql`${table.type} IN ('kaggle')`,
    ),
    timeCheck: check(
      "contests_time_check",
      sql`${table.end_time} > ${table.start_time}`,
    ),
    configCheck: check(
      "contests_config_check",
      sql`jsonb_typeof(${table.config}) = 'object'`,
    ),
    createdByIdx: index("idx_contests_created_by").on(table.created_by),
    startTimeIdx: index("idx_contests_start_time").on(table.start_time),
    endTimeIdx: index("idx_contests_end_time").on(table.end_time),
  }),
);

/**
 * 竞赛题目关联表。
 * label 和 sort_order 在单个竞赛内保持唯一。
 */
export const contestProblems = pgTable(
  "contest_problems",
  {
    contest_id: text("contest_id")
      .notNull()
      .references(() => contests.id, { onDelete: "cascade" }),
    problem_id: text("problem_id")
      .notNull()
      .references(() => problems.id, { onDelete: "cascade" }),
    sort_order: integer("sort_order").notNull().default(0),
    label: text("label").notNull(),
    score: integer("score").notNull(),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.contest_id, table.problem_id] }),
    labelUnique: unique("contest_problems_contest_label_unique").on(
      table.contest_id,
      table.label,
    ),
    sortOrderUnique: unique("contest_problems_contest_sort_order_unique").on(
      table.contest_id,
      table.sort_order,
    ),
  }),
);

/**
 * 竞赛参与者表。
 */
export const contestParticipants = pgTable(
  "contest_participants",
  {
    contest_id: text("contest_id")
      .notNull()
      .references(() => contests.id, { onDelete: "cascade" }),
    user_id: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    registered_at: text("registered_at").notNull(),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.contest_id, table.user_id] }),
    userIdx: index("idx_contest_participants_user").on(table.user_id),
  }),
);

/**
 * 竞赛答疑表。
 * API 将在后续阶段实现，当前先建立数据模型。
 */
export const contestClarifications = pgTable(
  "contest_clarifications",
  {
    id: text("id").primaryKey(),
    contest_id: text("contest_id")
      .notNull()
      .references(() => contests.id, { onDelete: "cascade" }),
    problem_id: text("problem_id").references(() => problems.id, {
      onDelete: "set null",
    }),
    sender_id: text("sender_id").notNull().references(() => users.id),
    content: text("content").notNull(),
    reply_to_id: text("reply_to_id").references(
      (): AnyPgColumn => contestClarifications.id,
    ),
    is_public: boolean("is_public").notNull().default(false),
    created_at: text("created_at").notNull(),
  },
  (table) => ({
    contestIdx: index("idx_contest_clarifications_contest").on(
      table.contest_id,
      table.created_at,
    ),
  }),
);
