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
    public_id: publicIdColumn("ct"),
    title: text("title").notNull(),
    description: text("description").notNull().default(""),
    start_time: text("start_time").notNull(),
    end_time: text("end_time").notNull(),
    /** 榜单可见性：公开、仅参赛者或完全隐藏。 */
    ranking_visibility: text("ranking_visibility").notNull().default("public"),
    /** 可选的封榜开始时间（ISO 8601）；为空时由 freeze_duration_seconds 推导。 */
    freeze_start_time: text("freeze_start_time"),
    /** 比赛结束前冻结时长（秒），0 表示不启用封榜。 */
    freeze_duration_seconds: integer("freeze_duration_seconds").notNull()
      .default(0),
    type: text("type").notNull(),
    kind: text("kind").notNull().default("public"),
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
    kindCheck: check(
      "contests_kind_check",
      sql`${table.kind} IN ('public', 'invite')`,
    ),
    timeCheck: check(
      "contests_time_check",
      sql`${table.end_time} > ${table.start_time}`,
    ),
    /**
     * 时间形态约束：强制规范 ISO 8601（UTC、毫秒、`Z`）形态。
     *
     * 背景（2026-09-14 评审 C1）：`start_time` / `end_time` 是文本列，而赛期门控
     * 曾按**字典序**与 UTC `Z` 字面量比较。`+08:00` 这类合法但非规范的形态会让
     * 比较恒为假，导致门控静默 fail-open（题解与通过率抑制同时失效）。
     *
     * 修复分三道：写侧规范化（`normalizeContestTime`）、读侧按时刻比较
     * （`contest-window.ts` 的 `::timestamptz`）、以及本条 DB 形态约束。
     * 迁移 0083 先规范化存量行再 `NOT VALID` 添加本约束——`NOT VALID` 使约束对
     * 存量行不阻塞上线，但**新写入一律校验**，从此脏形态无法再进入库。
     *
     * 正则用 `[.]` 而非 `\\.` 表示字面点：drizzle-kit 在快照 JSON 序列化时会丢掉
     * 反斜杠，`\\.` 会退化成 `.`（匹配任意字符，约束被悄悄放宽）。字符类写法
     * 无需转义，可安全往返。
     */
    timeFormatCheck: check(
      "contests_time_format_check",
      sql`${table.start_time} ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}[.][0-9]{3}Z$'
        AND ${table.end_time} ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}[.][0-9]{3}Z$'
        AND (${table.freeze_start_time} IS NULL OR ${table.freeze_start_time} ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}[.][0-9]{3}Z$')
        AND pg_input_is_valid(${table.start_time}, 'timestamptz')
        AND pg_input_is_valid(${table.end_time}, 'timestamptz')
        AND (${table.freeze_start_time} IS NULL OR pg_input_is_valid(${table.freeze_start_time}, 'timestamptz'))`,
    ),
    rankingVisibilityCheck: check(
      "contests_ranking_visibility_check",
      sql`${table.ranking_visibility} IN ('public', 'participants', 'hidden')`,
    ),
    freezeDurationCheck: check(
      "contests_freeze_duration_check",
      sql`${table.freeze_duration_seconds} >= 0`,
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
    ...manyToManyPk([table.contest_id, table.problem_id]),
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
    ...manyToManyPk([table.contest_id, table.user_id]),
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

/** 正式竞赛成绩快照；每次发布修订都新增版本，历史版本不可变。 */
export const contestRankingSnapshots = pgTable(
  "contest_ranking_snapshots",
  {
    id: text("id").primaryKey(),
    contest_id: text("contest_id").notNull().references(() => contests.id, {
      onDelete: "cascade",
    }),
    version: integer("version").notNull(),
    status: text("status").notNull().default("published"),
    note: text("note").notNull().default(""),
    rows: jsonb("rows").notNull(),
    created_by: text("created_by").references(() => users.id, {
      onDelete: "set null",
    }),
    created_at: text("created_at").notNull(),
  },
  (table) => ({
    contestVersionUnique: unique(
      "contest_ranking_snapshots_contest_version_unique",
    ).on(table.contest_id, table.version),
    contestCreatedIdx: index("idx_contest_ranking_snapshots_contest_created")
      .on(table.contest_id, table.created_at),
  }),
);
