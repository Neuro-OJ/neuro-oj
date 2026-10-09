import {
  boolean,
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  serial,
  text,
  unique,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import type { AnyPgColumn } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { publicIdColumn } from "./common.ts";
import { users } from "./identity.ts";
import { problems, problemVersions } from "./catalog.ts";
import { contests } from "./contest.ts";
import { objectiveSubmissions } from "./objective.ts";
import type {
  AttemptResultKind,
  AttemptSource,
  AttemptState,
  SubmissionJobItemStatus,
  SubmissionJobKind,
  SubmissionJobSourceKind,
  SubmissionJobStatus,
  SubmissionVersionOrigin,
} from "../../versioning/types.ts";

/**
 * 数据库行状态字面量类型。
 *
 * 与 submission 域类型保持同一字面量集合；shared 层不反向依赖 domains，
 * 因此 schema 内保留本地类型别名用于 Drizzle $type<>。
 */
type SubmissionStatus = "pending" | "judging" | "finished" | "error";
type SelfTestStatus =
  | "pending"
  | "judging"
  | "finished"
  | "error"
  | "cancelled";

/**
 * 评测尝试表（Handbook §2.8）。
 *
 * 统一保存普通题与客观题的评测历史：使用某个题目版本评测某条提交的一次执行。
 * **终态只可写入一次**，重复回调不覆盖结果；`id` 同时作为正式评测的 `run_id`。
 *
 * 定义顺序：本表先于 `submissions` / `objectiveSubmissions` 定义，
 * 两个提交外键走惰性 `.references()`，从而让两类提交可以反向 `.references()`
 * 本表的尝试指针。
 */
export const evaluationAttempts = pgTable(
  "evaluation_attempts",
  {
    id: text("id").primaryKey(),
    /** 普通提交；与 `objective_submission_id` 恰好一个非空。 */
    submission_id: text("submission_id").references(() => submissions.id, {
      onDelete: "cascade",
    }),
    /** 客观题提交；与 `submission_id` 恰好一个非空。 */
    objective_submission_id: text("objective_submission_id").references(
      () => objectiveSubmissions.id,
      { onDelete: "cascade" },
    ),
    problem_id: text("problem_id").notNull().references(() => problems.id, {
      onDelete: "cascade",
    }),
    /** 本次执行使用的题目版本；仅迁移历史允许为空。 */
    problem_version_id: text("problem_version_id").references(
      () => problemVersions.id,
      { onDelete: "cascade" },
    ),
    /** 同一提交内递增：初次提交为 0，之后每次重测 +1。 */
    sequence: integer("sequence").notNull(),
    source: text("source").$type<AttemptSource>().notNull(),
    state: text("state").$type<AttemptState>().notNull().default("queued"),
    /** 判定类别；未终结时为 NULL。平台错误不更新当前正式判定。 */
    result_kind: text("result_kind").$type<AttemptResultKind>(),
    result_status: text("result_status"),
    /** ×100 整数，0..10000。 */
    score: integer("score"),
    accepted: boolean("accepted").notNull().default(false),
    output: text("output").notNull().default(""),
    details: jsonb("details").notNull().default({}),
    time_ms: integer("time_ms"),
    memory_kb: integer("memory_kb"),
    /** 实际执行配置快照：语言、版本、平台计时标准、LLM Provider/模型与预算。 */
    task_snapshot: jsonb("task_snapshot"),
    created_by: text("created_by").references(() => users.id, {
      onDelete: "set null",
    }),
    created_at: text("created_at").notNull(),
    started_at: text("started_at"),
    finished_at: text("finished_at"),
  },
  (table) => ({
    /** 两个提交外键恰好一个非空。 */
    sourceCheck: check(
      "evaluation_attempts_source_check",
      sql`(${table.submission_id} IS NULL) <> (${table.objective_submission_id} IS NULL)`,
    ),
    stateCheck: check(
      "evaluation_attempts_state_check",
      sql`${table.state} IN ('queued', 'judging', 'finished', 'error', 'superseded')`,
    ),
    sourceKindCheck: check(
      "evaluation_attempts_source_kind_check",
      sql`${table.source} IN ('initial', 'rejudge', 'upgrade', 'legacy_import')`,
    ),
    resultKindCheck: check(
      "evaluation_attempts_result_kind_check",
      sql`${table.result_kind} IS NULL OR ${table.result_kind} IN ('graded', 'platform_error')`,
    ),
    sequenceCheck: check(
      "evaluation_attempts_sequence_check",
      sql`${table.sequence} >= 0`,
    ),
    scoreCheck: check(
      "evaluation_attempts_score_check",
      sql`${table.score} IS NULL OR (${table.score} >= 0 AND ${table.score} <= 10000)`,
    ),
    detailsCheck: check(
      "evaluation_attempts_details_check",
      sql`jsonb_typeof(${table.details}) = 'object'`,
    ),
    submissionSequenceUnique: unique(
      "evaluation_attempts_submission_sequence_unique",
    ).on(table.submission_id, table.sequence),
    objectiveSequenceUnique: unique(
      "evaluation_attempts_objective_sequence_unique",
    ).on(table.objective_submission_id, table.sequence),
    submissionVersionSequenceIdx: index(
      "idx_eval_attempts_submission_version_sequence",
    ).on(
      table.submission_id,
      table.problem_version_id,
      table.sequence.desc(),
    ),
    objectiveVersionSequenceIdx: index(
      "idx_eval_attempts_objective_version_sequence",
    ).on(
      table.objective_submission_id,
      table.problem_version_id,
      table.sequence.desc(),
    ),
    stateCreatedIdx: index("idx_eval_attempts_state_created").on(
      table.state,
      table.created_at,
    ),
    problemIdx: index("idx_eval_attempts_problem").on(table.problem_id),
    /** 「最近一次终态尝试」读取路径（提交详情/历史）。 */
    submissionFinishedIdx: index("idx_eval_attempts_submission_finished").on(
      table.submission_id,
      table.finished_at.desc(),
    ),
  }),
);

/**
 * 提交记录表。
 * 用户提交代码后生成一条记录，评测状态流转：
 * pending → judging → finished
 *
 * 版本化后（Handbook §2.7）：`submitted_version_id` / `version_origin` 创建后
 * **不可修改**；重测只改变评测尝试，不改变原始代码、提交时间与来源版本。
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
    /** 提交时实际使用的题目版本；`legacy_unknown` 时必须为空。 */
    submitted_version_id: text("submitted_version_id"),
    /**
     * `known`=有明确提交时版本；`legacy_unknown`=真实版本不可考。
     *
     * **默认值是 `legacy_unknown`**：写入服务必须显式给出 `version_origin` 与
     * `submitted_version_id`（`known`）。任何忘记传版本的代码路径都会落成
     * 「未知版本」而不是谎称已知版本——数据库不替调用方猜版本。
     */
    version_origin: text("version_origin").$type<SubmissionVersionOrigin>()
      .notNull().default("legacy_unknown"),
    /** 用户升级生成的新提交指向的来源提交；来源删除后置空。 */
    upgraded_from_id: text("upgraded_from_id").references(
      (): AnyPgColumn => submissions.id,
      { onDelete: "set null" },
    ),
    /** 在途评测任务；不能替代有效成绩指针。 */
    active_attempt_id: text("active_attempt_id"),
    /** 最近一次终态尝试；不能替代有效成绩指针。 */
    latest_attempt_id: text("latest_attempt_id"),
    /** 题库口径：当前是否存在有效成绩。 */
    is_valid: boolean("is_valid").notNull().default(false),
    /** 题库口径：是否存在通过成绩。 */
    is_accepted: boolean("is_accepted").notNull().default(false),
    /** 题库口径有效成绩指针（最高分候选）。 */
    effective_attempt_id: text("effective_attempt_id"),
    /** 题库口径通过成绩指针（通过候选中 sequence 最小者）。 */
    accepted_attempt_id: text("accepted_attempt_id"),
    /** 竞赛口径：与题库口径独立计算。 */
    is_contest_valid: boolean("is_contest_valid").notNull().default(false),
    is_contest_accepted: boolean("is_contest_accepted").notNull().default(
      false,
    ),
    contest_effective_attempt_id: text("contest_effective_attempt_id"),
    contest_accepted_attempt_id: text("contest_accepted_attempt_id"),
    /** 投影时读取的题库策略 revision，用于缓存与陈旧投影判定。 */
    global_policy_revision: integer("global_policy_revision").notNull().default(
      0,
    ),
    /** 投影时读取的「竞赛×题目」策略 revision；非竞赛提交为空。 */
    contest_policy_revision: integer("contest_policy_revision"),
    status: text("status").$type<SubmissionStatus>().notNull().default(
      "pending",
    ),
    /** 重测序列号，递增。用于区分新旧评测结果，防止竞态覆盖。 */
    rejudge_seq: integer("rejudge_seq").notNull().default(0),
    judge_run_id: text("judge_run_id"),
    judge_progress: jsonb("judge_progress"),
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
    /** 题库有效状态查询：通过数、通过列表、通过率。 */
    problemAcceptedUserIdx: index("idx_submissions_problem_accepted_user").on(
      table.problem_id,
      table.is_accepted,
      table.user_id,
    ),
    problemValidUserIdx: index("idx_submissions_problem_valid_user").on(
      table.problem_id,
      table.is_valid,
      table.user_id,
    ),
    /** 竞赛有效状态查询：竞赛榜单按有效成绩指针计分。 */
    contestValidUserIdx: index("idx_submissions_contest_valid_user").on(
      table.contest_id,
      table.problem_id,
      table.is_contest_valid,
      table.user_id,
    ),
    versionOriginCheck: check(
      "submissions_version_origin_check",
      sql`(${table.version_origin} = 'known' AND ${table.submitted_version_id} IS NOT NULL)
        OR (${table.version_origin} = 'legacy_unknown' AND ${table.submitted_version_id} IS NULL)`,
    ),
    /** 提交时版本必须属于该提交的题目（复合外键）。 */
    submittedVersionFk: foreignKey({
      name: "submissions_submitted_version_fk",
      columns: [table.problem_id, table.submitted_version_id],
      foreignColumns: [problemVersions.problem_id, problemVersions.id],
    }),
    // 六个尝试指针（在途/最近/有效/通过/竞赛有效/竞赛通过）的外键
    // **故意不在此声明**：`evaluation_attempts.submission_id → submissions.id`
    // 与本表指针构成类型层面的互相引用，`foreignKey()` 立即求值列数组会让
    // TypeScript 推出 `any`（TS7022/TS7024）。外键由迁移与 PGlite DDL 以
    // `ALTER TABLE ... ADD CONSTRAINT ... FOREIGN KEY ... ON DELETE SET NULL`
    // 建立（Handbook §6.1「循环外键使用延迟类型引用」）。
  }),
);

/**
 * 分版本当前正式判定表（Handbook §2.9）。
 *
 * 保存「某提交在某版本上的当前正式判定」：只有 `graded` 尝试更新此表，
 * 平台错误、在途尝试、过时尝试不更新它。
 *
 * 已知版本桶与未知版本桶分别用 partial unique index 约束（未知版本即
 * `problem_version_id IS NULL` 的迁移历史判定）。
 */
export const submissionVersionResults = pgTable(
  "submission_version_results",
  {
    id: text("id").primaryKey(),
    submission_id: text("submission_id").references(() => submissions.id, {
      onDelete: "cascade",
    }),
    objective_submission_id: text("objective_submission_id").references(
      () => objectiveSubmissions.id,
      { onDelete: "cascade" },
    ),
    problem_id: text("problem_id").notNull().references(() => problems.id, {
      onDelete: "cascade",
    }),
    /** 迁移历史允许为空（未知版本桶）。 */
    problem_version_id: text("problem_version_id").references(
      () => problemVersions.id,
      { onDelete: "cascade" },
    ),
    /** 指向产生该判定的已完成正式尝试。 */
    current_attempt_id: text("current_attempt_id").notNull().references(
      () => evaluationAttempts.id,
      { onDelete: "cascade" },
    ),
    updated_at: text("updated_at").notNull(),
  },
  (table) => ({
    sourceCheck: check(
      "submission_version_results_source_check",
      sql`(${table.submission_id} IS NULL) <> (${table.objective_submission_id} IS NULL)`,
    ),
    /** 普通提交的已知版本桶：唯一。 */
    submissionKnownUnique: uniqueIndex(
      "submission_version_results_submission_known_unique",
    ).on(table.submission_id, table.problem_version_id).where(
      sql`${table.submission_id} IS NOT NULL AND ${table.problem_version_id} IS NOT NULL`,
    ),
    /** 客观题提交的已知版本桶：唯一。 */
    objectiveKnownUnique: uniqueIndex(
      "submission_version_results_objective_known_unique",
    ).on(table.objective_submission_id, table.problem_version_id).where(
      sql`${table.objective_submission_id} IS NOT NULL AND ${table.problem_version_id} IS NOT NULL`,
    ),
    /** 普通提交的未知版本桶：唯一。 */
    submissionUnknownUnique: uniqueIndex(
      "submission_version_results_submission_unknown_unique",
    ).on(table.submission_id).where(
      sql`${table.submission_id} IS NOT NULL AND ${table.problem_version_id} IS NULL`,
    ),
    /** 客观题提交的未知版本桶：唯一。 */
    objectiveUnknownUnique: uniqueIndex(
      "submission_version_results_objective_unknown_unique",
    ).on(table.objective_submission_id).where(
      sql`${table.objective_submission_id} IS NOT NULL AND ${table.problem_version_id} IS NULL`,
    ),
    problemVersionIdx: index("idx_submission_version_results_problem_version")
      .on(table.problem_id, table.problem_version_id),
    /** 由尝试反查当前判定（历史查询与清理路径）。 */
    currentAttemptIdx: index(
      "idx_submission_version_results_current_attempt",
    ).on(table.current_attempt_id),
  }),
);

/**
 * 批量任务表（Handbook §2.10）。
 * `rejudge`（管理员重测）与 `upgrade`（用户升级）共用。
 */
export const submissionJobs = pgTable(
  "submission_jobs",
  {
    id: text("id").primaryKey(),
    kind: text("kind").$type<SubmissionJobKind>().notNull(),
    actor_id: text("actor_id").notNull().references(() => users.id),
    idempotency_key: text("idempotency_key").notNull(),
    request_hash: text("request_hash").notNull(),
    /** 规范化请求及固定版本映射。 */
    request: jsonb("request").notNull().default({}),
    status: text("status").$type<SubmissionJobStatus>().notNull().default(
      "queued",
    ),
    created_at: text("created_at").notNull(),
    finished_at: text("finished_at"),
  },
  (table) => ({
    actorKindKeyUnique: unique("submission_jobs_actor_kind_key_unique").on(
      table.actor_id,
      table.kind,
      table.idempotency_key,
    ),
    kindCheck: check(
      "submission_jobs_kind_check",
      sql`${table.kind} IN ('rejudge', 'upgrade')`,
    ),
    statusCheck: check(
      "submission_jobs_status_check",
      sql`${table.status} IN ('queued', 'running', 'completed', 'completed_with_errors')`,
    ),
    requestCheck: check(
      "submission_jobs_request_check",
      sql`jsonb_typeof(${table.request}) = 'object'`,
    ),
    statusCreatedIdx: index("idx_submission_jobs_status_created").on(
      table.status,
      table.created_at,
    ),
    actorCreatedIdx: index("idx_submission_jobs_actor_created").on(
      table.actor_id,
      table.created_at,
    ),
  }),
);

/**
 * 批量任务条目表（Handbook §2.10）。
 * 计数从条目聚合，不维护进程内计数器；删除目标版本或题目时保留原始引用。
 */
export const submissionJobItems = pgTable(
  "submission_job_items",
  {
    id: text("id").primaryKey(),
    job_id: text("job_id").notNull().references(() => submissionJobs.id, {
      onDelete: "cascade",
    }),
    ordinal: integer("ordinal").notNull(),
    source_kind: text("source_kind").$type<SubmissionJobSourceKind>().notNull(),
    /** 原始引用文本，保留删除后的任务记录（故意不建外键）。 */
    source_id: text("source_id").notNull(),
    problem_id: text("problem_id").notNull(),
    /** 目标版本；版本删除后置空（原始引用保留在 `target_version_ref`）。 */
    target_version_id: text("target_version_id").references(
      () => problemVersions.id,
      { onDelete: "set null" },
    ),
    /** 原始版本 ID 文本，用于历史解释。 */
    target_version_ref: text("target_version_ref"),
    status: text("status").$type<SubmissionJobItemStatus>().notNull().default(
      "pending",
    ),
    attempt_id: text("attempt_id").references(() => evaluationAttempts.id, {
      onDelete: "set null",
    }),
    /** 升级生成的新提交（两类提交共用，故意不建外键）。 */
    result_submission_id: text("result_submission_id"),
    lease_owner: text("lease_owner"),
    lease_until: text("lease_until"),
    dispatch_retries: integer("dispatch_retries").notNull().default(0),
    next_dispatch_at: text("next_dispatch_at"),
    reason_code: text("reason_code"),
    reason_message: text("reason_message"),
    created_at: text("created_at").notNull(),
    finished_at: text("finished_at"),
  },
  (table) => ({
    jobSourceUnique: unique("submission_job_items_job_source_unique").on(
      table.job_id,
      table.source_kind,
      table.source_id,
    ),
    sourceKindCheck: check(
      "submission_job_items_source_kind_check",
      sql`${table.source_kind} IN ('submission', 'objective')`,
    ),
    statusCheck: check(
      "submission_job_items_status_check",
      sql`${table.status} IN ('pending', 'preparing', 'dispatched', 'succeeded', 'failed', 'skipped')`,
    ),
    ordinalCheck: check(
      "submission_job_items_ordinal_check",
      sql`${table.ordinal} >= 0`,
    ),
    retriesCheck: check(
      "submission_job_items_retries_check",
      sql`${table.dispatch_retries} >= 0`,
    ),
    /** worker 领取：`FOR UPDATE SKIP LOCKED` 走这条索引。 */
    dispatchIdx: index("idx_submission_job_items_dispatch").on(
      table.status,
      table.next_dispatch_at,
      table.lease_until,
    ),
    jobStatusIdx: index("idx_submission_job_items_job_status").on(
      table.job_id,
      table.status,
    ),
  }),
);

/**
 * 评测结果表（**待退役**）。
 *
 * 版本化迁移完成后删除：所有运行期读取迁移至「有效尝试」或「最近尝试」，
 * 历史数据回填为 `legacy_import` 尝试（Handbook §6.5、§8.1 第 8 步）。
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
 *
 * 版本化后：自测同样携带题目版本，并保存恢复所需的任务快照
 * （测试点、语言、平台计时标准等），sweeper 从快照恢复而非重读当前题目配置。
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
    /** 自测使用的题目版本；复合外键保证属于该题。 */
    problem_version_id: text("problem_version_id"),
    /** 恢复所需任务快照（不含 token、Provider Key 或临时下载 URL）。 */
    task_snapshot: jsonb("task_snapshot"),
    language: text("language").notNull(),
    code: text("code").notNull(),
    file_name: text("file_name"),
    status: text("status").$type<SelfTestStatus>().notNull().default(
      "pending",
    ),
    /** 评测结果状态（新协议下为 finished / error），终态时由 JudgeResult 写入。 */
    result_status: text("result_status"),
    judge_run_id: text("judge_run_id"),
    judge_progress: jsonb("judge_progress"),
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
      sql`${table.status} IN ('pending', 'judging', 'finished', 'error', 'cancelled')`,
    ),
    versionFk: foreignKey({
      name: "self_tests_problem_version_fk",
      columns: [table.problem_id, table.problem_version_id],
      foreignColumns: [problemVersions.problem_id, problemVersions.id],
    }),
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
