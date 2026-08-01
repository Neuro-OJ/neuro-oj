ALTER TABLE "audit_logs" DROP CONSTRAINT "audit_logs_action_check";--> statement-breakpoint
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_action_check" CHECK ("audit_logs"."action" IN (
        'users.role_change',
        'users.ban',
        'users.unban',
        'problems.delete',
        'problems.runtime_config_changed',
        'categories.delete',
        'submissions.rejudge',
        'settings.update',
        'ip_ban.create',
        'ip_ban.delete',
        'auth.login_success',
        'auth.login_failure',
        'auth.register',
        'auth.change_password',
        'auth.forgot_password_request',
        'auth.password_reset',
        'community.post_moderated',
        'community.report_resolved',
        'community.sanction_created',
        'community.sanction_revoked',
        'community.preset_applied'
      ));