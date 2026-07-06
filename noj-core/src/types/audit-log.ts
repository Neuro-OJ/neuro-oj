/**
 * 审计日志类型定义（issue #101）。
 *
 * `AuditAction` 限定 7 类合法操作，CHECK 约束保证 DB 层一致；
 * `AuditDetail` 用 discriminated union 保证 detail 字段的类型安全。
 */

/** 审计 action 枚举（与 DB CHECK 约束一致） */
export type AuditAction =
  | "users.role_change"
  | "users.ban"
  | "users.unban"
  | "problems.delete"
  | "categories.delete"
  | "submissions.rejudge"
  | "settings.update"
  | "ip_ban.create"
  | "ip_ban.delete";

/** 按 action 强类型的 detail（discriminated union） */
export type AuditDetail =
  | { action: "users.role_change"; from: string; to: string }
  | { action: "users.ban"; reason: string; until: string | null }
  | { action: "users.unban" }
  | { action: "problems.delete"; title: string; display_id: string }
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
  | { action: "settings.update"; key: string; from: unknown; to: unknown }
  | {
    action: "ip_ban.create";
    ip_or_cidr: string;
    reason: string;
    expires_at: string | null;
  }
  | { action: "ip_ban.delete"; ip_or_cidr: string };

/** audit_logs 表的响应类型 */
export interface AuditLogEntry {
  id: string;
  admin_id: string;
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
