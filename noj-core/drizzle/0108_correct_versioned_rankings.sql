-- 修正双题型榜单、竞赛保密窗口与重测运行状态；追加迁移保留已有部署的升级路径。
--
-- 赛期守卫必须与内联查询 `endedWindowCondition`（contest-window.ts）**逐字一致**：
-- 先按规范 ISO 正则 fail-closed，再交给 `pg_input_is_valid` 判定可解析性。
-- 只判 `pg_input_is_valid` 会把「可解析但非规范 ISO」的 end_time 误算成已结束，
-- 从而在视图被标记可信时给出与内联查询不同的成绩口径。
DROP MATERIALIZED VIEW IF EXISTS user_rankings;

CREATE MATERIALIZED VIEW user_rankings AS
  SELECT
    u.id AS user_id,
    u.username,
    COUNT(*)::int AS total_submissions,
    COUNT(*) FILTER (WHERE s.is_valid)::int AS valid_submissions,
    COUNT(DISTINCT s.problem_id) FILTER (
      WHERE s.is_accepted AND (s.contest_id IS NULL OR (c.affect_global_ranking = TRUE AND CASE WHEN c.end_time ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$' AND pg_input_is_valid(c.end_time, 'timestamptz') THEN c.end_time::timestamptz <= CURRENT_TIMESTAMP ELSE FALSE END))
    )::int AS solved_count,
    COUNT(*) FILTER (WHERE s.is_accepted AND (s.contest_id IS NULL OR (c.affect_global_ranking = TRUE AND CASE WHEN c.end_time ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$' AND pg_input_is_valid(c.end_time, 'timestamptz') THEN c.end_time::timestamptz <= CURRENT_TIMESTAMP ELSE FALSE END)))::int AS accepted,
    CASE WHEN COUNT(*) FILTER (WHERE s.is_valid) = 0 THEN 0
         ELSE ROUND(
           (COUNT(*) FILTER (WHERE s.is_accepted AND (s.contest_id IS NULL OR (c.affect_global_ranking = TRUE AND CASE WHEN c.end_time ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$' AND pg_input_is_valid(c.end_time, 'timestamptz') THEN c.end_time::timestamptz <= CURRENT_TIMESTAMP ELSE FALSE END)))::float / COUNT(*) FILTER (WHERE s.is_valid))::numeric,
           3
         )::float
    END AS acceptance_rate,
    ROW_NUMBER() OVER (
      ORDER BY
        COUNT(DISTINCT s.problem_id) FILTER (
          WHERE s.is_accepted AND (s.contest_id IS NULL OR (c.affect_global_ranking = TRUE AND CASE WHEN c.end_time ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$' AND pg_input_is_valid(c.end_time, 'timestamptz') THEN c.end_time::timestamptz <= CURRENT_TIMESTAMP ELSE FALSE END))
        ) DESC,
        CASE WHEN COUNT(*) FILTER (WHERE s.is_valid) = 0 THEN 0
             ELSE COUNT(*) FILTER (WHERE s.is_accepted AND (s.contest_id IS NULL OR (c.affect_global_ranking = TRUE AND CASE WHEN c.end_time ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$' AND pg_input_is_valid(c.end_time, 'timestamptz') THEN c.end_time::timestamptz <= CURRENT_TIMESTAMP ELSE FALSE END)))::float / COUNT(*) FILTER (WHERE s.is_valid)
        END DESC,
        COUNT(*) ASC,
        u.created_at ASC
    )::int AS rank
  FROM users u
  INNER JOIN (
    SELECT user_id, problem_id, contest_id, status, is_valid, is_accepted FROM submissions
    UNION ALL
    SELECT user_id, paper_id AS problem_id, contest_id, status, is_valid, is_accepted FROM objective_submissions
  ) s ON s.user_id = u.id
  LEFT JOIN contests c ON c.id = s.contest_id
  WHERE u.id <> '0' AND (s.contest_id IS NULL OR (c.affect_global_ranking = TRUE AND CASE WHEN c.end_time ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$' AND pg_input_is_valid(c.end_time, 'timestamptz') THEN c.end_time::timestamptz <= CURRENT_TIMESTAMP ELSE FALSE END))
  GROUP BY u.id, u.username, u.created_at
  HAVING COUNT(*) FILTER (
    WHERE s.is_accepted AND (s.contest_id IS NULL OR (c.affect_global_ranking = TRUE AND CASE WHEN c.end_time ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$' AND pg_input_is_valid(c.end_time, 'timestamptz') THEN c.end_time::timestamptz <= CURRENT_TIMESTAMP ELSE FALSE END))
  ) > 0;

CREATE UNIQUE INDEX idx_user_rankings_user_id ON user_rankings (user_id);
CREATE INDEX idx_user_rankings_rank ON user_rankings (rank);

INSERT INTO query_projection_revisions (scope_key, data_revision, materialized_revision)
VALUES ('global', 1, 0)
ON CONFLICT (scope_key) DO UPDATE SET data_revision = query_projection_revisions.data_revision + 1;
