-- PR-2：audit_logs.admin_id 改为可空
-- 原因：新增 auth.* 审计动作可能没有 actor（登录失败、未注册邮箱的密码重置请求等）
-- 兼容：现有数据保留为非空，CHECK 约束不再强制 NOT NULL
ALTER TABLE "audit_logs" ALTER COLUMN "admin_id" DROP NOT NULL;