/**
 * 审计日志类型定义（issue #101）。
 */

import type { WorkspaceAuditAction } from "../../../shared/workspace/audit.ts";

export type AuditAction =
  | WorkspaceAuditAction
  | "users.role_change"
  | "users.ban"
  | "users.unban"
  | "users.delete"
  | "roles.create"
  | "roles.update"
  | "roles.delete"
  | "problems.delete"
  | "problems.runtime_config_changed"
  | "problems.imported"
  | "problems.review"
  | "problems.version_published"
  | "problems.effective_version_policy_changed"
  | "contest.problem_version_changed"
  | "contest.problem_effective_version_policy_changed"
  | "trainings.update"
  | "trainings.delete"
  | "tags.create"
  | "tags.update"
  | "tags.delete"
  | "tags.merge"
  | "submissions.rejudge"
  | "submissions.queue_removed"
  | "submissions.delete"
  | "settings.update"
  | "ip_ban.create"
  | "ip_ban.delete"
  | "auth.login_success"
  | "auth.login_failure"
  | "auth.register"
  | "auth.email_verified"
  | "auth.delete_account"
  | "auth.change_password"
  | "auth.forgot_password_request"
  | "auth.password_reset"
  | "auth.tfa_setup"
  | "auth.tfa_enabled"
  | "auth.tfa_disabled"
  | "auth.tfa_recovery_regenerated"
  | "auth.tfa_recovery_used"
  | "community.post_moderated"
  | "community.report_resolved"
  | "community.sanction_created"
  | "community.sanction_revoked"
  | "community.preset_applied"
  | "community.board_create"
  | "community.board_update"
  | "community.board_role_grant_update"
  | "community.board_role_grant_delete"
  | "community.post_flag"
  | "announcement.create"
  | "announcement.update"
  | "announcement.delete"
  | "carousel.create"
  | "carousel.update"
  | "carousel.delete"
  | "carousel.reorder"
  | "review.queued"
  | "review.rejected"
  | "review.resolved"
  | "contest.ranking_snapshot"
  | "contest.create"
  | "contest.update"
  | "contest.delete"
  | "contest.participants_add"
  | "contest.participants_remove"
  | "contest.kind_change"
  | "contest.reset_code"
  | "judge_images.create"
  | "judge_images.update"
  | "judge_images.delete"
  | "email_delivery.clear_suppression"
  | "llm_provider.create"
  | "llm_provider.update"
  | "llm_quota.upsert"
  | "llm_model_alias.upsert"
  | "llm_model_alias.delete"
  | "legal.publish_version"
  | "legal.data_request_update"
  | "background_task.retry";

export type AuditDetail = {
  action: AuditAction;
  [key: string]: unknown;
};

export interface AuditLogEntry {
  id: string;
  admin_id: string | null;
  action: AuditAction;
  target_type: string | null;
  target_id: string | null;
  detail: AuditDetail;
  ip_address: string;
  created_at: string;
}

export interface AuditLogListFilter {
  page: number;
  perPage: number;
  admin_id?: string;
  action?: AuditAction;
  from?: string;
  to?: string;
}
