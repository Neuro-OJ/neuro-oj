-- ============================================================================
-- 存量回填（Handbook §8.1 第 2–6 步）：由本迁移在**有存量数据的库**上执行。
--
-- 原则：
-- 1. 为每道现有题目生成 migration_baseline V1（内容取自题目最新版投影与客观题小题），
--    并设置 latest_version_id；
-- 2. 为现有竞赛固定其题目基线版本；
-- 3. 存量提交保持 `submitted_version_id = NULL` + `legacy_unknown`；
-- 4. 既有 `evaluation_results` 转为 `legacy_import` 尝试 + 未知版本桶当前判定；
-- 5. 按当前（默认 any）策略计算初始有效属性，**保持原有历史成绩**；
-- 6. 迁移基线**不是**历史提交的真实提交时版本——只有后续明确在 V1 执行的评测
--    才会产生已知 V1 成绩。
-- ============================================================================

-- A) 题目基线 V1（确定性 id，可重复执行不会重复插入）
INSERT INTO "problem_versions" (
  "id", "problem_id", "version", "schema_version", "origin", "content",
  "content_sha256", "change_note", "published_by", "published_at"
)
SELECT
  md5('noj-baseline-v1:' || p."id"),
  p."id",
  1,
  1,
  'migration_baseline',
  CASE
    WHEN p."is_objective" THEN jsonb_build_object(
      'kind', 'objective',
      'title', p."title",
      'description', p."description",
      'samples', COALESCE(p."samples", '[]'::jsonb),
      'questions', COALESCE((
        SELECT jsonb_agg(jsonb_build_object(
          'key', q."id",
          'sort_order', q."sort_order",
          'type', q."type",
          'prompt', q."prompt",
          'options', q."options",
          'answer', q."answer",
          'explanation', q."explanation"
        ) ORDER BY q."sort_order")
        FROM "objective_questions" q WHERE q."paper_id" = p."id"
      ), '[]'::jsonb)
    )
    WHEN p."judge_type" = 'oi' THEN jsonb_build_object(
      'kind', 'oi',
      'title', p."title",
      'description', p."description",
      'samples', COALESCE(p."samples", '[]'::jsonb),
      'runtime_config', COALESCE(p."runtime_config", jsonb_build_object(
        'backend', 'native', 'languages', jsonb_build_array('c', 'cc'),
        'time_limit_ms', 1000, 'memory_limit_mb', 256,
        'checker', jsonb_build_object('type', 'default'),
        'subtasks', '[]'::jsonb))
    )
    ELSE jsonb_build_object(
      'kind', 'ai',
      'title', p."title",
      'description', p."description",
      'samples', COALESCE(p."samples", '[]'::jsonb),
      'submission_mode', COALESCE(p."submission_mode", 'code'),
      'runtime_config', COALESCE(p."runtime_config", '{}'::jsonb),
      'template_content', COALESCE(p."template_content", ''),
      'artifact_max_size_mb', p."artifact_max_size_mb",
      'llm_config', p."llm_config"
    )
  END,
  NULL::text,
  '迁移基线：由存量题目投影生成（非历史提交的真实提交时版本）',
  NULL::text,
  to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
FROM "problems" p
WHERE NOT EXISTS (
  SELECT 1 FROM "problem_versions" v
  WHERE v."problem_id" = p."id" AND v."origin" = 'migration_baseline'
);--> statement-breakpoint

-- B) 最新版指针（仅未发布的题目）
UPDATE "problems" p
SET "latest_version_id" = v."id"
FROM "problem_versions" v
WHERE v."problem_id" = p."id"
  AND v."origin" = 'migration_baseline'
  AND p."latest_version_id" IS NULL;--> statement-breakpoint

-- C) 竞赛固定作答版本（未固定的关联）
UPDATE "contest_problems" cp
SET "pinned_version_id" = v."id"
FROM "problem_versions" v
WHERE v."problem_id" = cp."problem_id"
  AND v."origin" = 'migration_baseline'
  AND cp."pinned_version_id" IS NULL;--> statement-breakpoint

-- D) 基线文件引用：支持包（固定逻辑路径 package.zip）与 OI 逐文件
INSERT INTO "storage_objects" ("storage_url", "sha256", "byte_size", "state", "created_at")
SELECT DISTINCT p."support_package_storage_url", NULL::text, NULL::bigint, 'unknown'::text,
  to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
FROM "problems" p
WHERE p."support_package_storage_url" IS NOT NULL
ON CONFLICT ("storage_url") DO NOTHING;--> statement-breakpoint

INSERT INTO "problem_version_objects" ("version_id", "role", "path", "storage_url")
SELECT v."id", 'support_package', 'package.zip', p."support_package_storage_url"
FROM "problems" p
JOIN "problem_versions" v
  ON v."problem_id" = p."id" AND v."origin" = 'migration_baseline'
WHERE p."support_package_storage_url" IS NOT NULL
ON CONFLICT ("version_id", "role", "path") DO NOTHING;--> statement-breakpoint

INSERT INTO "storage_objects" ("storage_url", "sha256", "byte_size", "state", "created_at")
SELECT DISTINCT item->>'storage_url', NULLIF(item->>'hash', '')::text, NULLIF(item->>'size', '')::bigint,
  'unknown'::text, to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
FROM "problems" p
CROSS JOIN LATERAL jsonb_each(COALESCE(p."oi_data_files", '{}'::jsonb)) AS entry(path, item)
WHERE item ? 'storage_url'
ON CONFLICT ("storage_url") DO NOTHING;--> statement-breakpoint

INSERT INTO "problem_version_objects" ("version_id", "role", "path", "storage_url")
SELECT v."id", 'oi_file', entry.path, entry.item->>'storage_url'
FROM "problems" p
JOIN "problem_versions" v
  ON v."problem_id" = p."id" AND v."origin" = 'migration_baseline'
CROSS JOIN LATERAL jsonb_each(COALESCE(p."oi_data_files", '{}'::jsonb)) AS entry(path, item)
WHERE entry.item ? 'storage_url'
ON CONFLICT ("version_id", "role", "path") DO NOTHING;--> statement-breakpoint

-- E) 存量普通提交结果 → legacy_import 尝试（未知版本桶，正式判定）
INSERT INTO "evaluation_attempts" (
  "id", "submission_id", "problem_id", "problem_version_id", "sequence", "source",
  "state", "result_kind", "result_status", "score", "accepted", "output", "details",
  "time_ms", "memory_kb", "created_at", "finished_at"
)
SELECT
  md5('noj-legacy-attempt:' || er."submission_id"),
  er."submission_id",
  s."problem_id",
  NULL::text,
  0,
  'legacy_import',
  'finished',
  'graded',
  er."status",
  er."score",
  CASE
    WHEN er."status" = 'finished' AND CASE
      WHEN jsonb_typeof(
        CASE WHEN pg_input_is_valid(er."details", 'jsonb') THEN er."details"::jsonb ELSE '{}'::jsonb END -> 'oi'
      ) = 'object'
      THEN (CASE WHEN pg_input_is_valid(er."details", 'jsonb') THEN er."details"::jsonb ELSE '{}'::jsonb END #>> '{oi,verdict}') = 'AC'
      ELSE er."score" > 0
    END
    THEN true ELSE false
  END,
  COALESCE(er."output", ''),
  CASE WHEN pg_input_is_valid(er."details", 'jsonb') THEN er."details"::jsonb ELSE '{}'::jsonb END,
  er."time_ms",
  er."memory_kb",
  er."created_at",
  er."created_at"
FROM "evaluation_results" er
JOIN "submissions" s ON s."id" = er."submission_id"
WHERE NOT EXISTS (
  SELECT 1 FROM "evaluation_attempts" a
  WHERE a."submission_id" = er."submission_id" AND a."source" = 'legacy_import'
);--> statement-breakpoint

-- F) 存量客观题提交 → legacy_import 尝试（通过标准=满分，§1.4）
INSERT INTO "evaluation_attempts" (
  "id", "objective_submission_id", "problem_id", "problem_version_id", "sequence", "source",
  "state", "result_kind", "result_status", "score", "accepted", "output", "details",
  "created_at", "finished_at"
)
SELECT
  md5('noj-legacy-obj-attempt:' || os."id"),
  os."id",
  os."paper_id",
  NULL::text,
  0,
  'legacy_import',
  'finished',
  'graded',
  'finished',
  os."score",
  os."score" >= 10000,
  '',
  COALESCE(os."details", '{}'::jsonb),
  os."created_at",
  os."created_at"
FROM "objective_submissions" os
WHERE NOT EXISTS (
  SELECT 1 FROM "evaluation_attempts" a
  WHERE a."objective_submission_id" = os."id" AND a."source" = 'legacy_import'
);--> statement-breakpoint

-- G) 未知版本桶的当前判定
INSERT INTO "submission_version_results" (
  "id", "submission_id", "problem_id", "problem_version_id", "current_attempt_id", "updated_at"
)
SELECT
  md5('noj-legacy-vr:' || a."submission_id"),
  a."submission_id",
  a."problem_id",
  NULL::text,
  a."id",
  a."finished_at"
FROM "evaluation_attempts" a
WHERE a."source" = 'legacy_import' AND a."submission_id" IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM "submission_version_results" r
    WHERE r."submission_id" = a."submission_id" AND r."problem_version_id" IS NULL
  );--> statement-breakpoint

INSERT INTO "submission_version_results" (
  "id", "objective_submission_id", "problem_id", "problem_version_id", "current_attempt_id", "updated_at"
)
SELECT
  md5('noj-legacy-obj-vr:' || a."objective_submission_id"),
  a."objective_submission_id",
  a."problem_id",
  NULL::text,
  a."id",
  a."finished_at"
FROM "evaluation_attempts" a
WHERE a."source" = 'legacy_import' AND a."objective_submission_id" IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM "submission_version_results" r
    WHERE r."objective_submission_id" = a."objective_submission_id" AND r."problem_version_id" IS NULL
  );--> statement-breakpoint

-- H) 初始有效属性（题库口径；默认 any → 未知版本桶计入候选）
UPDATE "submissions" s
SET
  "is_valid" = true,
  "is_accepted" = a."accepted",
  "effective_attempt_id" = a."id",
  "accepted_attempt_id" = CASE WHEN a."accepted" THEN a."id" ELSE NULL END,
  "latest_attempt_id" = COALESCE(s."latest_attempt_id", a."id")
FROM "evaluation_attempts" a
WHERE a."submission_id" = s."id"
  AND a."source" = 'legacy_import'
  AND s."is_valid" = false;--> statement-breakpoint

UPDATE "objective_submissions" os
SET
  "is_valid" = true,
  "is_accepted" = a."accepted",
  "effective_attempt_id" = a."id",
  "accepted_attempt_id" = CASE WHEN a."accepted" THEN a."id" ELSE NULL END,
  "latest_attempt_id" = COALESCE(os."latest_attempt_id", a."id")
FROM "evaluation_attempts" a
WHERE a."objective_submission_id" = os."id"
  AND a."source" = 'legacy_import'
  AND os."is_valid" = false;--> statement-breakpoint

-- I) 竞赛口径投影（仅竞赛提交且该题确实在竞赛中）
UPDATE "submissions" s
SET
  "is_contest_valid" = true,
  "is_contest_accepted" = a."accepted",
  "contest_effective_attempt_id" = a."id",
  "contest_accepted_attempt_id" = CASE WHEN a."accepted" THEN a."id" ELSE NULL END,
  "contest_policy_revision" = 0
FROM "evaluation_attempts" a
WHERE a."submission_id" = s."id"
  AND a."source" = 'legacy_import'
  AND s."contest_id" IS NOT NULL
  AND EXISTS (
    SELECT 1 FROM "contest_problems" cp
    WHERE cp."contest_id" = s."contest_id" AND cp."problem_id" = s."problem_id"
  );--> statement-breakpoint

UPDATE "objective_submissions" os
SET
  "is_contest_valid" = true,
  "is_contest_accepted" = a."accepted",
  "contest_effective_attempt_id" = a."id",
  "contest_accepted_attempt_id" = CASE WHEN a."accepted" THEN a."id" ELSE NULL END,
  "contest_policy_revision" = 0
FROM "evaluation_attempts" a
WHERE a."objective_submission_id" = os."id"
  AND a."source" = 'legacy_import'
  AND os."contest_id" IS NOT NULL
  AND EXISTS (
    SELECT 1 FROM "contest_problems" cp
    WHERE cp."contest_id" = os."contest_id" AND cp."problem_id" = os."paper_id"
  );--> statement-breakpoint

-- J) 投影 revision 初始化（global 作用域；题目/竞赛作用域按需创建）
INSERT INTO "query_projection_revisions" ("scope_key", "data_revision", "materialized_revision")
VALUES ('global', 1, 0)
ON CONFLICT ("scope_key") DO NOTHING;
--> statement-breakpoint
ALTER TABLE "audit_logs" DROP CONSTRAINT "audit_logs_action_check";
--> statement-breakpoint
ALTER TABLE "objective_submissions" ALTER COLUMN "version_origin" SET DEFAULT 'legacy_unknown';
--> statement-breakpoint
ALTER TABLE "submissions" ALTER COLUMN "version_origin" SET DEFAULT 'legacy_unknown';
--> statement-breakpoint
CREATE INDEX "idx_eval_attempts_submission_finished" ON "evaluation_attempts" USING btree ("submission_id","finished_at" DESC NULLS LAST);
--> statement-breakpoint
CREATE INDEX "idx_submission_version_results_current_attempt" ON "submission_version_results" USING btree ("current_attempt_id");
--> statement-breakpoint
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_action_check" CHECK ("audit_logs"."action" IN (
        'users.role_change','users.ban','users.unban',
        'users.delete','roles.create','roles.update',
        'roles.delete','problems.delete','problems.runtime_config_changed',
        'problems.imported','problems.review','problems.version_published',
        'problems.effective_version_policy_changed','contest.problem_version_changed','contest.problem_effective_version_policy_changed',
        'trainings.update','trainings.delete','tags.create',
        'tags.update','tags.delete','tags.merge',
        'submissions.rejudge','submissions.queue_removed','submissions.delete',
        'settings.update','ip_ban.create','ip_ban.delete',
        'auth.login_success','auth.login_failure','auth.register',
        'auth.email_verified','auth.delete_account','auth.change_password',
        'auth.forgot_password_request','auth.password_reset','auth.tfa_setup',
        'auth.tfa_enabled','auth.tfa_disabled','auth.tfa_recovery_regenerated',
        'auth.tfa_recovery_used','community.post_moderated','community.report_resolved',
        'community.sanction_created','community.sanction_revoked','community.preset_applied',
        'community.board_create','community.board_update','community.board_role_grant_update',
        'community.board_role_grant_delete','community.post_flag','announcement.create',
        'announcement.update','announcement.delete','carousel.create',
        'carousel.update','carousel.delete','carousel.reorder',
        'review.queued','review.rejected','review.resolved',
        'contest.ranking_snapshot','contest.create','contest.update',
        'contest.delete','contest.participants_add','contest.participants_remove',
        'contest.kind_change','contest.reset_code','judge_images.create',
        'judge_images.update','judge_images.delete','email_delivery.clear_suppression',
        'llm_provider.create','llm_provider.update','llm_quota.upsert',
        'legal.publish_version','legal.data_request_update'
      ));
--> statement-breakpoint
