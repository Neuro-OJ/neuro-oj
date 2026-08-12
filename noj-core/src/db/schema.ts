import {
  boolean,
  check,
  customType,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  unique,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import type { AnyPgColumn } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import type { SubmissionStatus } from "../types/index.ts";
import { ROOT_USER_ID } from "../lib/constants.ts";

/**
 * Postgres `tsvector` 列（用于全文搜索）。
 * Drizzle ORM 0.45.x 不导出原生 tsvector 列类型，使用 customType 注册一个。
 * 对应列在 DB 层由 GENERATED ... STORED 自动维护，ORM 不可写入。
 *
 * 参考 https://orm.drizzle.team/docs/custom-types
 */
const tsvector = customType<{ data: string }>({
  dataType() {
    return "tsvector";
  },
});

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
    /** 个人简介（Markdown 格式） */
    bio: text("bio").notNull().default(""),
    /**
     * 是否必须在下一次登录后修改密码（issue #75）。
     * - 引导管理员 / ADMIN_EMAIL+ADMIN_PASS 创建的初始账号设为 true
     * - 历史用户保持 false，向前兼容
     * - authMiddleware 在 token 携带 true 且请求不在白名单内时返回 403
     */
    must_change_password: boolean("must_change_password").notNull().default(
      false,
    ),
    /** 社区系统活动可见范围：hidden / following / everyone */
    community_activity_visibility: text("community_activity_visibility")
      .notNull().default("following"),
    /** 用户头像存储 URL（`noj-storage://` 格式），NULL = 未设置 */
    avatar_url: text("avatar_url"),
    created_at: text("created_at").notNull(),
    updated_at: text("updated_at").notNull(),
    /** tsvector 列，GENERATED 自动维护 */
    searchVector: tsvector("search_vector"),
  },
  (table) => ({
    searchVectorIdx: index("idx_users_search_vector").using(
      "gin",
      table.searchVector,
    ),
    communityActivityVisibilityCheck: check(
      "users_community_activity_visibility_check",
      sql`${table.community_activity_visibility} IN ('hidden', 'following', 'everyone')`,
    ),
  }),
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
    /** 支持包存储 URL（`noj-storage://` 格式） */
    support_package_storage_url: text("support_package_storage_url"),
    /**
     * 双容器 Runtime 配置（U/P 型必填；客观题套卷 is_objective=true 时为 NULL）。
     * 包含 evaluator 和 solution 两个容器的运行时配置。
     */
    runtime_config: jsonb("runtime_config"),
    /** 题号（同一 type 内独立自增） */
    number: integer("number").notNull(),
    /** 题目所有者 ID，默认 root (UID=0) */
    owner_id: text("owner_id").notNull().default(ROOT_USER_ID),
    /** 题目类型：U=用户题库, P=主题库 */
    type: text("type").notNull().default("U"),
    /** 客观题标记：true 表示该题目是客观题套卷（无评测容器，服务端即时判定） */
    is_objective: boolean("is_objective").notNull().default(false),
    created_at: text("created_at").notNull(),
    updated_at: text("updated_at").notNull(),
    /** tsvector 列，GENERATED 自动维护，ORM 不可写入 */
    searchVector: tsvector("search_vector"),
  },
  (table) => ({
    typeNumberUnique: unique("problems_type_number_unique").on(
      table.type,
      table.number,
    ),
    typeCheck: check(
      "problems_type_check",
      sql`${table.type} IN ('U', 'P')`,
    ),
    searchVectorIdx: index("idx_problems_search_vector").using(
      "gin",
      table.searchVector,
    ),
    runtimeConfigCheck: check(
      "problems_runtime_config_check",
      sql`${table.runtime_config} IS NULL OR jsonb_typeof(${table.runtime_config}) = 'object'`,
    ),
  }),
);

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

/**
 * 评测镜像白名单表。
 * 管理员通过此表配置允许使用的 Docker 评测镜像。
 * mode='exact' 时仅精确匹配指定镜像名；
 * mode='all_versions' 时匹配该镜像名（不含标签部分）的所有版本。
 */
export const judgeImages = pgTable(
  "judge_images",
  {
    id: text("id").primaryKey(),
    image: text("image").notNull(),
    mode: text("mode").notNull().default("exact"),
    /**
     * 镜像用途分类（dual-container-judge §5）。
     * - 'evaluator'：单容器 / 双容器 Evaluator 角色
     * - 'solution' ：双容器 Solution 角色
     *
     * 历史数据迁移时默认 'evaluator'。
     */
    kind: text("kind").notNull().default("evaluator"),
    /** 管理员配置的介绍，在题目编辑器下拉中展示 */
    description: text("description").notNull().default(""),
    created_at: text("created_at").notNull(),
    updated_at: text("updated_at").notNull(),
  },
  (table) => ({
    modeCheck: check(
      "judge_images_mode_check",
      sql`${table.mode} IN ('exact', 'all_versions')`,
    ),
    kindCheck: check(
      "judge_images_kind_check",
      sql`${table.kind} IN ('evaluator', 'solution')`,
    ),
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
 * 竞赛主表。
 * 竞赛状态由 start_time/end_time 动态计算，不持久化状态字段。
 */
export const contests = pgTable(
  "contests",
  {
    id: text("id").primaryKey(),
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
    typeCheck: check(
      "contests_type_check",
      sql`${table.type} IN ('icpc', 'ioi', 'oi')`,
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
    score: integer("score"),
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
    contest_id: text("contest_id").references(() => contests.id, {
      onDelete: "set null",
    }),
    language: text("language").notNull(),
    code: text("code").notNull(),
    file_name: text("file_name"),
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
    user_idx: index("idx_submissions_user_id").on(table.user_id),
    problem_idx: index("idx_submissions_problem_id").on(table.problem_id),
    status_idx: index("idx_submissions_status").on(table.status),
    created_at_idx: index("idx_submissions_created_at").on(table.created_at),
    contest_idx: index("idx_submissions_contest_id").on(table.contest_id),
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

/**
 * 私信会话表。
 * 每对用户只有一个会话，通过 user1_id < user2_id 约束确保去重。
 * last_message_at 为反范式缓存，用于会话列表排序。
 */
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

/**
 * 私信消息表。
 * 1-10000 字符文本消息。支持软删除（见 message_deletions 表）。
 * 物理删除使用 ON DELETE CASCADE 从会话级联清理。
 */
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

/**
 * 会话已读状态表。
 * 记录每个用户在每个会话中的最后阅读位置。
 * last_read_message_id 为 NULL 表示从未阅读。
 */
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

/**
 * 消息单用户删除记录表。
 * 用户删除消息仅删除自己视角，原始消息仍保留（对方可见）。
 * 用户或消息物理删除时通过 CASCADE 自动清理。
 */
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

/**
 * 系统设置 KV 表（issue #99）。
 * 管理员运行时可变配置持久化层。
 *
 * - 运行时读取优先级：DB value > envFallback > SETTING_DEFINITIONS.default
 * - 写入由 services/system-settings.ts 做严格 type 校验 + 敏感字段掩码
 * - 审计日志走 console.log("[admin] ...")，issue #101 落库后迁移
 */
export const systemSettings = pgTable(
  "system_settings",
  {
    key: text("key").primaryKey(),
    /** JSON 编码字符串（boolean/string/text 三种类型共存） */
    value: text("value").notNull(),
    description: text("description").notNull().default(""),
    is_secret: boolean("is_secret").notNull().default(false),
    updated_at: text("updated_at").notNull(),
    updated_by: text("updated_by").references(() => users.id, {
      onDelete: "set null",
    }),
  },
  (table) => ({
    updatedAtIdx: index("idx_system_settings_updated_at").on(
      table.updated_at,
    ),
  }),
);

/**
 * 公告表（issue #231）。
 * 站内广播（维护通知、活动预告等），由运营者（admin）管理。
 * - 公开列表仅返回 is_active=true，排序 is_pinned DESC, created_at DESC
 * - 下架 = is_active 置 false（不物理删除，保留历史）
 * - content 为 Markdown 文本
 */
export const announcements = pgTable(
  "announcements",
  {
    id: text("id").primaryKey(),
    /** 标题，1–100 字符 */
    title: text("title").notNull(),
    /** Markdown 正文，1–50000 字符 */
    content: text("content").notNull(),
    /** 是否置顶（公开列表优先展示） */
    is_pinned: boolean("is_pinned").notNull().default(false),
    /** 是否发布中（false = 已下架，公开列表不可见） */
    is_active: boolean("is_active").notNull().default(true),
    /** 创建者用户 id */
    created_by: text("created_by").notNull().references(() => users.id),
    /** ISO 8601，创建时间 */
    created_at: text("created_at").notNull(),
    /** ISO 8601，最后更新时间 */
    updated_at: text("updated_at").notNull(),
  },
  (table) => ({
    /** 公开列表查询：仅 active + 置顶优先 + 最新在前 */
    activePinnedCreatedIdx: index("idx_announcements_active_pinned_created").on(
      table.is_active,
      table.is_pinned,
      table.created_at,
    ),
  }),
);

/**
 * 审计日志表（issue #101）。
 * 记录所有管理员操作的详细信息：admin_id、action、target、detail、ip、time。
 * service 层通过 logAudit() 同步写入；后台任务定期清理过期记录。
 */
export const auditLogs = pgTable(
  "audit_logs",
  {
    id: text("id").primaryKey(),
    // PR-2：admin_id 可空——auth.* 事件可能没有 actor（登录失败、撞邮箱等）
    admin_id: text("admin_id").references(() => users.id),
    action: text("action").notNull(),
    target_type: text("target_type"),
    target_id: text("target_id"),
    detail: jsonb("detail").notNull().default({}),
    ip_address: text("ip_address").notNull(),
    created_at: text("created_at").notNull(),
  },
  (table) => ({
    actionCheck: check(
      "audit_logs_action_check",
      sql`${table.action} IN (
        'users.role_change',
        'users.ban',
        'users.unban',
        'problems.delete',
        'problems.runtime_config_changed',
        'problems.imported',
        'categories.delete',
        'submissions.rejudge',
        'settings.update',
        'ip_ban.create',
        'ip_ban.delete',
        'auth.login_success',
        'auth.login_failure',
        'auth.register',
        'auth.change_password',
        'auth.forgot_password_request',
        'auth.password_reset',
        'community.post_moderated',
        'community.report_resolved',
        'community.sanction_created',
        'community.sanction_revoked',
        'community.preset_applied',
        'announcement.create',
        'announcement.update',
        'announcement.delete'
      )`,
    ),
    adminIdx: index("audit_logs_admin_id_idx").on(table.admin_id),
    createdAtIdx: index("audit_logs_created_at_idx").on(table.created_at),
    actionIdx: index("audit_logs_action_idx").on(table.action),
  }),
);

/**
 * IP 黑名单表（issue #102）。
 * 存储被封禁的 IPv4 裸 IP（如 1.2.3.4）或 CIDR 范围（如 10.0.0.0/8）。
 * 命中后中间件返 403 IP_BLACKLISTED。
 * expires_at 为 ISO 8601 字符串；NULL = 永久。
 */
export const ipBans = pgTable(
  "ip_bans",
  {
    id: text("id").primaryKey(),
    ip_or_cidr: text("ip_or_cidr").notNull(),
    reason: text("reason").notNull().default(""),
    expires_at: text("expires_at"),
    created_at: text("created_at").notNull(),
    created_by: text("created_by").references(() => users.id, {
      onDelete: "set null",
    }),
  },
  (table) => ({
    ipCidrIdx: index("idx_ip_bans_ip_or_cidr").on(table.ip_or_cidr),
    expiresIdx: index("idx_ip_bans_expires_at").on(table.expires_at),
  }),
);

/**
 * 用户封禁表（user-ban-table）。
 *
 * 每条记录代表一次封禁操作。unbanned_at IS NULL = 当前活跃封禁。
 * 至多一条活跃封禁记录（banUser 先关闭旧活跃再插入新记录）。
 * 支持审计追溯：banned_by/unbanned_by 记录操作人。
 */
export const userBans = pgTable(
  "user_bans",
  {
    id: text("id").primaryKey(),
    user_id: text("user_id").notNull().references(() => users.id, {
      onDelete: "cascade",
    }),
    reason: text("reason").notNull().default(""),
    /** ISO 8601；NULL = 永久封禁 */
    banned_until: text("banned_until"),
    banned_at: text("banned_at").notNull(),
    banned_by: text("banned_by").references(() => users.id, {
      onDelete: "set null",
    }),
    /** 解封时间；NULL = 当前活跃封禁 */
    unbanned_at: text("unbanned_at"),
    unbanned_by: text("unbanned_by").references(() => users.id, {
      onDelete: "set null",
    }),
  },
  (table) => ({
    userIdx: index("idx_user_bans_user").on(table.user_id),
    activeIdx: index("idx_user_bans_active").on(table.user_id).where(
      sql`unbanned_at IS NULL`,
    ),
  }),
);

/**
 * RBAC 角色表。
 * 支持角色继承（parent_id 自引用）、is_admin 标记（隐式全权限）、
 * is_default 标记（注册自动分配）、is_system 标记（系统保护角色）。
 */
export const roles = pgTable(
  "roles",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull().unique(),
    description: text("description").notNull().default(""),
    is_system: boolean("is_system").notNull().default(false),
    is_default: boolean("is_default").notNull().default(false),
    // deno-lint-ignore no-explicit-any
    parent_id: text("parent_id").references((): any => roles.id, {
      onDelete: "set null",
    }),
    created_at: text("created_at").notNull(),
    updated_at: text("updated_at").notNull(),
  },
  (table) => ({
    parentIdx: index("idx_roles_parent_id").on(table.parent_id),
  }),
);

/**
 * RBAC 权限定义表。
 * 每个权限由 resource + action 唯一标识，格式 resource:action。
 * 系统预置约 22 个权限，覆盖 problem/submission/user/category/system 五个资源域。
 */
export const permissions = pgTable(
  "permissions",
  {
    id: text("id").primaryKey(),
    resource: text("resource").notNull(),
    action: text("action").notNull(),
    description: text("description").notNull().default(""),
  },
  (table) => ({
    resourceActionUnique: unique("permissions_resource_action_unique").on(
      table.resource,
      table.action,
    ),
  }),
);

/**
 * 角色-权限关联表。
 * 多对多，级联删除。
 */
export const rolePermissions = pgTable(
  "role_permissions",
  {
    role_id: text("role_id")
      .notNull()
      .references(() => roles.id, { onDelete: "cascade" }),
    permission_id: text("permission_id")
      .notNull()
      .references(() => permissions.id, { onDelete: "cascade" }),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.role_id, table.permission_id] }),
  }),
);

/**
 * 用户-角色关联表。
 * 一个用户可拥有多个角色，多对多，级联删除。
 */
export const userRoles = pgTable(
  "user_roles",
  {
    user_id: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    role_id: text("role_id")
      .notNull()
      .references(() => roles.id, { onDelete: "cascade" }),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.user_id, table.role_id] }),
  }),
);

/** 社区讨论板块。 */
export const communityBoards = pgTable(
  "community_boards",
  {
    id: text("id").primaryKey(),
    slug: text("slug").notNull().unique(),
    name: text("name").notNull(),
    description: text("description").notNull().default(""),
    sort_order: integer("sort_order").notNull().default(0),
    is_archived: boolean("is_archived").notNull().default(false),
    created_at: text("created_at").notNull(),
    updated_at: text("updated_at").notNull(),
  },
  (table) => ({
    sortIdx: index("idx_community_boards_sort").on(
      table.is_archived,
      table.sort_order,
    ),
  }),
);

/** 板块级角色授权；没有授权记录时沿用全局社区 RBAC。 */
export const communityBoardRoleGrants = pgTable(
  "community_board_role_grants",
  {
    board_id: text("board_id").notNull().references(() => communityBoards.id, {
      onDelete: "cascade",
    }),
    role_id: text("role_id").notNull().references(() => roles.id, {
      onDelete: "cascade",
    }),
    can_read: boolean("can_read").notNull().default(true),
    can_post: boolean("can_post").notNull().default(false),
    can_moderate: boolean("can_moderate").notNull().default(false),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.board_id, table.role_id] }),
    roleIdx: index("idx_community_board_role_grants_role").on(table.role_id),
  }),
);

/** 题解、讨论和短动态统一内容表。 */
export const communityPosts = pgTable(
  "community_posts",
  {
    id: text("id").primaryKey(),
    type: text("type").notNull(),
    author_id: text("author_id").notNull().references(() => users.id, {
      onDelete: "cascade",
    }),
    problem_id: text("problem_id").references(() => problems.id, {
      onDelete: "cascade",
    }),
    board_id: text("board_id").references(() => communityBoards.id, {
      onDelete: "set null",
    }),
    title: text("title"),
    content: text("content").notNull(),
    status: text("status").notNull().default("published"),
    is_locked: boolean("is_locked").notNull().default(false),
    is_pinned: boolean("is_pinned").notNull().default(false),
    moderation_reason: text("moderation_reason"),
    published_at: text("published_at"),
    created_at: text("created_at").notNull(),
    updated_at: text("updated_at").notNull(),
  },
  (table) => ({
    typeCheck: check(
      "community_posts_type_check",
      sql`${table.type} IN ('solution', 'discussion', 'moment')`,
    ),
    statusCheck: check(
      "community_posts_status_check",
      sql`${table.status} IN ('draft', 'pending', 'published', 'hidden', 'deleted')`,
    ),
    contextCheck: check(
      "community_posts_context_check",
      sql`(
        (${table.type} = 'solution' AND ${table.problem_id} IS NOT NULL AND ${table.board_id} IS NULL AND ${table.title} IS NOT NULL)
        OR (${table.type} = 'discussion' AND ${table.board_id} IS NOT NULL AND ${table.problem_id} IS NULL AND ${table.title} IS NOT NULL)
        OR (${table.type} = 'moment' AND ${table.problem_id} IS NULL AND ${table.board_id} IS NULL AND ${table.title} IS NULL)
      )`,
    ),
    authorIdx: index("idx_community_posts_author").on(
      table.author_id,
      table.created_at,
    ),
    problemIdx: index("idx_community_posts_problem").on(
      table.problem_id,
      table.created_at,
    ),
    boardIdx: index("idx_community_posts_board").on(
      table.board_id,
      table.created_at,
    ),
    publishedIdx: index("idx_community_posts_published").on(
      table.type,
      table.is_pinned,
      table.created_at,
    ).where(sql`${table.status} = 'published'`),
    pendingIdx: index("idx_community_posts_pending").on(table.created_at).where(
      sql`${table.status} = 'pending'`,
    ),
  }),
);

/** 社区评论，仅允许一级回复。 */
export const communityComments = pgTable(
  "community_comments",
  {
    id: text("id").primaryKey(),
    post_id: text("post_id").notNull().references(() => communityPosts.id, {
      onDelete: "cascade",
    }),
    author_id: text("author_id").notNull().references(() => users.id, {
      onDelete: "cascade",
    }),
    parent_id: text("parent_id").references(
      (): AnyPgColumn => communityComments.id,
      { onDelete: "cascade" },
    ),
    content: text("content").notNull(),
    status: text("status").notNull().default("published"),
    moderation_reason: text("moderation_reason"),
    created_at: text("created_at").notNull(),
    updated_at: text("updated_at").notNull(),
  },
  (table) => ({
    statusCheck: check(
      "community_comments_status_check",
      sql`${table.status} IN ('pending', 'published', 'hidden', 'deleted')`,
    ),
    postIdx: index("idx_community_comments_post").on(
      table.post_id,
      table.created_at,
    ),
    authorIdx: index("idx_community_comments_author").on(table.author_id),
    parentIdx: index("idx_community_comments_parent").on(table.parent_id),
  }),
);

/** 帖子点赞。 */
export const communityPostLikes = pgTable(
  "community_post_likes",
  {
    post_id: text("post_id").notNull().references(() => communityPosts.id, {
      onDelete: "cascade",
    }),
    user_id: text("user_id").notNull().references(() => users.id, {
      onDelete: "cascade",
    }),
    created_at: text("created_at").notNull(),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.post_id, table.user_id] }),
    userIdx: index("idx_community_post_likes_user").on(table.user_id),
  }),
);

/** 评论点赞。 */
export const communityCommentLikes = pgTable(
  "community_comment_likes",
  {
    comment_id: text("comment_id").notNull().references(
      () => communityComments.id,
      { onDelete: "cascade" },
    ),
    user_id: text("user_id").notNull().references(() => users.id, {
      onDelete: "cascade",
    }),
    created_at: text("created_at").notNull(),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.comment_id, table.user_id] }),
    userIdx: index("idx_community_comment_likes_user").on(table.user_id),
  }),
);

/** 帖子收藏。 */
export const communityBookmarks = pgTable(
  "community_bookmarks",
  {
    post_id: text("post_id").notNull().references(() => communityPosts.id, {
      onDelete: "cascade",
    }),
    user_id: text("user_id").notNull().references(() => users.id, {
      onDelete: "cascade",
    }),
    created_at: text("created_at").notNull(),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.post_id, table.user_id] }),
    userIdx: index("idx_community_bookmarks_user").on(
      table.user_id,
      table.created_at,
    ),
  }),
);

/** 用户关注关系。 */
export const communityFollows = pgTable(
  "community_follows",
  {
    follower_id: text("follower_id").notNull().references(() => users.id, {
      onDelete: "cascade",
    }),
    followee_id: text("followee_id").notNull().references(() => users.id, {
      onDelete: "cascade",
    }),
    created_at: text("created_at").notNull(),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.follower_id, table.followee_id] }),
    notSelfCheck: check(
      "community_follows_not_self_check",
      sql`${table.follower_id} <> ${table.followee_id}`,
    ),
    followeeIdx: index("idx_community_follows_followee").on(
      table.followee_id,
      table.created_at,
    ),
  }),
);

/** 可展示在动态流中的系统活动。 */
export const communityActivityEvents = pgTable(
  "community_activity_events",
  {
    id: text("id").primaryKey(),
    actor_id: text("actor_id").notNull().references(() => users.id, {
      onDelete: "cascade",
    }),
    type: text("type").notNull(),
    subject_type: text("subject_type").notNull(),
    subject_id: text("subject_id").notNull(),
    metadata: jsonb("metadata").notNull().default({}),
    created_at: text("created_at").notNull(),
  },
  (table) => ({
    typeCheck: check(
      "community_activity_events_type_check",
      sql`${table.type} IN ('first_accepted', 'solution_published', 'contest_joined')`,
    ),
    dedupeUnique: unique("community_activity_events_dedupe_unique").on(
      table.actor_id,
      table.type,
      table.subject_type,
      table.subject_id,
    ),
    actorIdx: index("idx_community_activity_events_actor").on(
      table.actor_id,
      table.created_at,
    ),
  }),
);

/** 帖子或评论举报。 */
export const communityReports = pgTable(
  "community_reports",
  {
    id: text("id").primaryKey(),
    reporter_id: text("reporter_id").notNull().references(() => users.id, {
      onDelete: "cascade",
    }),
    post_id: text("post_id").references(() => communityPosts.id, {
      onDelete: "set null",
    }),
    comment_id: text("comment_id").references(() => communityComments.id, {
      onDelete: "set null",
    }),
    reason: text("reason").notNull(),
    content_snapshot: text("content_snapshot").notNull(),
    status: text("status").notNull().default("pending"),
    resolution: text("resolution"),
    resolved_by: text("resolved_by").references(() => users.id, {
      onDelete: "set null",
    }),
    resolved_at: text("resolved_at"),
    created_at: text("created_at").notNull(),
  },
  (table) => ({
    targetCheck: check(
      "community_reports_target_check",
      sql`num_nonnulls(${table.post_id}, ${table.comment_id}) = 1`,
    ),
    statusCheck: check(
      "community_reports_status_check",
      sql`${table.status} IN ('pending', 'resolved', 'dismissed')`,
    ),
    pendingIdx: index("idx_community_reports_pending").on(table.created_at)
      .where(sql`${table.status} = 'pending'`),
    reporterIdx: index("idx_community_reports_reporter").on(table.reporter_id),
    postIdx: index("idx_community_reports_post").on(table.post_id),
    commentIdx: index("idx_community_reports_comment").on(table.comment_id),
  }),
);

/** 审核动作历史。 */
export const communityModerationActions = pgTable(
  "community_moderation_actions",
  {
    id: text("id").primaryKey(),
    moderator_id: text("moderator_id").references(() => users.id, {
      onDelete: "set null",
    }),
    action: text("action").notNull(),
    target_type: text("target_type").notNull(),
    target_id: text("target_id").notNull(),
    reason: text("reason").notNull().default(""),
    metadata: jsonb("metadata").notNull().default({}),
    created_at: text("created_at").notNull(),
  },
  (table) => ({
    targetIdx: index("idx_community_moderation_actions_target").on(
      table.target_type,
      table.target_id,
      table.created_at,
    ),
    moderatorIdx: index("idx_community_moderation_actions_moderator").on(
      table.moderator_id,
    ),
  }),
);

/** 社区写操作处罚，不影响评测与账号登录。 */
export const communitySanctions = pgTable(
  "community_sanctions",
  {
    id: text("id").primaryKey(),
    user_id: text("user_id").notNull().references(() => users.id, {
      onDelete: "cascade",
    }),
    reason: text("reason").notNull(),
    expires_at: text("expires_at"),
    created_by: text("created_by").references(() => users.id, {
      onDelete: "set null",
    }),
    created_at: text("created_at").notNull(),
    revoked_at: text("revoked_at"),
    revoked_by: text("revoked_by").references(() => users.id, {
      onDelete: "set null",
    }),
  },
  (table) => ({
    activeIdx: index("idx_community_sanctions_active").on(table.user_id).where(
      sql`${table.revoked_at} IS NULL`,
    ),
    creatorIdx: index("idx_community_sanctions_creator").on(table.created_by),
  }),
);

/** 社区通知。 */
export const communityNotifications = pgTable(
  "community_notifications",
  {
    id: text("id").primaryKey(),
    recipient_id: text("recipient_id").notNull().references(() => users.id, {
      onDelete: "cascade",
    }),
    actor_id: text("actor_id").references(() => users.id, {
      onDelete: "set null",
    }),
    type: text("type").notNull(),
    post_id: text("post_id").references(() => communityPosts.id, {
      onDelete: "set null",
    }),
    comment_id: text("comment_id").references(() => communityComments.id, {
      onDelete: "set null",
    }),
    data: jsonb("data").notNull().default({}),
    read_at: text("read_at"),
    created_at: text("created_at").notNull(),
  },
  (table) => ({
    typeCheck: check(
      "community_notifications_type_check",
      sql`${table.type} IN ('reply', 'like', 'follow', 'moderation', 'clarification')`,
    ),
    recipientIdx: index("idx_community_notifications_recipient").on(
      table.recipient_id,
      table.created_at,
    ),
    unreadIdx: index("idx_community_notifications_unread").on(
      table.recipient_id,
      table.created_at,
    ).where(sql`${table.read_at} IS NULL`),
    actorIdx: index("idx_community_notifications_actor").on(table.actor_id),
    postIdx: index("idx_community_notifications_post").on(table.post_id),
    commentIdx: index("idx_community_notifications_comment").on(
      table.comment_id,
    ),
  }),
);
