/**
 * 使用域邀请与兑换记录。
 *
 * 这些表依赖 classrooms（education 表），因此从 `workspace.ts` 拆出：
 * `workspace.ts` 只保留域、成员、角色、限额与计数器等基础表，避免
 * workspace → education 的运行时导入环。邀请的兑换计数与使用时间继续由
 * access 的所有权流程在真实事务内更新。
 */
import {
  check,
  foreignKey,
  index,
  integer,
  pgTable,
  primaryKey,
  text,
  unique,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { users } from "./identity.ts";
import { classrooms } from "./education.ts";
import { domains } from "./workspace.ts";

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
