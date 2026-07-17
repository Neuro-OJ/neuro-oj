-- PR-4 榜单物化视图
-- 替换 rankings.ts 中每次请求都执行的 users × submissions × evaluation_results 三表 GROUP BY + ROW_NUMBER()
-- 写入路径（评测结果回写）触发 REFRESH MATERIALIZED VIEW CONCURRENTLY
CREATE MATERIALIZED VIEW IF NOT EXISTS user_rankings AS
  SELECT
    u.id AS user_id,
    u.username,
    COUNT(*)::int AS total_submissions,
    COUNT(DISTINCT s.problem_id) FILTER (WHERE er.status = 'Accepted')::int AS solved_count,
    COUNT(*) FILTER (WHERE er.status = 'Accepted')::int AS accepted,
    CASE WHEN COUNT(*) = 0 THEN 0
         ELSE ROUND(
           (COUNT(*) FILTER (WHERE er.status = 'Accepted')::float / COUNT(*))::numeric,
           3
         )::float
    END AS acceptance_rate,
    ROW_NUMBER() OVER (
      ORDER BY
        COUNT(DISTINCT s.problem_id) FILTER (WHERE er.status = 'Accepted') DESC,
        CASE WHEN COUNT(*) = 0 THEN 0
             ELSE COUNT(*) FILTER (WHERE er.status = 'Accepted')::float / COUNT(*)
        END DESC,
        COUNT(*) ASC,
        u.created_at ASC
    )::int AS rank
  FROM users u
  INNER JOIN submissions s ON s.user_id = u.id
  LEFT JOIN evaluation_results er ON er.submission_id = s.id
  WHERE u.id <> '0' AND s.status = 'finished'
  GROUP BY u.id, u.username, u.created_at
  HAVING COUNT(*) FILTER (WHERE er.status = 'Accepted') > 0;

-- 物化视图唯一索引（CONCURRENTLY REFRESH 前提）
CREATE UNIQUE INDEX IF NOT EXISTS idx_user_rankings_user_id ON user_rankings (user_id);
CREATE INDEX IF NOT EXISTS idx_user_rankings_rank ON user_rankings (rank);