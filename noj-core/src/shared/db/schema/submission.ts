/**
 * 提交相关的其余表：正式判定、批量任务、自测与 SSE 事件。
 *
 * 尝试与两类提交的定义集中在 `evaluation-records.ts`；这里只保留引用它们、
 * 但彼此不构成环的表。所有表仍然通过 `shared/db/schema/index.ts` 聚合导出，
 * 物理表名与列定义保持不变。
 */
import {
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
import { users } from "./identity.ts";
import { problems, problemVersions } from "./catalog.ts";
import { domains } from "./workspace.ts";
import { domainProblemBindings } from "./catalog-workspace.ts";
import { assignmentItems, assignments } from "./assignment.ts";
import {
  evaluationAttempts,
  objectiveSubmissions,
  submissions,
} from "./evaluation-records.ts";
import type {
  SubmissionJobItemStatus,
  SubmissionJobKind,
  SubmissionJobSourceKind,
  SubmissionJobStatus,
} from "../../versioning/types.ts";

/**
 * 数据库行状态字面量类型。
 *
 * 与 submission 域类型保持同一字面量集合；shared 层不反向依赖 domains，
 * 因此 schema 内保留本地类型别名用于 Drizzle $type<>。
 */
type SelfTestStatus =
  | "pending"
  | "judging"
  | "finished"
  | "error"
  | "cancelled";

/**
 * LLM token 吊销 outbox（2026-10-11 复审问题 2）。
 *
 * 吊销是**外部副作用**（Redis），必须在尝试终态事务**提交后**执行；若此时 Redis
 * 不可用，仅靠日志/内存重试会永久丢失吊销，旧 token 在剩余有效期内仍可用。
 *
 * 契约：
 * - 写尝试终态（finished / error / superseded）的**同一事务**内插入一行 pending；
 * - 提交后立即尝试执行吊销，成功则标记 done；
 * - 失败由后台消费者（sweeper 周期）按行重试，直到 done —— 进程退出也不丢。
 */
export const llmTokenRevocations = pgTable(
  "llm_token_revocations",
  {
    id: text("id").primaryKey(),
    /** 与正式评测 `run_id` 同源的尝试 ID（吊销键按它派生）。 */
    attempt_id: text("attempt_id").notNull(),
    /** 旧协议提交维度吊销键（可选）。 */
    submission_id: text("submission_id"),
    /** 吊销标记 TTL 秒数：覆盖该尝试全部已签发 token 的剩余有效期。 */
    ttl_seconds: integer("ttl_seconds").notNull(),
    state: text("state").$type<"pending" | "done">().notNull().default(
      "pending",
    ),
    attempts: integer("attempts").notNull().default(0),
    created_at: text("created_at").notNull(),
    done_at: text("done_at"),
  },
  (table) => ({
    stateCheck: check(
      "llm_token_revocations_state_check",
      sql`${table.state} IN ('pending', 'done')`,
    ),
    pendingIdx: index("idx_llm_token_revocations_pending").on(
      table.state,
      table.created_at,
    ),
    attemptIdx: index("idx_llm_token_revocations_attempt").on(table.attempt_id),
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
    domain_id: text("domain_id").notNull().references(() => domains.id),
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
    workspaceIdentityUnique: unique("submission_jobs_domain_id_unique").on(
      table.domain_id,
      table.id,
    ),
    actorKindKeyUnique: unique("submission_jobs_domain_actor_kind_key_unique")
      .on(
        table.domain_id,
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
    domain_id: text("domain_id").notNull().references(() => domains.id),
    domain_problem_binding_id: text("domain_problem_binding_id"),
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
    workspaceJobFk: foreignKey({
      name: "submission_job_items_workspace_job_fk",
      columns: [table.domain_id, table.job_id],
      foreignColumns: [submissionJobs.domain_id, submissionJobs.id],
    }),
    workspaceBindingFk: foreignKey({
      name: "submission_job_items_workspace_binding_fk",
      columns: [table.domain_id, table.domain_problem_binding_id],
      foreignColumns: [
        domainProblemBindings.domain_id,
        domainProblemBindings.id,
      ],
    }),
    bindingProblemFk: foreignKey({
      name: "submission_job_items_binding_problem_fk",
      columns: [table.domain_problem_binding_id, table.problem_id],
      foreignColumns: [
        domainProblemBindings.id,
        domainProblemBindings.problem_id,
      ],
    }),
    sourceKindCheck: check(
      "submission_job_items_source_kind_check",
      sql`${table.source_kind} IN ('submission', 'objective')`,
    ),
    statusCheck: check(
      "submission_job_items_status_check",
      sql`${table.status} IN ('pending', 'preparing', 'dispatched', 'succeeded', 'failed', 'skipped')`,
    ),
    bindingRequiredCheck: check(
      "submission_job_items_binding_required_check",
      sql`${table.domain_problem_binding_id} IS NOT NULL OR ${table.status} IN ('failed', 'skipped')`,
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
    domain_id: text("domain_id").notNull().references(() => domains.id),
    domain_problem_binding_id: text("domain_problem_binding_id").notNull(),
    assignment_id: text("assignment_id"),
    assignment_item_id: text("assignment_item_id"),
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
    assignmentOriginCheck: check(
      "self_tests_assignment_origin_check",
      sql`(${table.assignment_id} IS NULL) = (${table.assignment_item_id} IS NULL)`,
    ),
    assignmentOriginFk: foreignKey({
      name: "self_tests_assignment_origin_fk",
      columns: [table.domain_id, table.assignment_id, table.assignment_item_id],
      foreignColumns: [
        assignmentItems.domain_id as AnyPgColumn,
        assignmentItems.assignment_id as AnyPgColumn,
        assignmentItems.id as AnyPgColumn,
      ],
    }),
    assignmentProblemFk: foreignKey({
      name: "self_tests_assignment_problem_fk",
      columns: [table.assignment_item_id, table.problem_id],
      foreignColumns: [
        assignmentItems.id as AnyPgColumn,
        assignmentItems.problem_id as AnyPgColumn,
      ],
    }),
    assignmentDomainFk: foreignKey({
      name: "self_tests_assignment_domain_fk",
      columns: [table.domain_id, table.assignment_id],
      foreignColumns: [
        assignments.domain_id as AnyPgColumn,
        assignments.id as AnyPgColumn,
      ],
    }),
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
    workspaceBindingFk: foreignKey({
      name: "self_tests_workspace_binding_fk",
      columns: [table.domain_id, table.domain_problem_binding_id],
      foreignColumns: [
        domainProblemBindings.domain_id,
        domainProblemBindings.id,
      ],
    }),
    bindingProblemFk: foreignKey({
      name: "self_tests_binding_problem_fk",
      columns: [table.domain_problem_binding_id, table.problem_id],
      foreignColumns: [
        domainProblemBindings.id,
        domainProblemBindings.problem_id,
      ],
    }),
    workspaceUserCreatedIdx: index("idx_self_tests_domain_user_created").on(
      table.domain_id,
      table.user_id,
      table.created_at,
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
