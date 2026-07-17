-- 扩展审计日志 action CHECK 约束（PR-2 死开关 + auth 审计动作）
-- 新增 auth.* 动作覆盖登录/注册/改密/重置密码/忘记密码 等关键路径
ALTER TABLE "audit_logs" DROP CONSTRAINT IF EXISTS "audit_logs_action_check";
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_action_check" CHECK ("action" IN (
  'users.role_change',
  'users.ban',
  'users.unban',
  'problems.delete',
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
  'auth.password_reset'
));