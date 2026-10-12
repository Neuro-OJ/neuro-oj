-- 重建用户榜单物化视图：从旧 `evaluation_results` 改为读**有效成绩投影**
-- （`submissions.is_accepted`，由结果写入服务按题库策略维护，OI 已按 AC verdict 归一）。
--
-- Handbook §3.5/§6.6：版本化后榜单的通过口径 = 有效成绩投影；旧视图基于
-- `evaluation_results`，在该表停止写入后必然为空，必须在删表前重建。
-- 视图落后时读取路径会自动回退内联查询（`isRankingViewTrusted`），
-- 因此本迁移只负责把视图定义换到新模型，刷新仍由 `refreshRankingsView` 串行执行。
DROP MATERIALIZED VIEW IF EXISTS user_rankings;

CREATE MATERIALIZED VIEW user_rankings AS
  SELECT
    u.id AS user_id,
    u.username,
    COUNT(*)::int AS total_submissions,
    COUNT(DISTINCT s.problem_id) FILTER (
      WHERE s.is_accepted AND (s.contest_id IS NULL OR c.affect_global_ranking = TRUE)
    )::int AS solved_count,
    COUNT(*) FILTER (WHERE s.is_accepted)::int AS accepted,
    CASE WHEN COUNT(*) = 0 THEN 0
         ELSE ROUND(
           (COUNT(*) FILTER (WHERE s.is_accepted)::float / COUNT(*))::numeric,
           3
         )::float
    END AS acceptance_rate,
    ROW_NUMBER() OVER (
      ORDER BY
        COUNT(DISTINCT s.problem_id) FILTER (
          WHERE s.is_accepted AND (s.contest_id IS NULL OR c.affect_global_ranking = TRUE)
        ) DESC,
        CASE WHEN COUNT(*) = 0 THEN 0
             ELSE COUNT(*) FILTER (WHERE s.is_accepted)::float / COUNT(*)
        END DESC,
        COUNT(*) ASC,
        u.created_at ASC
    )::int AS rank
  FROM users u
  INNER JOIN submissions s ON s.user_id = u.id
  LEFT JOIN contests c ON c.id = s.contest_id
  WHERE u.id <> '0' AND s.status = 'finished'
  GROUP BY u.id, u.username, u.created_at
  HAVING COUNT(*) FILTER (
    WHERE s.is_accepted AND (s.contest_id IS NULL OR c.affect_global_ranking = TRUE)
  ) > 0;

CREATE UNIQUE INDEX idx_user_rankings_user_id ON user_rankings (user_id);
CREATE INDEX idx_user_rankings_rank ON user_rankings (rank);
