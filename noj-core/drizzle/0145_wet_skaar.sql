-- #726：教学事件统一到 background_tasks，删除 education_outbox。
-- 1. 通知投递幂等键改为任务 payload 中的 event_id，不再外键引用 outbox。
ALTER TABLE "notifications" DROP CONSTRAINT "notifications_event_id_education_outbox_id_fk";--> statement-breakpoint
-- 2. 未处理的旧事件若还没有对应任务（早期 rc 数据），补登记任务。
INSERT INTO "background_tasks" ("id", "task_type", "target_kind", "target_id", "dedupe_key", "payload_version", "payload", "status", "available_at", "created_at", "updated_at")
SELECT gen_random_uuid()::text, 'education.recompute',
  CASE WHEN o."assignment_id" IS NULL THEN 'domain' ELSE 'assignment' END,
  COALESCE(o."assignment_id", o."domain_id"), 'outbox:' || o."id", 1,
  jsonb_build_object('outbox_id', o."id"), 'pending', o."available_at",
  o."created_at", o."created_at"
FROM "education_outbox" o
WHERE o."processed_at" IS NULL
ON CONFLICT ("task_type", "target_kind", "target_id", "dedupe_key") DO NOTHING;--> statement-breakpoint
-- 3. 未完成任务的 payload 改为自包含的 v2 结构（携带事实定位、游标与 event_id）。
UPDATE "background_tasks" t SET
  "payload" = jsonb_build_object(
    'event_id', o."id",
    'domain_id', o."domain_id",
    'event_type', o."event_type",
    'user_id', o."user_id",
    'problem_id', o."problem_id",
    'classroom_id', o."classroom_id",
    'assignment_id', o."assignment_id",
    'data', o."payload"
  ),
  "payload_version" = 2,
  "available_at" = o."available_at"
FROM "education_outbox" o
WHERE t."task_type" = 'education.recompute'
  AND t."payload_version" = 1
  AND t."payload"->>'outbox_id' = o."id"
  AND o."processed_at" IS NULL
  AND t."status" IN ('pending', 'leased', 'failed');--> statement-breakpoint
-- 4. 其余 v1 任务对应的 outbox 已处理完：直接收尾，避免新 handler 拒绝旧 payload。
UPDATE "background_tasks" SET
  "status" = 'succeeded',
  "lease_token" = NULL,
  "lease_owner" = NULL,
  "lease_expiry" = NULL,
  "last_result" = '{"skipped":"already_processed"}'::jsonb,
  "last_error" = NULL,
  "finished_at" = to_char(clock_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
  "updated_at" = to_char(clock_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
WHERE "task_type" = 'education.recompute'
  AND "payload_version" = 1
  AND "status" IN ('pending', 'leased', 'failed');--> statement-breakpoint
ALTER TABLE "education_outbox" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP TABLE "education_outbox" CASCADE;
