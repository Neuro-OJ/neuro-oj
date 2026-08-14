-- 题目标签系统（issue #223）：category 系统退役，双类标签（problem/algorithm）取代。
-- 存量分类数据不迁移：DROP 后由 seed 重打样例题标签。

-- 1. 移除分类表（先删关联表，再删主表）
DROP TABLE IF EXISTS "problems_categories";
DROP TABLE IF EXISTS "categories";

-- 2. 新建标签表与题目-标签关联表
CREATE TABLE IF NOT EXISTS "tags" (
  "id" text PRIMARY KEY NOT NULL,
  "name" text NOT NULL,
  "kind" text NOT NULL,
  "created_at" text NOT NULL,
  "updated_at" text NOT NULL,
  CONSTRAINT "tags_name_unique" UNIQUE("name"),
  CONSTRAINT "tags_kind_check" CHECK ("kind" IN ('problem', 'algorithm'))
);

CREATE TABLE IF NOT EXISTS "problem_tags" (
  "problem_id" text NOT NULL,
  "tag_id" text NOT NULL,
  CONSTRAINT "problem_tags_problem_id_tag_id_pk" PRIMARY KEY("problem_id","tag_id"),
  CONSTRAINT "problem_tags_problem_id_problems_id_fk" FOREIGN KEY ("problem_id") REFERENCES "problems"("id") ON DELETE cascade ON UPDATE no action,
  CONSTRAINT "problem_tags_tag_id_tags_id_fk" FOREIGN KEY ("tag_id") REFERENCES "tags"("id") ON DELETE cascade ON UPDATE no action
);

-- 3. 审计 action CHECK：categories.delete → tags.create/update/delete/merge（其余保持不变）
ALTER TABLE "audit_logs" DROP CONSTRAINT IF EXISTS "audit_logs_action_check";
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_action_check" CHECK ("action" IN (
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
  'community.preset_applied',
  'announcement.create',
  'announcement.update',
  'announcement.delete'
));

-- 4. 清理 category 资源域权限（由 seed-rbac 以 tag:read/tag:manage 替换）
DELETE FROM "role_permissions" WHERE "permission_id" IN (
  SELECT "id" FROM "permissions" WHERE "resource" = 'category'
);
DELETE FROM "permissions" WHERE "resource" = 'category';
