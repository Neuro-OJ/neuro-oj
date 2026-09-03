import {
  check,
  index,
  integer,
  jsonb,
  pgTable,
  serial,
  text,
  unique,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { publicIdColumn } from "./common.ts";
import type { SubmissionStatus } from "../../../types/index.ts";
import type { SelfTestStatus } from "../../../types/self-tests.ts";
import { users } from "./identity.ts";
import { problems } from "./catalog.ts";
import { contests } from "./contest.ts";

/**
 * 提交记录表。
 * 用户提交代码后生成一条记录，评测状态流转：
 * pending → judging → finished
 */
export const submissions = pgTable(
  "submissions",
  {
    id: text("id").primaryKey(),
    public_id: publicIdColumn("sub"),
    user_id: text("user_id").notNull().references(() => users.id),
    problem_id: text("problem_id").notNull().references(() => problems.id),
    contest_id: text("contest_id").references(() => contests.id, {
      onDelete: "set null",
    }),
    language: text("language").notNull(),
    code: text("code").notNull(),
    file_name: text("file_name"),
    /** artifact 提交的存储 URL（`noj-storage://`），code 模式为 NULL */
    artifact_storage_url: text("artifact_storage_url"),
    /** 可选的用户 BYOK Provider；密钥由 noj-llm-gateway 托管 */
    llm_provider_config_id: text("llm_provider_config_id"),
    status: text("status").$type<SubmissionStatus>().notNull().default(
      "pending",
    ),
    /** 重测序列号，递增。用于区分新旧评测结果，防止竞态覆盖。 */
    rejudge_seq: integer("rejudge_seq").notNull().default(0),
    /** ISO 8601，开始评测时间。 */
    judge_started_at: text("judge_started_at"),
    /** ISO 8601，评测完成时间。 */
    judge_finished_at: text("judge_finished_at"),
    created_at: text("created_at").notNull(),
  },
  (table) => ({
    publicIdUnique: unique("submissions_public_id_unique").on(table.public_id),
    user_idx: index("idx_submissions_user_id").on(table.user_id),
    problem_idx: index("idx_submissions_problem_id").on(table.problem_id),
    status_idx: index("idx_submissions_status").on(table.status),
    created_at_idx: index("idx_submissions_created_at").on(table.created_at),
    contest_idx: index("idx_submissions_contest_id").on(table.contest_id),
    llm_provider_config_idx: index("idx_submissions_llm_provider_config_id").on(
      table.llm_provider_config_id,
    ),
    contest_problem_user_idx: index(
      "idx_submissions_contest_problem_user",
    ).on(
      table.contest_id,
      table.problem_id,
      table.user_id,
      table.created_at,
    ),
    // 复合索引：用户提交历史按时间倒序分页（issue 64 评论 §6.4）
    // 优化 "WHERE user_id = ? ORDER BY created_at DESC" 场景
    user_created_idx: index("idx_submissions_user_id_created_at").on(
      table.user_id,
      table.created_at,
    ),
  }),
);

/**
 * 评测结果表。
 * 与提交记录 1:1 关联。score 存储 ×100 后的整数值（避免浮点误差）。
 * details 为 JSON 结构，格式由题目自定义评测命令决定。
 */
export const evaluationResults = pgTable(
  "evaluation_results",
  {
    id: text("id").primaryKey(),
    submission_id: text("submission_id")
      .notNull()
      .references(() => submissions.id),
    status: text("status").notNull(),
    score: integer("score").notNull().default(0),
    output: text("output").notNull().default(""),
    details: text("details").notNull().default("{}"),
    time_ms: integer("time_ms"),
    memory_kb: integer("memory_kb"),
    created_at: text("created_at").notNull(),
  },
  (table) => ({
    submission_idx: uniqueIndex("idx_eval_results_submission_id").on(
      table.submission_id,
    ),
    // created_at 索引：评测结果按时间分页与归档（issue 64 评论 §6.4）
    created_at_idx: index("idx_eval_results_created_at").on(table.created_at),
  }),
);

/**
 * 自测记录表（issue #221）。
 * 与正式提交完全隔离，不参与统计/榜单/AC 活动。
 */
export const selfTests = pgTable(
  "self_tests",
  {
    id: text("id").primaryKey(),
    user_id: text("user_id")
      .notNull()
      .references(() => users.id),
    problem_id: text("problem_id")
      .notNull()
      .references(() => problems.id),
    language: text("language").notNull(),
    code: text("code").notNull(),
    file_name: text("file_name"),
    status: text("status").$type<SelfTestStatus>().notNull().default(
      "pending",
    ),
    /** 评测结果状态（新协议下为 finished / error），终态时由 JudgeResult 写入。 */
    result_status: text("result_status"),
    score: integer("score").notNull().default(0),
    output: text("output").notNull().default(""),
    details: text("details").notNull().default("{}"),
    time_ms: integer("time_ms"),
    memory_kb: integer("memory_kb"),
    judge_started_at: text("judge_started_at"),
    judge_finished_at: text("judge_finished_at"),
    created_at: text("created_at").notNull(),
  },
  (table) => ({
    user_idx: index("idx_self_tests_user_id").on(table.user_id),
    problem_idx: index("idx_self_tests_problem_id").on(table.problem_id),
    created_at_idx: index("idx_self_tests_created_at").on(table.created_at),
    user_created_idx: index("idx_self_tests_user_id_created_at").on(
      table.user_id,
      table.created_at,
    ),
    status_created_idx: index("idx_self_tests_status_created_at").on(
      table.status,
      table.created_at,
    ),
    statusCheck: check(
      "self_tests_status_check",
      sql`${table.status} IN ('pending', 'judging', 'finished', 'error')`,
    ),
  }),
);

/**
 * SSE 事件日志表。
 *
 * 全局单调 `id` 作为 SSE 的 Last-Event-ID；所有 SSE 频道共享此表，
 * 通过 `channel` 区分。事件在状态变更处写入，随后发布 Redis 通知。
 */
export const sseEvents = pgTable(
  "sse_events",
  {
    id: serial("id").primaryKey(),
    channel: text("channel").notNull(),
    payload: jsonb("payload").notNull(),
    created_at: text("created_at").notNull(),
  },
  (table) => ({
    channelIdx: index("idx_sse_events_channel_id").on(table.channel, table.id),
  }),
);
