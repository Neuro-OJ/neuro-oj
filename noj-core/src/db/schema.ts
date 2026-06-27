import {
  check,
  index,
  integer,
  pgTable,
  primaryKey,
  text,
  unique,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
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
    /** 个人简介（Markdown 格式） */
    bio: text("bio").notNull().default(""),
    created_at: text("created_at").notNull(),
    updated_at: text("updated_at").notNull(),
  },
);

/**
 * 题目表。
 * 每道题定义独立的评测环境（Docker 镜像 + 支持包 + 评测命令）。
 * 不包含 test_cases——测试用例由支持包 zip 内的评测脚本自行管理。
 */
export const problems = pgTable(
  "problems",
  {
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
    /** 题号（同一 type 内独立自增） */
    number: integer("number").notNull(),
    /** 题目所有者 ID，默认 root (UID=0) */
    owner_id: text("owner_id").notNull().default("0"),
    /** 题目类型：U=用户题库, P=主题库 */
    type: text("type").notNull().default("U"),
    created_at: text("created_at").notNull(),
    updated_at: text("updated_at").notNull(),
  },
  (table) => ({
    typeNumberUnique: unique("problems_type_number_unique").on(
      table.type,
      table.number,
    ),
    typeCheck: check("problems_type_check", sql`${table.type} IN ('U', 'P')`),
  }),
);

/**
 * 分类表。
 * 树形结构，通过 parent_id 自引用实现多级分类。
 * level 字段缓存层级深度（顶级为 0），避免递归计算。
 */
export const categories = pgTable(
  "categories",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    slug: text("slug").notNull().unique(),
    description: text("description").notNull().default(""),
    // deno-lint-ignore no-explicit-any
    parent_id: text("parent_id").references((): any => categories.id, {
      onDelete: "set null",
    }),
    level: integer("level").notNull().default(0),
    created_at: text("created_at").notNull(),
    updated_at: text("updated_at").notNull(),
  },
);

/**
 * 题目-分类关联表。
 * 多对多关系，级联删除。
 */
export const problemsCategories = pgTable(
  "problems_categories",
  {
    problem_id: text("problem_id")
      .notNull()
      .references(() => problems.id, { onDelete: "cascade" }),
    category_id: text("category_id")
      .notNull()
      .references(() => categories.id, { onDelete: "cascade" }),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.problem_id, table.category_id] }),
  }),
);

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
    /** ISO 8601，开始评测时间。 */
    judge_started_at: text("judge_started_at"),
    /** ISO 8601，评测完成时间。 */
    judge_finished_at: text("judge_finished_at"),
    created_at: text("created_at").notNull(),
  },
  (table) => ({
    user_idx: index("idx_submissions_user_id").on(table.user_id),
    problem_idx: index("idx_submissions_problem_id").on(table.problem_id),
    status_idx: index("idx_submissions_status").on(table.status),
    created_at_idx: index("idx_submissions_created_at").on(table.created_at),
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
 * 签到记录表。
 * 每日每用户一条记录，streak 记录连续签到天数。
 *
 * user_id FK 使用 ON DELETE CASCADE（评审 M2）：用户被删除时
 * 关联签到记录一并删除，避免未来用户删除功能被 FK 阻止。
 */
export const checkIns = pgTable(
  "check_ins",
  {
    id: text("id").primaryKey(),
    user_id: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    checkin_date: text("checkin_date").notNull(),
    streak: integer("streak").notNull().default(1),
    created_at: text("created_at").notNull(),
  },
  (table) => ({
    userDateUnique: unique("check_ins_user_date_unique").on(
      table.user_id,
      table.checkin_date,
    ),
  }),
);

/**
 * 密码重置令牌表（issue #49）。
 * 存储密码重置流程的短期令牌：DB 存 SHA-256 哈希（不存明文），URL 传明文。
 * expires_at = created_at + 15 分钟（OWASP 2025+ 建议）。
 * used_at NULL = 未使用，原子消耗用单 SQL UPDATE 实现。
 */
export const passwordResetTokens = pgTable(
  "password_reset_tokens",
  {
    id: text("id").primaryKey(),
    user_id: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    /** 令牌 SHA-256 hex 哈希（不存明文明文 token） */
    token_hash: text("token_hash").notNull().unique(),
    /** ISO 8601，过期时间，now + 15 分钟 */
    expires_at: text("expires_at").notNull(),
    /** ISO 8601，使用时间。NULL = 未使用 */
    used_at: text("used_at"),
    created_at: text("created_at").notNull(),
  },
  (table) => ({
    user_idx: index("idx_password_reset_tokens_user_id").on(table.user_id),
    expires_idx: index("idx_password_reset_tokens_expires_at").on(
      table.expires_at,
    ),
  }),
);