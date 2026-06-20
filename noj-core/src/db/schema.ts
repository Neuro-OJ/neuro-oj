import {
  index,
  integer,
  pgTable,
  text,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import type { SubmissionStatus } from "../types/index.ts";

/**
 * 用户表。
 * 存储注册用户的基本信息和角色权限。
 */
export const users = pgTable(
  "users",
  {
    id: text("id").primaryKey(),
    username: text("username").notNull().unique(),
    email: text("email").notNull().unique(),
    password_hash: text("password_hash").notNull(),
    role: text("role").notNull().default("user"),
    created_at: text("created_at").notNull(),
    updated_at: text("updated_at").notNull(),
  },
);

/**
 * 题目表。
 * 每道题定义独立的评测环境（Docker 镜像 + 支持包 + 评测命令）。
 * 不包含 test_cases——测试用例由支持包 zip 内的评测脚本自行管理。
 */
export const problems = pgTable("problems", {
  id: text("id").primaryKey(),
  title: text("title").notNull(),
  description: text("description").notNull(),
  difficulty: text("difficulty").notNull().default("medium"),
  judge_image: text("judge_image").notNull(),
  judge_command: text("judge_command").notNull(),
  /** 支持包 zip 路径，相对 CWD。如 "data/problems/abc-123/support.zip" */
  support_package_path: text("support_package_path"),
  time_limit_ms: integer("time_limit_ms").notNull().default(5000),
  memory_limit_mb: integer("memory_limit_mb").notNull().default(512),
  created_at: text("created_at").notNull(),
  updated_at: text("updated_at").notNull(),
});

/**
 * 提交记录表。
 * 用户提交代码后生成一条记录，评测状态流转：
 * pending → judging → finished
 */
export const submissions = pgTable(
  "submissions",
  {
    id: text("id").primaryKey(),
    user_id: text("user_id").notNull().references(() => users.id),
    problem_id: text("problem_id").notNull().references(() => problems.id),
    language: text("language").notNull(),
    code: text("code").notNull(),
    file_name: text("file_name"),
    status: text("status").$type<SubmissionStatus>().notNull().default(
      "pending",
    ),
    created_at: text("created_at").notNull(),
  },
  (table) => ({
    user_idx: index("idx_submissions_user_id").on(table.user_id),
    problem_idx: index("idx_submissions_problem_id").on(table.problem_id),
    status_idx: index("idx_submissions_status").on(table.status),
    created_at_idx: index("idx_submissions_created_at").on(table.created_at),
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
  }),
);
