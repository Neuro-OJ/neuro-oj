import {
  check,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  unique,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { users } from "./identity.ts";
import { problems } from "./catalog.ts";
import { contests } from "./contest.ts";

/**
 * 客观题小题表。
 * 每道小题必须通过 paper_id 绑定所属套卷（problems 表 is_objective=true 行），
 * 不可孤立存在；删除套卷时级联删除全部小题。
 */
export const objectiveQuestions = pgTable(
  "objective_questions",
  {
    id: text("id").primaryKey(),
    /** 所属套卷 ID（problems.id，is_objective=true） */
    paper_id: text("paper_id")
      .notNull()
      .references(() => problems.id, { onDelete: "cascade" }),
    /** 卷内排序，同一套卷内唯一 */
    sort_order: integer("sort_order").notNull().default(0),
    /** 题型：single=单选, multiple=多选, judge=判断 */
    type: text("type").notNull(),
    /** 题干（Markdown） */
    prompt: text("prompt").notNull(),
    /** 选项数组 [{key, text}]；judge 型为空数组 */
    options: jsonb("options").notNull().default([]),
    /** 标准答案：["A"] / ["A","C"] / [true] */
    answer: jsonb("answer").notNull(),
    /** 答案解析（判卷后展示） */
    explanation: text("explanation").notNull().default(""),
    created_at: text("created_at").notNull(),
    updated_at: text("updated_at").notNull(),
  },
  (table) => ({
    paperSortUnique: unique("objective_questions_paper_sort_unique").on(
      table.paper_id,
      table.sort_order,
    ),
    typeCheck: check(
      "objective_questions_type_check",
      sql`${table.type} IN ('single', 'multiple', 'judge')`,
    ),
    paperIdx: index("idx_objective_questions_paper_id").on(table.paper_id),
  }),
);

/**
 * 客观题提交表。
 * 服务端即时判定（不走评测队列），status 直接为 finished。
 * score 为 ×100 整数（0-10000），与 evaluationResults.score 约定一致。
 */
export const objectiveSubmissions = pgTable(
  "objective_submissions",
  {
    id: text("id").primaryKey(),
    /** 所属套卷 ID（problems.id，is_objective=true） */
    paper_id: text("paper_id")
      .notNull()
      .references(() => problems.id, { onDelete: "cascade" }),
    user_id: text("user_id").notNull().references(() => users.id),
    /** 竞赛提交时非空；练习模式为 NULL */
    contest_id: text("contest_id").references(() => contests.id, {
      onDelete: "set null",
    }),
    /** 提交模式：practice=练习, contest=竞赛 */
    submission_type: text("submission_type").notNull(),
    /** 用户答案 {question_id: [选项...]} */
    answers: jsonb("answers").notNull(),
    /** 即时判定完成 */
    status: text("status").notNull().default("finished"),
    /** 卷面分 ×100（0-10000） */
    score: integer("score").notNull().default(0),
    /** 逐题判定 {question_id: {correct, expected, given}} */
    details: jsonb("details").notNull().default({}),
    created_at: text("created_at").notNull(),
  },
  (table) => ({
    /** 竞赛一次性提交兜底：同一竞赛内同一用户对同一套卷仅一条 */
    contestUnique: unique("objective_submissions_contest_unique").on(
      table.paper_id,
      table.user_id,
      table.contest_id,
    ),
    typeCheck: check(
      "objective_submissions_type_check",
      sql`${table.submission_type} IN ('practice', 'contest')`,
    ),
    paperIdx: index("idx_objective_submissions_paper_id").on(table.paper_id),
    userIdx: index("idx_objective_submissions_user_id").on(table.user_id),
    /** 提交历史按用户+套卷+时间倒序分页 */
    userPaperCreatedIdx: index(
      "idx_objective_submissions_user_paper_created",
    ).on(table.user_id, table.paper_id, table.created_at),
    contestIdx: index("idx_objective_submissions_contest_id").on(
      table.contest_id,
    ),
  }),
);
