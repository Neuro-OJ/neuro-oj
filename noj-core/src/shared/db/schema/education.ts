import {
  check,
  foreignKey,
  index,
  integer,
  pgTable,
  primaryKey,
  text,
  unique,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { users } from "./identity.ts";
import { domainMemberships, domains } from "./workspace.ts";
import { contests } from "./contest.ts";
import {
  ASSISTANT_CAPABILITIES,
  type AssistantCapability,
  type ClassroomRole,
} from "../../education-types.ts";

/** 班级保留稳定身份，归档不删除成员及教学历史。 */
export const classrooms = pgTable("classrooms", {
  id: text("id").primaryKey(),
  domain_id: text("domain_id").notNull().references(() => domains.id),
  name: text("name").notNull(),
  description: text("description").notNull().default(""),
  stage_tag: text("stage_tag").notNull().default(""),
  status: text("status").$type<"active" | "archived">().notNull().default(
    "active",
  ),
  primary_coach_id: text("primary_coach_id").notNull().references(() =>
    users.id
  ),
  revision: integer("revision").notNull().default(0),
  created_at: text("created_at").notNull(),
  updated_at: text("updated_at").notNull(),
}, (t) => ({
  domainIdUnique: unique("classrooms_domain_id_unique").on(t.domain_id, t.id),
  coachFk: foreignKey({
    name: "classrooms_coach_domain_fk",
    columns: [t.domain_id, t.primary_coach_id],
    foreignColumns: [domainMemberships.domain_id, domainMemberships.user_id],
  }),
  statusCheck: check(
    "classrooms_status_check",
    sql`${t.status} IN ('active', 'archived')`,
  ),
  revisionCheck: check("classrooms_revision_check", sql`${t.revision} >= 0`),
  domainIdx: index("idx_classrooms_domain_status").on(
    t.domain_id,
    t.status,
    t.created_at,
  ),
}));

/** 每班每账号一条身份记录，退出保留，重新加入时显式恢复。 */
export const classroomMemberships = pgTable("classroom_memberships", {
  id: text("id").primaryKey(),
  domain_id: text("domain_id").notNull(),
  classroom_id: text("classroom_id").notNull(),
  user_id: text("user_id").notNull().references(() => users.id),
  role: text("role").$type<ClassroomRole>().notNull(),
  status: text("status").$type<"active" | "removed">().notNull().default(
    "active",
  ),
  joined_at: text("joined_at").notNull(),
  appointed_at: text("appointed_at").notNull(),
  left_at: text("left_at"),
}, (t) => ({
  identityUnique: unique("classroom_memberships_identity_unique").on(
    t.classroom_id,
    t.user_id,
  ),
  domainIdUnique: unique("classroom_memberships_domain_id_unique").on(
    t.domain_id,
    t.id,
  ),
  recipientUnique: unique("classroom_memberships_recipient_unique").on(
    t.domain_id,
    t.classroom_id,
    t.user_id,
  ),
  classroomFk: foreignKey({
    name: "classroom_memberships_classroom_domain_fk",
    columns: [t.domain_id, t.classroom_id],
    foreignColumns: [classrooms.domain_id, classrooms.id],
  }),
  memberFk: foreignKey({
    name: "classroom_memberships_member_domain_fk",
    columns: [t.domain_id, t.user_id],
    foreignColumns: [domainMemberships.domain_id, domainMemberships.user_id],
  }),
  roleCheck: check(
    "classroom_memberships_role_check",
    sql`${t.role} IN ('coach', 'assistant', 'student')`,
  ),
  statusCheck: check(
    "classroom_memberships_status_check",
    sql`${t.status} IN ('active', 'removed')`,
  ),
  userIdx: index("idx_classroom_memberships_domain_user").on(
    t.domain_id,
    t.user_id,
    t.status,
  ),
}));

/** 授权保存在数据库，撤权后的请求不继续使用旧 JWT 或本地缓存。 */
export const classroomAssistantGrants = pgTable("classroom_assistant_grants", {
  membership_id: text("membership_id").notNull().references(() =>
    classroomMemberships.id
  ),
  capability: text("capability").$type<AssistantCapability>().notNull(),
  granted_by: text("granted_by").notNull().references(() => users.id),
  granted_at: text("granted_at").notNull(),
}, (t) => ({
  pk: primaryKey({ columns: [t.membership_id, t.capability] }),
  capabilityCheck: check(
    "classroom_assistant_grants_capability_check",
    sql`${t.capability} IN (${
      sql.raw(ASSISTANT_CAPABILITIES.map((v) => `'${v}'`).join(","))
    })`,
  ),
}));

/** 班级关联比赛不复制提交或成绩，同域由复合外键保证。 */
export const classroomContestLinks = pgTable("classroom_contest_links", {
  domain_id: text("domain_id").notNull(),
  classroom_id: text("classroom_id").notNull(),
  contest_id: text("contest_id").notNull(),
  linked_by: text("linked_by").notNull().references(() => users.id),
  linked_at: text("linked_at").notNull(),
}, (t) => ({
  pk: primaryKey({ columns: [t.classroom_id, t.contest_id] }),
  classroomFk: foreignKey({
    name: "classroom_contest_links_classroom_domain_fk",
    columns: [t.domain_id, t.classroom_id],
    foreignColumns: [classrooms.domain_id, classrooms.id],
  }),
  contestFk: foreignKey({
    name: "classroom_contest_links_contest_domain_fk",
    columns: [t.domain_id, t.contest_id],
    foreignColumns: [contests.domain_id, contests.id],
  }),
}));

/** 班级加入申请不直接创建账号或提升业务角色。 */
export const classroomJoinRequests = pgTable("classroom_join_requests", {
  id: text("id").primaryKey(),
  domain_id: text("domain_id").notNull(),
  classroom_id: text("classroom_id").notNull(),
  user_id: text("user_id").notNull().references(() => users.id),
  reason: text("reason").notNull().default(""),
  status: text("status").$type<"pending" | "approved" | "rejected">().notNull()
    .default("pending"),
  reviewed_by: text("reviewed_by").references(() => users.id),
  created_at: text("created_at").notNull(),
  reviewed_at: text("reviewed_at"),
}, (t) => ({
  classroomFk: foreignKey({
    name: "classroom_join_requests_classroom_domain_fk",
    columns: [t.domain_id, t.classroom_id],
    foreignColumns: [classrooms.domain_id, classrooms.id],
  }),
  statusCheck: check(
    "classroom_join_requests_status_check",
    sql`${t.status} IN ('pending', 'approved', 'rejected')`,
  ),
  pendingUnique: uniqueIndex("classroom_join_requests_pending_unique").on(
    t.classroom_id,
    t.user_id,
  ).where(sql`${t.status} = 'pending'`),
}));
