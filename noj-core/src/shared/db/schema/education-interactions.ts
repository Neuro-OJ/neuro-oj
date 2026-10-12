import {
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
import {
  assignmentItems,
  assignmentRecipients,
  assignments,
  educationOutbox,
} from "./assignment.ts";
import { submissions } from "./submission.ts";
import { objectiveSubmissions } from "./objective.ts";

/** 整体或学生反馈默认向目标学生可见，作者注销不级联删除教学历史。 */
export const assignmentFeedback = pgTable("assignment_feedback", {
  id: text("id").primaryKey(),
  domain_id: text("domain_id").notNull(),
  assignment_id: text("assignment_id").notNull(),
  target_user_id: text("target_user_id"),
  author_id: text("author_id").notNull().references(() => users.id),
  body: text("body").notNull(),
  revision: integer("revision").notNull().default(0),
  created_at: text("created_at").notNull(),
  updated_at: text("updated_at").notNull(),
  deleted_at: text("deleted_at"),
}, (t) => ({
  identity: unique("assignment_feedback_scope_unique").on(
    t.domain_id,
    t.assignment_id,
    t.id,
  ),
  assignmentFk: foreignKey({
    name: "assignment_feedback_assignment_fk",
    columns: [t.domain_id, t.assignment_id],
    foreignColumns: [assignments.domain_id, assignments.id],
  }),
  recipientFk: foreignKey({
    name: "assignment_feedback_recipient_fk",
    columns: [t.domain_id, t.assignment_id, t.target_user_id],
    foreignColumns: [
      assignmentRecipients.domain_id,
      assignmentRecipients.assignment_id,
      assignmentRecipients.user_id,
    ],
  }),
  revisionCheck: check(
    "assignment_feedback_revision_check",
    sql`${t.revision} >= 0`,
  ),
  bodyCheck: check(
    "assignment_feedback_body_check",
    sql`char_length(${t.body}) BETWEEN 1 AND 30000`,
  ),
  listIdx: index("idx_assignment_feedback_list").on(
    t.domain_id,
    t.assignment_id,
    t.created_at,
  ),
}));

/** 求助关联目标学生和可选题目／原提交，讨论不携带 evaluator 数据。 */
export const assignmentHelpRequests = pgTable("assignment_help_requests", {
  id: text("id").primaryKey(),
  domain_id: text("domain_id").notNull(),
  assignment_id: text("assignment_id").notNull(),
  user_id: text("user_id").notNull(),
  item_id: text("item_id"),
  submission_id: text("submission_id").references(() => submissions.id, {
    onDelete: "set null",
  }),
  objective_submission_id: text("objective_submission_id").references(
    () => objectiveSubmissions.id,
    { onDelete: "set null" },
  ),
  body: text("body").notNull(),
  state: text("state").$type<"open" | "resolved">().notNull().default("open"),
  revision: integer("revision").notNull().default(0),
  handled_by: text("handled_by").references(() => users.id),
  handled_at: text("handled_at"),
  created_at: text("created_at").notNull(),
  updated_at: text("updated_at").notNull(),
}, (t) => ({
  identity: unique("assignment_help_requests_scope_unique").on(
    t.domain_id,
    t.assignment_id,
    t.id,
  ),
  recipientFk: foreignKey({
    name: "assignment_help_requests_recipient_fk",
    columns: [t.domain_id, t.assignment_id, t.user_id],
    foreignColumns: [
      assignmentRecipients.domain_id,
      assignmentRecipients.assignment_id,
      assignmentRecipients.user_id,
    ],
  }),
  itemFk: foreignKey({
    name: "assignment_help_requests_item_fk",
    columns: [t.domain_id, t.assignment_id, t.item_id],
    foreignColumns: [
      assignmentItems.domain_id,
      assignmentItems.assignment_id,
      assignmentItems.id,
    ],
  }),
  sourceCheck: check(
    "assignment_help_requests_source_check",
    sql`NOT (${t.submission_id} IS NOT NULL AND ${t.objective_submission_id} IS NOT NULL)`,
  ),
  stateCheck: check(
    "assignment_help_requests_state_check",
    sql`${t.state} IN ('open','resolved')`,
  ),
  revisionCheck: check(
    "assignment_help_requests_revision_check",
    sql`${t.revision} >= 0`,
  ),
  bodyCheck: check(
    "assignment_help_requests_body_check",
    sql`char_length(${t.body}) BETWEEN 1 AND 30000`,
  ),
  listIdx: index("idx_assignment_help_requests_list").on(
    t.domain_id,
    t.assignment_id,
    t.state,
    t.created_at,
  ),
}));

/** 回复只追加，不覆盖已发送内容和作者依据。 */
export const assignmentHelpReplies = pgTable("assignment_help_replies", {
  id: text("id").primaryKey(),
  domain_id: text("domain_id").notNull(),
  assignment_id: text("assignment_id").notNull(),
  help_id: text("help_id").notNull(),
  author_id: text("author_id").notNull().references(() => users.id),
  body: text("body").notNull(),
  created_at: text("created_at").notNull(),
}, (t) => ({
  identity: unique("assignment_help_replies_scope_unique").on(
    t.domain_id,
    t.assignment_id,
    t.id,
  ),
  requestFk: foreignKey({
    name: "assignment_help_replies_request_fk",
    columns: [t.domain_id, t.assignment_id, t.help_id],
    foreignColumns: [
      assignmentHelpRequests.domain_id,
      assignmentHelpRequests.assignment_id,
      assignmentHelpRequests.id,
    ],
  }),
  bodyCheck: check(
    "assignment_help_replies_body_check",
    sql`char_length(${t.body}) BETWEEN 1 AND 30000`,
  ),
  listIdx: index("idx_assignment_help_replies_list").on(
    t.help_id,
    t.created_at,
  ),
}));

/** 教学通知只保存受控定位信息，列表及点击重新检查当前关系，不存私有内容摘要。 */
export const educationNotifications = pgTable("education_notifications", {
  id: text("id").primaryKey(),
  domain_id: text("domain_id").notNull(),
  assignment_id: text("assignment_id").notNull(),
  user_id: text("user_id").notNull().references(() => users.id),
  event_id: text("event_id").notNull().references(() => educationOutbox.id),
  type: text("type").$type<
    | "assignment"
    | "assignment_changed"
    | "resource_unavailable"
    | "feedback"
    | "help"
    | "help_reply"
  >().notNull(),
  feedback_id: text("feedback_id"),
  help_id: text("help_id"),
  reply_id: text("reply_id"),
  created_at: text("created_at").notNull(),
  read_at: text("read_at"),
}, (t) => ({
  deliveryUnique: unique("education_notifications_delivery_unique").on(
    t.event_id,
    t.user_id,
  ),
  assignmentFk: foreignKey({
    name: "education_notifications_assignment_fk",
    columns: [t.domain_id, t.assignment_id],
    foreignColumns: [assignments.domain_id, assignments.id],
  }),
  feedbackFk: foreignKey({
    name: "education_notifications_feedback_fk",
    columns: [t.domain_id, t.assignment_id, t.feedback_id],
    foreignColumns: [
      assignmentFeedback.domain_id,
      assignmentFeedback.assignment_id,
      assignmentFeedback.id,
    ],
  }),
  helpFk: foreignKey({
    name: "education_notifications_help_fk",
    columns: [t.domain_id, t.assignment_id, t.help_id],
    foreignColumns: [
      assignmentHelpRequests.domain_id,
      assignmentHelpRequests.assignment_id,
      assignmentHelpRequests.id,
    ],
  }),
  replyFk: foreignKey({
    name: "education_notifications_reply_fk",
    columns: [t.domain_id, t.assignment_id, t.reply_id],
    foreignColumns: [
      assignmentHelpReplies.domain_id,
      assignmentHelpReplies.assignment_id,
      assignmentHelpReplies.id,
    ],
  }),
  typeCheck: check(
    "education_notifications_type_check",
    sql`${t.type} IN ('assignment','assignment_changed','resource_unavailable','feedback','help','help_reply')`,
  ),
  sourceCheck: check(
    "education_notifications_source_check",
    sql`
    (${t.type} IN ('assignment','assignment_changed','resource_unavailable') AND ${t.feedback_id} IS NULL AND ${t.help_id} IS NULL AND ${t.reply_id} IS NULL)
    OR (${t.type} = 'feedback' AND ${t.feedback_id} IS NOT NULL AND ${t.help_id} IS NULL AND ${t.reply_id} IS NULL)
    OR (${t.type} = 'help' AND ${t.feedback_id} IS NULL AND ${t.help_id} IS NOT NULL AND ${t.reply_id} IS NULL)
    OR (${t.type} = 'help_reply' AND ${t.feedback_id} IS NULL AND ${t.help_id} IS NOT NULL AND ${t.reply_id} IS NOT NULL)`,
  ),
  listIdx: index("idx_education_notifications_user").on(
    t.domain_id,
    t.user_id,
    t.created_at,
  ),
}));
