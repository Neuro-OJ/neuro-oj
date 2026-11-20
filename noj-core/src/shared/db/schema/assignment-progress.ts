/**
 * 作业进度投影。
 *
 * `assignment_progress` 引用 `evaluation_attempts`，因此从 `assignment.ts` 拆出：
 * `assignment.ts` 只保留作业、条目、接收人、历史、outbox 等基础定义，不再依赖
 * evaluations 的尝试表，从而断开 assignment → submission 的运行时导入环。
 */
import {
  bigint,
  boolean,
  check,
  foreignKey,
  index,
  integer,
  pgTable,
  text,
  unique,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { users } from "./identity.ts";
import { problemVersions } from "./catalog.ts";
import { assignmentItems, assignmentRecipients } from "./assignment.ts";
import { evaluationAttempts } from "./evaluation-records.ts";

/** 每个学生、条目及统计范围只有一份当前进度，保留来源尝试和策略依据。 */
export const assignmentProgress = pgTable("assignment_progress", {
  id: text("id").primaryKey(),
  domain_id: text("domain_id").notNull(),
  assignment_id: text("assignment_id").notNull(),
  item_id: text("item_id").notNull(),
  user_id: text("user_id").notNull().references(() => users.id),
  scope: text("scope").$type<"on_time" | "current">().notNull(),
  status: text("status").$type<
    "not_started" | "judging" | "below_target" | "achieved" | "unavailable"
  >().notNull(),
  score: integer("score"),
  accepted: boolean("accepted").notNull().default(false),
  source_submission_id: text("source_submission_id"),
  source_kind: text("source_kind").$type<"submission" | "objective">(),
  source_attempt_id: text("source_attempt_id").references(() =>
    evaluationAttempts.id
  ),
  evaluated_version_id: text("evaluated_version_id").references(() =>
    problemVersions.id
  ),
  accepted_attempt_id: text("accepted_attempt_id").references(() =>
    evaluationAttempts.id
  ),
  policy_revision: integer("policy_revision").notNull().default(0),
  projection_revision: bigint("projection_revision", { mode: "number" })
    .notNull().default(0),
  late: boolean("late").notNull().default(false),
  updated_at: text("updated_at").notNull(),
}, (t) => ({
  cellUnique: unique("assignment_progress_cell_unique").on(
    t.item_id,
    t.user_id,
    t.scope,
  ),
  itemFk: foreignKey({
    name: "assignment_progress_item_assignment_fk",
    columns: [t.domain_id, t.assignment_id, t.item_id],
    foreignColumns: [
      assignmentItems.domain_id,
      assignmentItems.assignment_id,
      assignmentItems.id,
    ],
  }),
  recipientFk: foreignKey({
    name: "assignment_progress_recipient_fk",
    columns: [t.assignment_id, t.user_id],
    foreignColumns: [
      assignmentRecipients.assignment_id,
      assignmentRecipients.user_id,
    ],
  }),
  scopeCheck: check(
    "assignment_progress_scope_check",
    sql`${t.scope} IN ('on_time', 'current')`,
  ),
  statusCheck: check(
    "assignment_progress_status_check",
    sql`${t.status} IN ('not_started', 'judging', 'below_target', 'achieved', 'unavailable')`,
  ),
  scoreCheck: check(
    "assignment_progress_score_check",
    sql`${t.score} IS NULL OR ${t.score} BETWEEN 0 AND 10000`,
  ),
  matrixIdx: index("idx_assignment_progress_matrix").on(
    t.domain_id,
    t.assignment_id,
    t.user_id,
    t.scope,
  ),
}));
