-- ============================================================================
-- PR #622 审查清单 #14 / #24 / #25：存量迁移收尾修复（Handbook §2.9、§8.1）
--
-- 背景：0103 的回填把所有存量结果统一当作 `finished/graded`，并写入未知版本桶的
-- 当前判定、把提交标为 `is_valid = true`。这抹平了**平台失败**（SE、内部错误、
-- AI 基础设施失败）与**正式判定**（AC/WA/CE/用户超时）的区别，从而改变通过率
-- 分母与结算语义（#25）。
--
-- 同时 0103 只回填了**版本**文件引用（`problem_version_objects`），没有回填草稿
-- 文件引用（`problem_draft_objects`）。首次编辑存量题时草稿会被物化为空文件集合，
-- 后续发布 lossen 支持包与 OI 文件（#24）。服务层已经在「首次物化草稿」时复制
-- 基线引用；本迁移为已经存在草稿行但没有引用的存量题目补齐引用（#14 的存量面）。
--
-- 幂等性：两条路径都以「当前状态」为条件，重复执行不产生副作用。
-- ============================================================================

-- A) 平台失败的历史结果不再成为正式有效判定。
UPDATE "evaluation_attempts"
SET "result_kind" = 'platform_error'
WHERE "source" = 'legacy_import'
  AND "result_kind" = 'graded'
  AND (
    "result_status" IN ('error', 'SystemError', 'SE', 'FE', 'cancelled')
    OR (
      "result_status" = 'finished'
      AND "details" -> 'ai' ->> 'infra_error' = 'true'
    )
  );--> statement-breakpoint

-- B) 普通提交：平台失败不建立正式判定桶，而是保留为最近尝试。
--    - `is_valid` / `is_accepted` 归零（无候选）；
--    - `effective_attempt_id` 指向该平台失败尝试，`latest_attempt_id` 一并保留；
--    - 竞赛口径遵循同一规则。
UPDATE "submissions" s
SET
  "is_valid" = false,
  "is_accepted" = false,
  "effective_attempt_id" = NULL,
  "accepted_attempt_id" = NULL,
  "latest_attempt_id" = COALESCE(s."latest_attempt_id", a."id"),
  "is_contest_valid" = false,
  "is_contest_accepted" = false,
  "contest_effective_attempt_id" = NULL,
  "contest_accepted_attempt_id" = NULL
FROM "evaluation_attempts" a
WHERE a."submission_id" = s."id"
  AND a."source" = 'legacy_import'
  AND a."result_kind" = 'platform_error';--> statement-breakpoint

DELETE FROM "submission_version_results" r
USING "evaluation_attempts" a
WHERE r."current_attempt_id" = a."id"
  AND a."source" = 'legacy_import'
  AND a."result_kind" = 'platform_error';--> statement-breakpoint

-- C) 客观题提交同样处理（通过标准=满分，平台失败同样不能算正式判定）。
UPDATE "objective_submissions" os
SET
  "is_valid" = false,
  "is_accepted" = false,
  "effective_attempt_id" = NULL,
  "accepted_attempt_id" = NULL,
  "latest_attempt_id" = COALESCE(os."latest_attempt_id", a."id"),
  "is_contest_valid" = false,
  "is_contest_accepted" = false,
  "contest_effective_attempt_id" = NULL,
  "contest_accepted_attempt_id" = NULL
FROM "evaluation_attempts" a
WHERE a."objective_submission_id" = os."id"
  AND a."source" = 'legacy_import'
  AND a."result_kind" = 'platform_error';--> statement-breakpoint

DELETE FROM "submission_version_results" r
USING "evaluation_attempts" a
WHERE r."current_attempt_id" = a."id"
  AND a."source" = 'legacy_import'
  AND a."result_kind" = 'platform_error';--> statement-breakpoint

-- D) 裁决变化会影响全站榜单与统计口径。
UPDATE "query_projection_revisions"
SET "data_revision" = "data_revision" + 1
WHERE "scope_key" = 'global';--> statement-breakpoint

-- E) 存量题目的草稿文件引用补齐：以「最新已发布版本」的文件集合为基线复制。
--    已有草稿引用的题目不动（服务层在首次物化草稿时也会执行同样的复制）。
INSERT INTO "problem_draft_objects" ("problem_id", "role", "path", "storage_url")
SELECT p."id", o."role", o."path", o."storage_url"
FROM "problems" p
JOIN "problem_drafts" d ON d."problem_id" = p."id"
JOIN "problem_version_objects" o ON o."version_id" = p."latest_version_id"
ON CONFLICT ("problem_id", "role", "path") DO NOTHING;--> statement-breakpoint

-- F) 没有草稿行的存量题目由服务层在首次读取/保存草稿时按同一规则物化，这里不
--    预先创建草稿行（避免破坏 `problem_drafts.revision` 的乐观锁基线语义）。
