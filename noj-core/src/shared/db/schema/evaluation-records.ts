/**
 * 评测记录：尝试、普通提交、客观题提交及其受理序列。
 *
 * 这三张表彼此有循环外键（尝试引用两类提交，提交又持有尝试指针），必须放在同一
 * 文件里用惰性 `.references()` 与迁移期的 `ALTER TABLE` 外键保持定义顺序无关。
 * 拆到独立文件后，`submission.ts` / `objective.ts` 只从本文件导入，不再互相导入，
 * 从而断开 submission ↔ objective 的运行时导入环。
 *
 * 本文件只做表定义；写入与事务边界归 evaluations 模块。
 */
import {
  bigint,
  boolean,
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  pgSequence,
  pgTable,
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
import { domains } from "./workspace.ts";
import { domainProblemBindings } from "./catalog-workspace.ts";
import { assignmentItems, assignments } from "./assignment.ts";
import type {
  AttemptResultKind,
  AttemptSource,
  AttemptState,
  SubmissionVersionOrigin,
} from "../../versioning/types.ts";

/** 正式受理顺序，普通提交与客观题共用，不随评测或重测改变。 */
export const submissionReceiptSequence = pgSequence(
  "submission_receipt_sequence",
  { startWith: 1 },
);

/**
 * 数据库行状态字面量类型。
 *
 * 与 submission 域类型保持同一字面量集合；shared 层不反向依赖 domains，
 * 因此 schema 内保留本地类型别名用于 Drizzle $type<>。
 */
type SubmissionStatus = "pending" | "judging" | "finished" | "error";

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
    receipt_sequence: bigint("receipt_sequence", { mode: "number" }).notNull()
      .default(sql`nextval('submission_receipt_sequence')`),
    public_id: publicIdColumn("sub"),
    /** 使用域及其题库配置，创建后保持不变。 */
    domain_id: text("domain_id").notNull().references(() => domains.id),
    domain_problem_binding_id: text("domain_problem_binding_id").notNull(),
    /** 可选作业入口依据，不限制提交自动计入其他同域作业。 */
    assignment_id: text("assignment_id"),
    assignment_item_id: text("assignment_item_id"),
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
    workspaceContestFk: foreignKey({
      name: "submissions_workspace_contest_fk",
      columns: [table.domain_id, table.contest_id],
      foreignColumns: [contests.domain_id, contests.id],
    }),
    teachingSourceUnique: unique("submissions_teaching_source_unique").on(
      table.domain_id,
      table.id,
      table.user_id,
    ),
    assignmentOriginCheck: check(
      "submissions_assignment_origin_check",
      sql`(${table.assignment_id} IS NULL) = (${table.assignment_item_id} IS NULL)`,
    ),
    assignmentOriginFk: foreignKey({
      name: "submissions_assignment_origin_fk",
      columns: [table.domain_id, table.assignment_id, table.assignment_item_id],
      foreignColumns: [
        assignmentItems.domain_id as AnyPgColumn,
        assignmentItems.assignment_id as AnyPgColumn,
        assignmentItems.id as AnyPgColumn,
      ],
    }),
    assignmentProblemFk: foreignKey({
      name: "submissions_assignment_problem_fk",
      columns: [table.assignment_item_id, table.problem_id],
      foreignColumns: [
        assignmentItems.id as AnyPgColumn,
        assignmentItems.problem_id as AnyPgColumn,
      ],
    }),
    assignmentDomainFk: foreignKey({
      name: "submissions_assignment_domain_fk",
      columns: [table.domain_id, table.assignment_id],
      foreignColumns: [
        assignments.domain_id as AnyPgColumn,
        assignments.id as AnyPgColumn,
      ],
    }),
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
    workspaceBindingFk: foreignKey({
      name: "submissions_workspace_binding_fk",
      columns: [table.domain_id, table.domain_problem_binding_id],
      foreignColumns: [
        domainProblemBindings.domain_id,
        domainProblemBindings.id,
      ],
    }),
    bindingProblemFk: foreignKey({
      name: "submissions_binding_problem_fk",
      columns: [table.domain_problem_binding_id, table.problem_id],
      foreignColumns: [
        domainProblemBindings.id,
        domainProblemBindings.problem_id,
      ],
    }),
    workspaceUserCreatedIdx: index("idx_submissions_domain_user_created").on(
      table.domain_id,
      table.user_id,
      table.created_at,
    ),
    workspaceProblemUserIdx: index("idx_submissions_domain_problem_user").on(
      table.domain_id,
      table.problem_id,
      table.user_id,
    ),
    // 六个尝试指针（在途/最近/有效/通过/竞赛有效/竞赛通过）的外键
    // **故意不在此声明**：`evaluation_attempts.submission_id → submissions.id`
    // 与本表指针构成类型层面的互相引用，`foreignKey()` 立即求值列数组会让
    // TypeScript 推出 `any`（TS7022/TS7024）。外键由 PostgreSQL 迁移以
    // `ALTER TABLE ... ADD CONSTRAINT ... FOREIGN KEY ... ON DELETE SET NULL`
    // 建立（Handbook §6.1「循环外键使用延迟类型引用」）。
  }),
);

/**
 * 客观题提交表。
 * 服务端即时判定（不走评测队列），status 直接为 finished。
 * score 为 ×100 整数（0-10000），与评测尝试的分数约定一致。
 */
export const objectiveSubmissions = pgTable(
  "objective_submissions",
  {
    id: text("id").primaryKey(),
    receipt_sequence: bigint("receipt_sequence", { mode: "number" }).notNull()
      .default(sql`nextval('submission_receipt_sequence')`),
    domain_id: text("domain_id").notNull().references(() => domains.id),
    domain_problem_binding_id: text("domain_problem_binding_id").notNull(),
    assignment_id: text("assignment_id"),
    assignment_item_id: text("assignment_item_id"),
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
    /** 用户升级生成的新客观题提交指向的来源；来源删除后置空。 */
    upgraded_from_id: text("upgraded_from_id").references(
      (): AnyPgColumn => objectiveSubmissions.id,
      { onDelete: "set null" },
    ),
    /**
     * 六个尝试指针（在途 / 最近 / 有效 / 通过 / 竞赛有效 / 竞赛通过）。
     *
     * **故意不在 Drizzle 中声明外键**：`objective.ts` 与 `submission.ts`
     * 互相引用（attempts 需要两个提交外键），而 `foreignKey()` 的列数组在定义处
     * 立即求值，模块求值顺序不同就会 TDZ 崩溃。外键由 PostgreSQL 迁移以
     * `ALTER TABLE ... ADD CONSTRAINT` 形式建立（与 Handbook §6.1「循环外键使用
     * 延迟类型引用；迁移先建表，再添加关联外键」一致）。
     */
    active_attempt_id: text("active_attempt_id"),
    latest_attempt_id: text("latest_attempt_id"),
    is_valid: boolean("is_valid").notNull().default(false),
    is_accepted: boolean("is_accepted").notNull().default(false),
    effective_attempt_id: text("effective_attempt_id"),
    accepted_attempt_id: text("accepted_attempt_id"),
    is_contest_valid: boolean("is_contest_valid").notNull().default(false),
    is_contest_accepted: boolean("is_contest_accepted").notNull().default(
      false,
    ),
    contest_effective_attempt_id: text("contest_effective_attempt_id"),
    contest_accepted_attempt_id: text("contest_accepted_attempt_id"),
    /** 投影时读取的题库策略 revision。 */
    global_policy_revision: integer("global_policy_revision").notNull().default(
      0,
    ),
    /** 投影时读取的「竞赛×题目」策略 revision；非竞赛提交为空。 */
    contest_policy_revision: integer("contest_policy_revision"),
    /** 重判序列号；客观题同样有版本化重判，语义与普通提交一致。 */
    rejudge_seq: integer("rejudge_seq").notNull().default(0),
    created_at: text("created_at").notNull(),
  },
  (table) => ({
    workspaceContestFk: foreignKey({
      name: "objective_submissions_workspace_contest_fk",
      columns: [table.domain_id, table.contest_id],
      foreignColumns: [contests.domain_id, contests.id],
    }),
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
    assignmentOriginCheck: check(
      "objective_submissions_assignment_origin_check",
      sql`(${table.assignment_id} IS NULL) = (${table.assignment_item_id} IS NULL)`,
    ),
    assignmentOriginFk: foreignKey({
      name: "objective_submissions_assignment_origin_fk",
      columns: [table.domain_id, table.assignment_id, table.assignment_item_id],
      foreignColumns: [
        assignmentItems.domain_id as AnyPgColumn,
        assignmentItems.assignment_id as AnyPgColumn,
        assignmentItems.id as AnyPgColumn,
      ],
    }),
    assignmentProblemFk: foreignKey({
      name: "objective_submissions_assignment_problem_fk",
      columns: [table.assignment_item_id, table.paper_id],
      foreignColumns: [
        assignmentItems.id as AnyPgColumn,
        assignmentItems.problem_id as AnyPgColumn,
      ],
    }),
    assignmentDomainFk: foreignKey({
      name: "objective_submissions_assignment_domain_fk",
      columns: [table.domain_id, table.assignment_id],
      foreignColumns: [
        assignments.domain_id as AnyPgColumn,
        assignments.id as AnyPgColumn,
      ],
    }),
    paperIdx: index("idx_objective_submissions_paper_id").on(table.paper_id),
    userIdx: index("idx_objective_submissions_user_id").on(table.user_id),
    /** 提交历史按用户+套卷+时间倒序分页 */
    userPaperCreatedIdx: index(
      "idx_objective_submissions_user_paper_created",
    ).on(table.user_id, table.paper_id, table.created_at),
    contestIdx: index("idx_objective_submissions_contest_id").on(
      table.contest_id,
    ),
    /** 题库有效状态查询（客观题套卷）。 */
    paperAcceptedUserIdx: index(
      "idx_objective_submissions_paper_accepted_user",
    ).on(table.paper_id, table.is_accepted, table.user_id),
    paperValidUserIdx: index("idx_objective_submissions_paper_valid_user").on(
      table.paper_id,
      table.is_valid,
      table.user_id,
    ),
    /** 竞赛有效状态查询。 */
    contestValidUserIdx: index(
      "idx_objective_submissions_contest_valid_user",
    ).on(
      table.contest_id,
      table.paper_id,
      table.is_contest_valid,
      table.user_id,
    ),
    versionOriginCheck: check(
      "objective_submissions_version_origin_check",
      sql`(${table.version_origin} = 'known' AND ${table.submitted_version_id} IS NOT NULL)
        OR (${table.version_origin} = 'legacy_unknown' AND ${table.submitted_version_id} IS NULL)`,
    ),
    /** 提交时版本必须属于该套卷（复合外键）。 */
    submittedVersionFk: foreignKey({
      name: "objective_submissions_submitted_version_fk",
      columns: [table.paper_id, table.submitted_version_id],
      foreignColumns: [problemVersions.problem_id, problemVersions.id],
    }),
    workspaceBindingFk: foreignKey({
      name: "objective_submissions_workspace_binding_fk",
      columns: [table.domain_id, table.domain_problem_binding_id],
      foreignColumns: [
        domainProblemBindings.domain_id,
        domainProblemBindings.id,
      ],
    }),
    bindingProblemFk: foreignKey({
      name: "objective_submissions_binding_problem_fk",
      columns: [table.domain_problem_binding_id, table.paper_id],
      foreignColumns: [
        domainProblemBindings.id,
        domainProblemBindings.problem_id,
      ],
    }),
    workspaceUserPaperIdx: index("idx_objective_submissions_domain_user_paper")
      .on(table.domain_id, table.user_id, table.paper_id, table.created_at),
  }),
);
