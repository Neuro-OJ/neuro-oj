-- 审计日志表（issue #101）
CREATE TABLE "audit_logs" (
  "id" TEXT PRIMARY KEY,
  "admin_id" TEXT NOT NULL,
  "action" TEXT NOT NULL,
  "target_type" TEXT,
  "target_id" TEXT,
  "detail" JSONB NOT NULL DEFAULT '{}',
  "ip_address" TEXT NOT NULL,
  "created_at" TEXT NOT NULL,
  CONSTRAINT "audit_logs_admin_id_fk" FOREIGN KEY ("admin_id") REFERENCES "users"("id"),
  CONSTRAINT "audit_logs_action_check" CHECK ("action" IN (
    'users.role_change',
    'users.ban',
    'users.unban',
    'problems.delete',
    'categories.delete',
    'submissions.rejudge',
    'settings.update'
  ))
);

CREATE INDEX "audit_logs_admin_id_idx" ON "audit_logs" ("admin_id");
CREATE INDEX "audit_logs_created_at_idx" ON "audit_logs" ("created_at");
CREATE INDEX "audit_logs_action_idx" ON "audit_logs" ("action");

