-- 竞赛固定版本收紧为 NOT NULL（Handbook §2.6/§8.1 第 7 步）。
--
-- 前置条件：`contest_problems.pinned_version_id` 在 0102 中按"三步式"新增为可空列，
-- 本迁移负责回填后收紧。回填规则：
--   1. 被竞赛引用但**尚未发布任何版本**的题目，先补一个 `migration_baseline`
--      V1（内容取当前题目投影；客观题小题取当前 objective_questions，UUID 作 key），
--      并把 problems.latest_version_id 指向它；
--   2. 竞赛关联的固定版本回填为该题目的最新已发布版本；
--   3. 若仍有无法回填的行，直接报错终止（宁可迁移失败，也不要写入空的固定版本——
--      空固定版本会让"竞赛评哪一版"失去事实来源）。
--
-- 版本号取该题已有最大版本 +1，避免与既有 UNIQUE(problem_id, version) 冲突。

WITH target AS (
  SELECT
    p.id,
    CASE
      WHEN p.is_objective THEN 'objective'
      WHEN COALESCE(p.judge_type, 'dual') = 'oi' THEN 'oi'
      ELSE 'ai'
    END AS kind,
    p.title,
    p.description,
    p.samples,
    p.runtime_config,
    p.submission_mode,
    p.template_content,
    p.artifact_max_size_mb,
    p.llm_config,
    COALESCE(
      (SELECT MAX(v.version) FROM problem_versions v WHERE v.problem_id = p.id),
      0
    ) + 1 AS next_version
  FROM problems p
  WHERE p.latest_version_id IS NULL
    AND EXISTS (
      SELECT 1 FROM contest_problems cp WHERE cp.problem_id = p.id
    )
),
created AS (
  INSERT INTO problem_versions (
    id,
    problem_id,
    version,
    schema_version,
    origin,
    content,
    content_sha256,
    change_note,
    published_by,
    published_at
  )
  SELECT
    gen_random_uuid()::text,
    t.id,
    t.next_version,
    1,
    'migration_baseline',
    jsonb_build_object(
      'kind', t.kind,
      'title', t.title,
      'description', t.description,
      'samples', COALESCE(t.samples, '[]'::jsonb)
    ) || CASE t.kind
      WHEN 'objective' THEN jsonb_build_object(
        'questions', COALESCE((
          SELECT jsonb_agg(
            jsonb_build_object(
              'key', q.id,
              'sort_order', q.sort_order,
              'type', q.type,
              'prompt', q.prompt,
              'options', q.options,
              'answer', q.answer,
              'explanation', q.explanation
            )
            ORDER BY q.sort_order, q.id
          )
          FROM objective_questions q
          WHERE q.paper_id = t.id
        ), '[]'::jsonb)
      )
      WHEN 'oi' THEN jsonb_build_object(
        'runtime_config', COALESCE(t.runtime_config, '{}'::jsonb)
      )
      ELSE jsonb_build_object(
        'submission_mode', COALESCE(t.submission_mode, 'code'),
        'runtime_config', COALESCE(t.runtime_config, '{}'::jsonb),
        'template_content', COALESCE(t.template_content, ''),
        'artifact_max_size_mb', t.artifact_max_size_mb,
        'llm_config', t.llm_config
      )
    END,
    NULL,
    '竞赛固定版本回填（存量未发布题目）',
    NULL,
    now()
  FROM target t
  RETURNING id, problem_id
)
UPDATE problems p
SET latest_version_id = c.id
FROM created c
WHERE p.id = c.problem_id;

-- 回填竞赛固定版本：取该题目当前的最新已发布版本
UPDATE contest_problems cp
SET pinned_version_id = p.latest_version_id
FROM problems p
WHERE cp.problem_id = p.id
  AND cp.pinned_version_id IS NULL
  AND p.latest_version_id IS NOT NULL;

-- 兜底门禁：仍有空固定版本时终止迁移（不写空值、不静默放过）
DO $$
DECLARE
  remaining integer;
BEGIN
  SELECT count(*) INTO remaining
  FROM contest_problems
  WHERE pinned_version_id IS NULL;
  IF remaining > 0 THEN
    RAISE EXCEPTION '竞赛题目仍有 % 行无法回填固定版本，迁移中止（请先为相关题目发布版本）', remaining;
  END IF;
END $$;

ALTER TABLE "contest_problems" ALTER COLUMN "pinned_version_id" SET NOT NULL;
