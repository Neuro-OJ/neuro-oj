/**
 * 审计日志类型定义（issue #101）。
 *
 * `AuditAction` 限定 7 类合法操作，CHECK 约束保证 DB 层一致；
 * `AuditDetail` 用 discriminated union 保证 detail 字段的类型安全。
 */

/** 审计 action 枚举（与 DB CHECK 约束一致，PR-2 新增 auth.*） */
export type AuditAction =
  | "users.role_change"
  | "users.ban"
  | "users.unban"
  | "problems.delete"
  | "problems.runtime_config_changed"
  | "categories.delete"
  | "submissions.rejudge"
  | "settings.update"
  | "ip_ban.create"
  | "ip_ban.delete"
  | "auth.login_success"
  | "auth.login_failure"
  | "auth.register"
  | "auth.change_password"
  | "auth.forgot_password_request"
  | "auth.password_reset";

/** 按 action 强类型的 detail（discriminated union） */
export type AuditDetail =
  | { action: "users.role_change"; from: string; to: string }
  | { action: "users.ban"; reason: string; until: string | null }
  | { action: "users.unban" }
  | { action: "problems.delete"; title: string; display_id: string }
  | {
    action: "problems.runtime_config_changed";
    title: string;
    display_id: string;
    old_has_runtime_config: boolean;
    new_has_runtime_config: boolean;
  }
  | {
    action: "categories.delete";
    name: string;
    slug: string;
  }
  | {
    action: "submissions.rejudge";
    submission_id?: string;
    problem_id?: string;
    count?: number;
  }
  | {
    action: "settings.update";
    operation: "PUT" | "DELETE";
    key: string;
    from: unknown;
    to: unknown;
  }
  | {
    action: "ip_ban.create";
    ip_or_cidr: string;
    reason: string;
    expires_at: string | null;
  }
  | { action: "ip_ban.delete"; ip_or_cidr: string }
  // ── PR-2 新增 auth.*（注意：登录失败/注册/忘记密码时 actor 不存在，admin_id 为 null） ──
  | {
    action: "auth.login_success";
    user_id: string;
    /** 登录标识（用户名或邮箱），便于追溯账号而非仅 UUID */
    login: string;
  }
  | {
    action: "auth.login_failure";
    /** 失败原因分类（wrong_password / user_not_found / user_banned / ip_banned） */
    reason: "wrong_password" | "user_not_found" | "user_banned" | "ip_banned";
    /** 攻击者输入的登录标识（**不区分大小写**），用于撞库追溯 */
    login: string;
  }
  | {
    action: "auth.register";
    user_id: string;
    username: string;
    email: string;
  }
  | { action: "auth.change_password"; user_id: string }
  | {
    action: "auth.forgot_password_request";
    /** 是否真发了邮件（邮箱存在 → true；防枚举场景下 false） */
    email_exists: boolean;
  }
  | { action: "auth.password_reset"; user_id: string };

/** audit_logs 表的响应类型 */
export interface AuditLogEntry {
  id: string;
  /** PR-2：admin_id 可空——auth.* 事件可能没有 actor */
  admin_id: string | null;
  action: AuditAction;
  target_type: string | null;
  target_id: string | null;
  detail: AuditDetail;
  ip_address: string;
  created_at: string;
}

/** 列表 API 查询参数 */
export interface AuditLogListFilter {
  page: number;
  perPage: number;
  admin_id?: string;
  action?: AuditAction;
  from?: string;
  to?: string;
}
