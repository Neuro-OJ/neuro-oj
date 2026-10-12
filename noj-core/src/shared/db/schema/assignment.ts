import {
  bigint,
  boolean,
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  unique,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import type { AnyPgColumn } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { users } from "./identity.ts";
import { domains } from "./workspace.ts";
import { classroomMemberships, classrooms } from "./education.ts";
import { problems, problemVersions, trainings } from "./catalog.ts";
import {
  domainProblemBindings,
  problemBindingHistory,
} from "./catalog-workspace.ts";
import { contests } from "./contest.ts";
import { evaluationAttempts } from "./submission.ts";
import type { AssignmentState } from "../../education-types.ts";

/** 发布固定题目集合与要求，截止和当前完成状态由时间及判定事实计算。 */
export const assignments = pgTable("assignments", {
  id: text("id").primaryKey(),
  domain_id: text("domain_id").notNull().references(() => domains.id),
  classroom_id: text("classroom_id").notNull(),
  title: text("title").notNull(),
  description: text("description").notNull().default(""),
  state: text("state").$type<AssignmentState>().notNull().default("draft"),
  revision: integer("revision").notNull().default(0),
  publish_at: text("publish_at"),
  deadline_at: text("deadline_at"),
  published_at: text("published_at"),
  ended_at: text("ended_at"),
  archived_at: text("archived_at"),
  include_previous_submissions: boolean("include_previous_submissions")
    .notNull().default(false),
  target_student_ids: jsonb("target_student_ids").$type<string[]>(),
  source_training_id: text("source_training_id").references(() => trainings.id),
  source_training_rule: jsonb("source_training_rule").$type<{
    requirement: "accepted" | "min_score";
    minimum_score: number | null;
  }>(),
  source_assignment_id: text("source_assignment_id").references(
    (): AnyPgColumn => assignments.id,
  ),
  source_contest_id: text("source_contest_id"),
  publish_error: text("publish_error"),
  created_by: text("created_by").notNull().references(() => users.id),
  created_at: text("created_at").notNull(),
  updated_at: text("updated_at").notNull(),
}, (t) => ({
  domainUnique: unique("assignments_domain_id_unique").on(t.domain_id, t.id),
  classUnique: unique("assignments_class_domain_unique").on(
    t.domain_id,
    t.id,
    t.classroom_id,
  ),
  classroomFk: foreignKey({
    name: "assignments_classroom_domain_fk",
    columns: [t.domain_id, t.classroom_id],
    foreignColumns: [classrooms.domain_id, classrooms.id],
  }),
  contestFk: foreignKey({
    name: "assignments_source_contest_domain_fk",
    columns: [t.domain_id, t.source_contest_id],
    foreignColumns: [contests.domain_id, contests.id],
  }),
  sourceFk: foreignKey({
    name: "assignments_source_assignment_domain_fk",
    columns: [t.domain_id, t.source_assignment_id],
    foreignColumns: [t.domain_id, t.id],
  }),
  stateCheck: check(
    "assignments_state_check",
    sql`${t.state} IN ('draft', 'scheduled', 'published', 'archived')`,
  ),
  revisionCheck: check("assignments_revision_check", sql`${t.revision} >= 0`),
  scheduledCheck: check(
    "assignments_schedule_check",
    sql`${t.state} <> 'scheduled' OR ${t.publish_at} IS NOT NULL`,
  ),
  publishedCheck: check(
    "assignments_publish_check",
    sql`${t.state} <> 'published' OR ${t.published_at} IS NOT NULL`,
  ),
  classIdx: index("idx_assignments_class_state").on(
    t.domain_id,
    t.classroom_id,
    t.state,
    t.deadline_at,
  ),
}));

/** 作业条目引用使用域唯一绑定，发布依据与当前策略同时保留。 */
export const assignmentItems = pgTable("assignment_items", {
  id: text("id").primaryKey(),
  domain_id: text("domain_id").notNull(),
  assignment_id: text("assignment_id").notNull(),
  problem_id: text("problem_id").notNull().references(() => problems.id),
  binding_id: text("binding_id").notNull(),
  sort_order: integer("sort_order").notNull(),
  requirement: text("requirement").$type<"accepted" | "min_score">().notNull(),
  minimum_score: integer("minimum_score"),
  published_version_id: text("published_version_id"),
  published_policy_mode: text("published_policy_mode").notNull().default("any"),
  published_required_version_id: text("published_required_version_id"),
  published_policy_revision: integer("published_policy_revision").notNull()
    .default(0),
  answer_version_id: text("answer_version_id"),
  policy_revision: integer("policy_revision").notNull().default(0),
  resource_available: boolean("resource_available").notNull().default(true),
}, (t) => ({
  domainUnique: unique("assignment_items_domain_id_unique").on(
    t.domain_id,
    t.id,
  ),
  sourceUnique: unique("assignment_items_id_problem_unique").on(
    t.id,
    t.problem_id,
  ),
  assignmentUnique: unique("assignment_items_assignment_id_unique").on(
    t.domain_id,
    t.assignment_id,
    t.id,
  ),
  problemUnique: unique("assignment_items_problem_unique").on(
    t.assignment_id,
    t.problem_id,
  ),
  orderUnique: unique("assignment_items_order_unique").on(
    t.assignment_id,
    t.sort_order,
  ),
  assignmentFk: foreignKey({
    name: "assignment_items_assignment_domain_fk",
    columns: [t.domain_id, t.assignment_id],
    foreignColumns: [assignments.domain_id, assignments.id],
  }),
  bindingFk: foreignKey({
    name: "assignment_items_binding_domain_fk",
    columns: [t.domain_id, t.binding_id],
    foreignColumns: [domainProblemBindings.domain_id, domainProblemBindings.id],
  }),
  sourceFk: foreignKey({
    name: "assignment_items_binding_problem_fk",
    columns: [t.binding_id, t.problem_id],
    foreignColumns: [
      domainProblemBindings.id,
      domainProblemBindings.problem_id,
    ],
  }),
  publishedFk: foreignKey({
    name: "assignment_items_published_version_fk",
    columns: [t.problem_id, t.published_version_id],
    foreignColumns: [problemVersions.problem_id, problemVersions.id],
  }),
  requiredFk: foreignKey({
    name: "assignment_items_required_version_fk",
    columns: [t.problem_id, t.published_required_version_id],
    foreignColumns: [problemVersions.problem_id, problemVersions.id],
  }),
  answerFk: foreignKey({
    name: "assignment_items_answer_version_fk",
    columns: [t.problem_id, t.answer_version_id],
    foreignColumns: [problemVersions.problem_id, problemVersions.id],
  }),
  requirementCheck: check(
    "assignment_items_requirement_check",
    sql`(${t.requirement} = 'accepted' AND ${t.minimum_score} IS NULL) OR
    (${t.requirement} = 'min_score' AND ${t.minimum_score} IS NOT NULL AND ${t.minimum_score} BETWEEN 0 AND 10000)`,
  ),
  policyCheck: check(
    "assignment_items_published_policy_check",
    sql`(${t.published_policy_mode} = 'any' AND ${t.published_required_version_id} IS NULL) OR
    (${t.published_policy_mode} = 'exact' AND ${t.published_required_version_id} IS NOT NULL)`,
  ),
  orderCheck: check(
    "assignment_items_order_check",
    sql`${t.sort_order} >= 0 AND ${t.policy_revision} >= 0 AND ${t.published_policy_revision} >= 0`,
  ),
  bindingIdx: index("idx_assignment_items_binding").on(
    t.domain_id,
    t.binding_id,
    t.assignment_id,
  ),
}));

/** 实际接收名单保留入班与退出区间，不把离班后的个人练习授权给教师。 */
export const assignmentRecipients = pgTable("assignment_recipients", {
  id: text("id").primaryKey(),
  domain_id: text("domain_id").notNull(),
  classroom_id: text("classroom_id").notNull(),
  assignment_id: text("assignment_id").notNull(),
  user_id: text("user_id").notNull().references(() => users.id),
  status: text("status").$type<"active" | "historical">().notNull().default(
    "active",
  ),
  added_by: text("added_by").$type<"initial" | "automatic" | "manual">()
    .notNull(),
  joined_at: text("joined_at").notNull(),
  left_at: text("left_at"),
  credit_intervals: jsonb("credit_intervals").$type<
    Array<{ start: string; end: string | null }>
  >().notNull().default([]),
}, (t) => ({
  userUnique: unique("assignment_recipients_user_unique").on(
    t.assignment_id,
    t.user_id,
  ),
  assignmentFk: foreignKey({
    name: "assignment_recipients_assignment_class_fk",
    columns: [t.domain_id, t.assignment_id, t.classroom_id],
    foreignColumns: [
      assignments.domain_id,
      assignments.id,
      assignments.classroom_id,
    ],
  }),
  memberFk: foreignKey({
    name: "assignment_recipients_class_member_fk",
    columns: [t.domain_id, t.classroom_id, t.user_id],
    foreignColumns: [
      classroomMemberships.domain_id,
      classroomMemberships.classroom_id,
      classroomMemberships.user_id,
    ],
  }),
  statusCheck: check(
    "assignment_recipients_status_check",
    sql`${t.status} IN ('active', 'historical')`,
  ),
  sourceCheck: check(
    "assignment_recipients_added_by_check",
    sql`${t.added_by} IN ('initial', 'automatic', 'manual')`,
  ),
  userIdx: index("idx_assignment_recipients_domain_user").on(
    t.domain_id,
    t.user_id,
    t.assignment_id,
  ),
}));

/** 题库策略和默认作答版本变化沿革，不改写发布时依据。 */
export const assignmentItemHistory = pgTable("assignment_item_history", {
  id: text("id").primaryKey(),
  domain_id: text("domain_id").notNull(),
  item_id: text("item_id").notNull(),
  binding_history_id: text("binding_history_id").references(() =>
    problemBindingHistory.id
  ),
  problem_id: text("problem_id").notNull(),
  answer_version_id: text("answer_version_id"),
  policy_mode: text("policy_mode").notNull(),
  required_version_id: text("required_version_id"),
  policy_revision: integer("policy_revision").notNull(),
  reason: text("reason").notNull(),
  actor_id: text("actor_id").references(() => users.id),
  created_at: text("created_at").notNull(),
}, (t) => ({
  bindingChangeUnique: unique("assignment_item_history_binding_change_unique")
    .on(t.item_id, t.binding_history_id),
  itemFk: foreignKey({
    name: "assignment_item_history_item_domain_fk",
    columns: [t.domain_id, t.item_id],
    foreignColumns: [assignmentItems.domain_id, assignmentItems.id],
  }),
  sourceFk: foreignKey({
    name: "assignment_item_history_item_problem_fk",
    columns: [t.item_id, t.problem_id],
    foreignColumns: [assignmentItems.id, assignmentItems.problem_id],
  }),
  policyCheck: check(
    "assignment_item_history_policy_check",
    sql`(${t.policy_mode} = 'any' AND ${t.required_version_id} IS NULL) OR
      (${t.policy_mode} = 'exact' AND ${t.required_version_id} IS NOT NULL)`,
  ),
  answerFk: foreignKey({
    name: "assignment_item_history_answer_version_fk",
    columns: [t.problem_id, t.answer_version_id],
    foreignColumns: [problemVersions.problem_id, problemVersions.id],
  }),
  requiredFk: foreignKey({
    name: "assignment_item_history_required_version_fk",
    columns: [t.problem_id, t.required_version_id],
    foreignColumns: [problemVersions.problem_id, problemVersions.id],
  }),
}));

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

/** 持久教学事件通过数据库租约消费，不依赖 Redis 通知可靠送达。 */
export const educationOutbox = pgTable("education_outbox", {
  id: text("id").primaryKey(),
  domain_id: text("domain_id").notNull().references(() => domains.id),
  event_type: text("event_type").notNull(),
  user_id: text("user_id").references(() => users.id),
  problem_id: text("problem_id").references(() => problems.id),
  classroom_id: text("classroom_id"),
  assignment_id: text("assignment_id"),
  payload: jsonb("payload").$type<Record<string, unknown>>().notNull().default(
    {},
  ),
  created_at: text("created_at").notNull(),
  available_at: text("available_at").notNull(),
  leased_until: text("leased_until"),
  lease_token: text("lease_token"),
  attempts: integer("attempts").notNull().default(0),
  processed_at: text("processed_at"),
  last_error: text("last_error"),
}, (t) => ({
  classroomFk: foreignKey({
    name: "education_outbox_classroom_domain_fk",
    columns: [t.domain_id, t.classroom_id],
    foreignColumns: [classrooms.domain_id, classrooms.id],
  }),
  assignmentFk: foreignKey({
    name: "education_outbox_assignment_domain_fk",
    columns: [t.domain_id, t.assignment_id],
    foreignColumns: [assignments.domain_id, assignments.id],
  }),
  leaseIdx: index("idx_education_outbox_pending").on(
    t.processed_at,
    t.available_at,
    t.leased_until,
  ),
  refreshUnique: uniqueIndex("education_outbox_pending_refresh_unique").on(
    t.domain_id,
    t.assignment_id,
    sql`COALESCE(${t.user_id}, '')`,
  ).where(
    sql`${t.event_type} = 'assignment.refresh' AND ${t.processed_at} IS NULL`,
  ),
}));

/** 教学模块停用区间用于排除停用期间练习，重新启用不自动回填。 */
export const educationDisabledIntervals = pgTable(
  "education_disabled_intervals",
  {
    id: text("id").primaryKey(),
    domain_id: text("domain_id").references(() => domains.id),
    started_at: text("started_at").notNull(),
    ended_at: text("ended_at"),
    reason: text("reason").notNull(),
  },
  (t) => ({
    domainIdx: index("idx_education_disabled_intervals_domain").on(
      t.domain_id,
      t.started_at,
    ),
  }),
);

/** 幂等结果只保存资源引用及摘要，不保存邀请明文令牌或学生源码。 */
export const educationOperations = pgTable("education_operations", {
  id: text("id").primaryKey(),
  domain_id: text("domain_id").notNull().references(() => domains.id),
  actor_id: text("actor_id").notNull().references(() => users.id),
  operation: text("operation").notNull(),
  idempotency_key: text("idempotency_key").notNull(),
  request_hash: text("request_hash").notNull(),
  result: jsonb("result").$type<Record<string, unknown>>().notNull(),
  created_at: text("created_at").notNull(),
}, (t) => ({
  operationUnique: unique("education_operations_key_unique").on(
    t.domain_id,
    t.actor_id,
    t.operation,
    t.idempotency_key,
  ),
}));
