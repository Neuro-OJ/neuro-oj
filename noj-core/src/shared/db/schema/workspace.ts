import {
  bigint,
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  unique,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { users } from "./identity.ts";
import { classrooms } from "./education.ts";
import type {
  DomainConfiguration,
  DomainRole,
  DomainStatus,
  StoredDomainPreset,
} from "../../workspace/types.ts";

/** 产品工作空间；固定类型决定能力，成员角色决定操作权限。 */
export const domains = pgTable("domains", {
  id: text("id").primaryKey(),
  slug: text("slug").notNull().unique(),
  name: text("name").notNull(),
  description: text("description").notNull().default(""),
  status: text("status").$type<DomainStatus>().notNull().default("active"),
  owner_id: text("owner_id").notNull().references(() => users.id),
  preset: text("preset").$type<StoredDomainPreset>().notNull(),
  configuration: jsonb("configuration").$type<DomainConfiguration>().notNull(),
  revision: integer("revision").notNull().default(0),
  next_problem_number: integer("next_problem_number").notNull().default(1001),
  created_at: text("created_at").notNull(),
  updated_at: text("updated_at").notNull(),
}, (t) => ({
  slugCheck: check(
    "domains_slug_check",
    sql`${t.slug} ~ '^[a-z][a-z0-9-]{1,30}[a-z0-9]$'`,
  ),
  statusCheck: check(
    "domains_status_check",
    sql`${t.status} IN ('active', 'archived', 'suspended')`,
  ),
  presetCheck: check(
    "domains_preset_check",
    sql`${t.preset} IN ('community', 'education', 'team', 'custom')`,
  ),
  revisionCheck: check(
    "domains_revision_check",
    sql`${t.revision} >= 0 AND ${t.next_problem_number} >= 1001`,
  ),
  configurationCheck: check(
    "domains_configuration_check",
    sql`jsonb_typeof(${t.configuration}) = 'object'`,
  ),
  ownerIdx: index("idx_domains_owner").on(t.owner_id),
}));
/** 成员身份保留，退出不删除业务历史。 */
export const domainMemberships = pgTable("domain_memberships", {
  id: text("id").primaryKey(),
  domain_id: text("domain_id").notNull().references(() => domains.id),
  user_id: text("user_id").notNull().references(() => users.id),
  status: text("status").$type<"active" | "removed">().notNull().default(
    "active",
  ),
  joined_at: text("joined_at").notNull(),
  left_at: text("left_at"),
}, (t) => ({
  identityUnique: unique("domain_memberships_identity_unique").on(
    t.domain_id,
    t.user_id,
  ),
  domainIdUnique: unique("domain_memberships_domain_id_unique").on(
    t.domain_id,
    t.id,
  ),
  statusCheck: check(
    "domain_memberships_status_check",
    sql`${t.status} IN ('active', 'removed')`,
  ),
  userStatusIdx: index("idx_domain_memberships_user_status").on(
    t.user_id,
    t.status,
  ),
}));
/** 内置成员角色；负责人只能通过交接授予。 */
export const domainMemberRoles = pgTable("domain_member_roles", {
  membership_id: text("membership_id").notNull().references(() =>
    domainMemberships.id
  ),
  role: text("role").$type<DomainRole>().notNull(),
}, (t) => ({
  pk: primaryKey({ columns: [t.membership_id, t.role] }),
  membershipUnique: unique("domain_member_roles_membership_unique").on(
    t.membership_id,
  ),
  roleCheck: check(
    "domain_member_roles_role_check",
    sql`${t.role} IN ('owner', 'coach', 'member')`,
  ),
}));
/** 数值限额：null 表示不额外限制。 */
export const domainLimits = pgTable("domain_limits", {
  domain_id: text("domain_id").primaryKey().references(() => domains.id),
  members: integer("members"),
  problems: integer("problems"),
  storage_bytes: bigint("storage_bytes", { mode: "number" }),
  submissions_per_minute: integer("submissions_per_minute"),
}, (t) => ({
  boundsCheck: check(
    "domain_limits_bounds_check",
    sql`(${t.members} IS NULL OR ${t.members} >= 0) AND (${t.problems} IS NULL OR ${t.problems} >= 0) AND (${t.storage_bytes} IS NULL OR ${t.storage_bytes} >= 0) AND (${t.submissions_per_minute} IS NULL OR ${t.submissions_per_minute} >= 0)`,
  ),
}));
/** 使用域默认 LLM 执行选择；密钥与 Provider 记录由独立 Gateway 保存。 */
export const domainLlmSettings = pgTable("domain_llm_settings", {
  domain_id: text("domain_id").primaryKey().references(() => domains.id),
  provider_id: text("provider_id"),
  model: text("model"),
  revision: integer("revision").notNull().default(1),
  updated_at: text("updated_at").notNull(),
}, (t) => ({
  revisionCheck: check(
    "domain_llm_settings_revision_check",
    sql`${t.revision} >= 1`,
  ),
  selectionCheck: check(
    "domain_llm_settings_selection_check",
    sql`(${t.provider_id} IS NULL AND ${t.model} IS NULL) OR (${t.provider_id} IS NOT NULL AND ${t.model} IS NOT NULL AND length(trim(${t.provider_id})) > 0 AND length(trim(${t.model})) > 0)`,
  ),
}));
/** 配额计数在业务事务中加锁更新。 */
export const domainResourceCounters = pgTable("domain_resource_counters", {
  domain_id: text("domain_id").notNull().references(() => domains.id),
  resource: text("resource").$type<"members" | "problems" | "storage_bytes">()
    .notNull(),
  used: bigint("used", { mode: "number" }).notNull().default(0),
  reserved: bigint("reserved", { mode: "number" }).notNull().default(0),
}, (t) => ({
  pk: primaryKey({ columns: [t.domain_id, t.resource] }),
  resourceCheck: check(
    "domain_resource_counters_resource_check",
    sql`${t.resource} IN ('members', 'problems', 'storage_bytes')`,
  ),
  countsCheck: check(
    "domain_resource_counters_counts_check",
    sql`${t.used} >= 0 AND ${t.reserved} >= 0`,
  ),
}));
/** 三种邀请仅保存凭据哈希，不修改已有账号或授予管理身份。 */
export const domainInvitations = pgTable(
  "domain_invitations",
  {
    id: text("id").primaryKey(),
    domain_id: text("domain_id").notNull().references(() => domains.id),
    classroom_id: text("classroom_id"),
    token_hash: text("token_hash").notNull().unique(),
    code_hash: text("code_hash").unique(),
    mode: text("mode").$type<"email" | "general" | "once">().notNull().default(
      "email",
    ),
    email: text("email"),
    max_uses: integer("max_uses").default(1),
    used_count: integer("used_count").notNull().default(0),
    expires_at: text("expires_at").notNull(),
    used_at: text("used_at"),
    revoked_at: text("revoked_at"),
    created_by: text("created_by").notNull().references(() => users.id),
    created_at: text("created_at").notNull(),
  },
  (t) => ({
    domainIdx: index("idx_domain_invitations_domain").on(t.domain_id),
    modeCheck: check(
      "domain_invitations_mode_check",
      sql`${t.mode} IN ('email','general','once')`,
    ),
    usesCheck: check(
      "domain_invitations_uses_check",
      sql`${t.used_count} >= 0 AND (${t.max_uses} IS NULL OR ${t.max_uses} > 0)`,
    ),
    targetCheck: check(
      "domain_invitations_target_check",
      sql`(${t.mode} = 'email' AND ${t.email} IS NOT NULL AND ${t.max_uses} = 1) OR (${t.mode} = 'once' AND ${t.email} IS NULL AND ${t.max_uses} = 1) OR (${t.mode} = 'general' AND ${t.email} IS NULL)`,
    ),
    classroomFk: foreignKey({
      name: "domain_invitations_classroom_domain_fk",
      columns: [t.domain_id, t.classroom_id],
      foreignColumns: [classrooms.domain_id, classrooms.id],
    }),
  }),
);
/** 每个账号对同一邀请只计一次成功兑换，支持失败重试和使用人数核对。 */
export const domainInvitationRedemptions = pgTable(
  "domain_invitation_redemptions",
  {
    invitation_id: text("invitation_id").notNull().references(() =>
      domainInvitations.id
    ),
    user_id: text("user_id").notNull().references(() => users.id),
    redeemed_at: text("redeemed_at").notNull(),
  },
  (t) => ({ pk: primaryKey({ columns: [t.invitation_id, t.user_id] }) }),
);
/** 工作空间加入申请。 */
export const domainJoinRequests = pgTable("domain_join_requests", {
  id: text("id").primaryKey(),
  domain_id: text("domain_id").notNull().references(() => domains.id),
  user_id: text("user_id").notNull().references(() => users.id),
  reason: text("reason").notNull().default(""),
  status: text("status").$type<"pending" | "approved" | "rejected">().notNull()
    .default("pending"),
  reviewed_by: text("reviewed_by").references(() => users.id),
  reviewed_at: text("reviewed_at"),
  created_at: text("created_at").notNull(),
}, (t) => ({
  statusCheck: check(
    "domain_join_requests_status_check",
    sql`${t.status} IN ('pending', 'approved', 'rejected')`,
  ),
  domainStatusIdx: index("idx_domain_join_requests_domain_status").on(
    t.domain_id,
    t.status,
  ),
}));
/** 创建申请批准与实际域创建同事务。 */
export const domainCreationRequests = pgTable("domain_creation_requests", {
  id: text("id").primaryKey(),
  applicant_id: text("applicant_id").notNull().references(() => users.id),
  slug: text("slug").notNull(),
  name: text("name").notNull(),
  preset: text("preset").$type<StoredDomainPreset>().notNull(),
  reason: text("reason").notNull(),
  status: text("status").$type<"pending" | "approved" | "rejected">().notNull()
    .default("pending"),
  domain_id: text("domain_id").references(() => domains.id),
  reviewed_by: text("reviewed_by").references(() => users.id),
  reviewed_at: text("reviewed_at"),
  created_at: text("created_at").notNull(),
}, (t) => ({
  statusCheck: check(
    "domain_creation_requests_status_check",
    sql`${t.status} IN ('pending', 'approved', 'rejected')`,
  ),
  statusIdx: index("idx_domain_creation_requests_status").on(t.status),
}));
/** 导航偏好不授予访问权。 */
export const userWorkspacePreferences = pgTable("user_workspace_preferences", {
  user_id: text("user_id").primaryKey().references(() => users.id),
  last_domain_id: text("last_domain_id").references(() => domains.id),
  updated_at: text("updated_at").notNull(),
});
/** 教学功能停用区间，不因重新启用而补计停用期间的提交。 */
export const domainFeatureIntervals = pgTable(
  "domain_feature_intervals",
  {
    id: text("id").primaryKey(),
    domain_id: text("domain_id").notNull().references(() => domains.id),
    feature: text("feature").notNull(),
    disabled_at: text("disabled_at").notNull(),
    enabled_at: text("enabled_at"),
  },
  (t) => ({
    domainIdx: index("idx_domain_feature_intervals_domain").on(
      t.domain_id,
      t.feature,
    ),
  }),
);
