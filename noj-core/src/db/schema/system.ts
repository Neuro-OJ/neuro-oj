import {
  boolean,
  check,
  index,
  jsonb,
  pgTable,
  text,
  unique,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { users } from "./identity.ts";

/**
 * 评测镜像白名单表。
 * 管理员通过此表配置允许使用的 Docker 评测镜像。
 * mode='exact' 时仅精确匹配指定镜像名；
 * mode='all_versions' 时匹配该镜像名（不含标签部分）的所有版本。
 */
export const judgeImages = pgTable(
  "judge_images",
  {
    id: text("id").primaryKey(),
    image: text("image").notNull(),
    mode: text("mode").notNull().default("exact"),
    /**
     * 镜像用途分类（dual-container-judge §5）。
     * - 'evaluator'：单容器 / 双容器 Evaluator 角色
     * - 'solution' ：双容器 Solution 角色
     *
     * 历史数据迁移时默认 'evaluator'。
     */
    kind: text("kind").notNull().default("evaluator"),
    /** 管理员配置的介绍，在题目编辑器下拉中展示 */
    description: text("description").notNull().default(""),
    created_at: text("created_at").notNull(),
    updated_at: text("updated_at").notNull(),
  },
  (table) => ({
    modeCheck: check(
      "judge_images_mode_check",
      sql`${table.mode} IN ('exact', 'all_versions')`,
    ),
    kindCheck: check(
      "judge_images_kind_check",
      sql`${table.kind} IN ('evaluator', 'solution')`,
    ),
  }),
);

/**
 * 系统设置 KV 表（issue #99）。
 * 管理员运行时可变配置持久化层。
 *
 * - 运行时读取优先级：DB value > envFallback > SETTING_DEFINITIONS.default
 * - 写入由 services/system-settings.ts 做严格 type 校验 + 敏感字段掩码
 * - 审计日志走 console.log("[admin] ...")，issue #101 落库后迁移
 */
/**
 * 系统设置 KV 表（issue #99）。
 * 管理员运行时可变配置持久化层。
 *
 * - 运行时读取优先级：DB value > envFallback > SETTING_DEFINITIONS.default
 * - 写入由 services/system-settings.ts 做严格 type 校验 + 敏感字段掩码
 * - 审计日志走 console.log("[admin] ...")，issue #101 落库后迁移
 */
export const systemSettings = pgTable(
  "system_settings",
  {
    key: text("key").primaryKey(),
    /** JSON 编码字符串（boolean/string/text 三种类型共存） */
    value: text("value").notNull(),
    description: text("description").notNull().default(""),
    is_secret: boolean("is_secret").notNull().default(false),
    updated_at: text("updated_at").notNull(),
    updated_by: text("updated_by").references(() => users.id, {
      onDelete: "set null",
    }),
  },
  (table) => ({
    updatedAtIdx: index("idx_system_settings_updated_at").on(
      table.updated_at,
    ),
  }),
);

/**
 * 公告表（issue #231）。
 * 站内广播（维护通知、活动预告等），由运营者（admin）管理。
 * - 公开列表仅返回 is_active=true，排序 is_pinned DESC, created_at DESC
 * - 下架 = is_active 置 false（不物理删除，保留历史）
 * - content 为 Markdown 文本
 */
/**
 * 公告表（issue #231）。
 * 站内广播（维护通知、活动预告等），由运营者（admin）管理。
 * - 公开列表仅返回 is_active=true，排序 is_pinned DESC, created_at DESC
 * - 下架 = is_active 置 false（不物理删除，保留历史）
 * - content 为 Markdown 文本
 */
export const announcements = pgTable(
  "announcements",
  {
    id: text("id").primaryKey(),
    public_id: text("public_id").notNull().default(
      sql`'ann-' || substr(md5(random()::text), 1, 8)`,
    ),
    /** 标题，1–100 字符 */
    title: text("title").notNull(),
    /** Markdown 正文，1–50000 字符 */
    content: text("content").notNull(),
    /** 是否置顶（公开列表优先展示） */
    is_pinned: boolean("is_pinned").notNull().default(false),
    /** 是否发布中（false = 已下架，公开列表不可见） */
    is_active: boolean("is_active").notNull().default(true),
    /** 创建者用户 id */
    created_by: text("created_by").notNull().references(() => users.id),
    /** ISO 8601，创建时间 */
    created_at: text("created_at").notNull(),
    /** ISO 8601，最后更新时间 */
    updated_at: text("updated_at").notNull(),
  },
  (table) => ({
    publicIdUnique: unique("announcements_public_id_unique").on(
      table.public_id,
    ),
    /** 公开列表查询：仅 active + 置顶优先 + 最新在前 */
    activePinnedCreatedIdx: index("idx_announcements_active_pinned_created").on(
      table.is_active,
      table.is_pinned,
      table.created_at,
    ),
  }),
);

/**
 * 审计日志表（issue #101）。
 * 记录所有管理员操作的详细信息：admin_id、action、target、detail、ip、time。
 * service 层通过 logAudit() 同步写入；后台任务定期清理过期记录。
 */
export const auditLogs = pgTable(
  "audit_logs",
  {
    id: text("id").primaryKey(),
    // PR-2：admin_id 可空——auth.* 事件可能没有 actor（登录失败、撞邮箱等）
    admin_id: text("admin_id").references(() => users.id),
    action: text("action").notNull(),
    target_type: text("target_type"),
    target_id: text("target_id"),
    detail: jsonb("detail").notNull().default({}),
    ip_address: text("ip_address").notNull(),
    created_at: text("created_at").notNull(),
  },
  (table) => ({
    actionCheck: check(
      "audit_logs_action_check",
      sql`${table.action} IN (
        'users.role_change',
        'users.ban',
        'users.unban',
        'problems.delete',
        'problems.runtime_config_changed',
        'problems.imported',
        'tags.create',
        'tags.update',
        'tags.delete',
        'tags.merge',
        'submissions.rejudge',
        'submissions.queue_removed',
        'settings.update',
        'ip_ban.create',
        'ip_ban.delete',
        'auth.login_success',
        'auth.login_failure',
        'auth.register',
        'auth.change_password',
        'auth.forgot_password_request',
        'auth.password_reset',
        'auth.tfa_setup',
        'auth.tfa_enabled',
        'auth.tfa_disabled',
        'auth.tfa_recovery_regenerated',
        'auth.tfa_recovery_used',
        'community.post_moderated',
        'community.report_resolved',
        'community.sanction_created',
        'community.sanction_revoked',
        'community.preset_applied',
        'announcement.create',
        'announcement.update',
        'announcement.delete'
      )`,
    ),
    adminIdx: index("audit_logs_admin_id_idx").on(table.admin_id),
    createdAtIdx: index("audit_logs_created_at_idx").on(table.created_at),
    actionIdx: index("audit_logs_action_idx").on(table.action),
  }),
);

/**
 * IP 黑名单表（issue #102）。
 * 存储被封禁的 IPv4 裸 IP（如 1.2.3.4）或 CIDR 范围（如 10.0.0.0/8）。
 * 命中后中间件返 403 IP_BLACKLISTED。
 * expires_at 为 ISO 8601 字符串；NULL = 永久。
 */
export const ipBans = pgTable(
  "ip_bans",
  {
    id: text("id").primaryKey(),
    ip_or_cidr: text("ip_or_cidr").notNull(),
    reason: text("reason").notNull().default(""),
    expires_at: text("expires_at"),
    created_at: text("created_at").notNull(),
    created_by: text("created_by").references(() => users.id, {
      onDelete: "set null",
    }),
  },
  (table) => ({
    ipCidrIdx: index("idx_ip_bans_ip_or_cidr").on(table.ip_or_cidr),
    expiresIdx: index("idx_ip_bans_expires_at").on(table.expires_at),
  }),
);
