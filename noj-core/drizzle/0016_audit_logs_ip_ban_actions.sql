-- 扩展审计日志 action CHECK 约束（issue #101），新增 ip_ban.create 和 ip_ban.delete
-- 后续：双容器 RuntimeConfig 改动审计（openspec/changes/dual-container-judge §8）
ALTER TABLE "audit_logs" DROP CONSTRAINT IF EXISTS "audit_logs_action_check";
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_action_check" CHECK ("action" IN (
  'users.role_change',
  'users.ban',
  'users.unban',
  'problems.delete',
  'problems.runtime_config_changed',
  'categories.delete',
  'submissions.rejudge',
  'settings.update',
  'ip_ban.create',
  'ip_ban.delete'
));
