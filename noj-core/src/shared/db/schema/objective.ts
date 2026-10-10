import {
  boolean,
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  unique,
} from "drizzle-orm/pg-core";
import type { AnyPgColumn } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { users } from "./identity.ts";
import { problems, problemVersions } from "./catalog.ts";
import { contests } from "./contest.ts";
import type { SubmissionVersionOrigin } from "../../versioning/types.ts";

/**
 * 客观题提交表。
 * 服务端即时判定（不走评测队列），status 直接为 finished。
 * score 为 ×100 整数（0-10000），与评测尝试的分数约定一致。
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
     * 立即求值，模块求值顺序不同就会 TDZ 崩溃。外键由迁移与 PGlite DDL 以
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
  }),
);
