import {
  boolean,
  check,
  index,
  integer,
  pgTable,
  primaryKey,
  text,
  unique,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { tsvector } from "./common.ts";

export const users = pgTable(
  "users",
  {
    id: text("id").primaryKey(),
    username: text("username").notNull().unique(),
    email: text("email").notNull().unique(),
    /** 本地密码 bcrypt 哈希；OAuth 新用户在补设密码前为 NULL */
    password_hash: text("password_hash"),
    /** 个人简介（Markdown 格式） */
    bio: text("bio").notNull().default(""),
    /**
     * 是否必须在下一次登录后修改密码（issue #75）。
     * - 引导管理员 / ADMIN_EMAIL+ADMIN_PASS 创建的初始账号设为 true
     * - 历史用户保持 false，向前兼容
     * - authMiddleware 在 token 携带 true 且请求不在白名单内时返回 403
     */
    must_change_password: boolean("must_change_password").notNull().default(
      false,
    ),
    /** 社区系统活动可见范围：hidden / following / everyone */
    community_activity_visibility: text("community_activity_visibility")
      .notNull().default("following"),
    /** 用户头像存储 URL（`noj-storage://` 格式），NULL = 未设置 */
    avatar_url: text("avatar_url"),
    /** TOTP secret 加密后的密文（AES-256-GCM），NULL = 未设置 */
    tfa_secret_encrypted: text("tfa_secret_encrypted"),
    /** 是否已启用 TFA 二次验证 */
    tfa_enabled: boolean("tfa_enabled").notNull().default(false),
    created_at: text("created_at").notNull(),
    updated_at: text("updated_at").notNull(),
    /** tsvector 列，GENERATED 自动维护 */
    searchVector: tsvector("search_vector"),
  },
  (table) => ({
    searchVectorIdx: index("idx_users_search_vector").using(
      "gin",
      table.searchVector,
    ),
    communityActivityVisibilityCheck: check(
      "users_community_activity_visibility_check",
      sql`${table.community_activity_visibility} IN ('hidden', 'following', 'everyone')`,
    ),
  }),
);

export const oauthAccounts = pgTable(
  "oauth_accounts",
  {
    id: text("id").primaryKey(),
    provider: text("provider").notNull(),
    provider_user_id: text("provider_user_id").notNull(),
    user_id: text("user_id").notNull().references(() => users.id, {
      onDelete: "cascade",
    }),
    provider_username: text("provider_username"),
    provider_email: text("provider_email"),
    email_verified: boolean("email_verified").notNull().default(false),
    created_at: text("created_at").notNull(),
    updated_at: text("updated_at").notNull(),
  },
  (table) => ({
    providerIdentityUnique: unique("oauth_accounts_provider_identity_unique")
      .on(table.provider, table.provider_user_id),
    userIdx: index("idx_oauth_accounts_user_id").on(table.user_id),
  }),
);

export const checkIns = pgTable(
  "check_ins",
  {
    id: text("id").primaryKey(),
    user_id: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    checkin_date: text("checkin_date").notNull(),
    streak: integer("streak").notNull().default(1),
    created_at: text("created_at").notNull(),
  },
  (table) => ({
    userDateUnique: unique("check_ins_user_date_unique").on(
      table.user_id,
      table.checkin_date,
    ),
  }),
);

export const passwordResetTokens = pgTable(
  "password_reset_tokens",
  {
    id: text("id").primaryKey(),
    user_id: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    /** 令牌 SHA-256 hex 哈希（不存明文明文 token） */
    token_hash: text("token_hash").notNull().unique(),
    /** ISO 8601，过期时间，now + 15 分钟 */
    expires_at: text("expires_at").notNull(),
    /** ISO 8601，使用时间。NULL = 未使用 */
    used_at: text("used_at"),
    created_at: text("created_at").notNull(),
  },
  (table) => ({
    user_idx: index("idx_password_reset_tokens_user_id").on(table.user_id),
    expires_idx: index("idx_password_reset_tokens_expires_at").on(
      table.expires_at,
    ),
  }),
);

export const tfaRecoveryCodes = pgTable(
  "tfa_recovery_codes",
  {
    id: text("id").primaryKey(),
    user_id: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    /** 恢复码 SHA-256 hex 哈希 */
    code_hash: text("code_hash").notNull(),
    /** ISO 8601，使用时间。NULL = 未使用 */
    used_at: text("used_at"),
    created_at: text("created_at").notNull(),
  },
  (table) => ({
    user_idx: index("idx_tfa_recovery_codes_user_id").on(table.user_id),
  }),
);

export const userBans = pgTable(
  "user_bans",
  {
    id: text("id").primaryKey(),
    user_id: text("user_id").notNull().references(() => users.id, {
      onDelete: "cascade",
    }),
    reason: text("reason").notNull().default(""),
    /** 封禁范围：platform=限制使用平台（登录/评测/一切写操作）；social=仅限制社区发布 */
    scope: text("scope").notNull().default("platform"),
    /** ISO 8601；NULL = 永久封禁 */
    banned_until: text("banned_until"),
    banned_at: text("banned_at").notNull(),
    banned_by: text("banned_by").references(() => users.id, {
      onDelete: "set null",
    }),
    /** 解封时间；NULL = 当前活跃封禁 */
    unbanned_at: text("unbanned_at"),
    unbanned_by: text("unbanned_by").references(() => users.id, {
      onDelete: "set null",
    }),
  },
  (table) => ({
    scopeCheck: check(
      "user_bans_scope_check",
      sql`${table.scope} IN ('platform', 'social')`,
    ),
    userIdx: index("idx_user_bans_user").on(table.user_id),
    activeIdx: index("idx_user_bans_active").on(table.user_id).where(
      sql`unbanned_at IS NULL`,
    ),
  }),
);

export const roles = pgTable(
  "roles",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull().unique(),
    description: text("description").notNull().default(""),
    is_system: boolean("is_system").notNull().default(false),
    is_default: boolean("is_default").notNull().default(false),
    // deno-lint-ignore no-explicit-any
    parent_id: text("parent_id").references((): any => roles.id, {
      onDelete: "set null",
    }),
    created_at: text("created_at").notNull(),
    updated_at: text("updated_at").notNull(),
  },
  (table) => ({
    parentIdx: index("idx_roles_parent_id").on(table.parent_id),
  }),
);

export const permissions = pgTable(
  "permissions",
  {
    id: text("id").primaryKey(),
    resource: text("resource").notNull(),
    action: text("action").notNull(),
    description: text("description").notNull().default(""),
  },
  (table) => ({
    resourceActionUnique: unique("permissions_resource_action_unique").on(
      table.resource,
      table.action,
    ),
  }),
);

export const rolePermissions = pgTable(
  "role_permissions",
  {
    role_id: text("role_id")
      .notNull()
      .references(() => roles.id, { onDelete: "cascade" }),
    permission_id: text("permission_id")
      .notNull()
      .references(() => permissions.id, { onDelete: "cascade" }),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.role_id, table.permission_id] }),
  }),
);

export const userRoles = pgTable(
  "user_roles",
  {
    user_id: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    role_id: text("role_id")
      .notNull()
      .references(() => roles.id, { onDelete: "cascade" }),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.user_id, table.role_id] }),
  }),
);
