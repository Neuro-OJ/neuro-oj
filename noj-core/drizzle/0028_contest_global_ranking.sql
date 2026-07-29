DROP MATERIALIZED VIEW IF EXISTS user_rankings;

CREATE MATERIALIZED VIEW user_rankings AS
  SELECT
    u.id AS user_id,
    u.username,
    COUNT(*)::int AS total_submissions,
    COUNT(DISTINCT s.problem_id) FILTER (
      WHERE er.status = 'Accepted'
        AND (s.contest_id IS NULL OR c.affect_global_ranking = TRUE)
    )::int AS solved_count,
    COUNT(*) FILTER (WHERE er.status = 'Accepted')::int AS accepted,
    CASE WHEN COUNT(*) = 0 THEN 0
         ELSE ROUND(
           (COUNT(*) FILTER (WHERE er.status = 'Accepted')::float / COUNT(*))::numeric,
           3
         )::float
    END AS acceptance_rate,
    ROW_NUMBER() OVER (
      ORDER BY
        COUNT(DISTINCT s.problem_id) FILTER (
          WHERE er.status = 'Accepted'
            AND (s.contest_id IS NULL OR c.affect_global_ranking = TRUE)
        ) DESC,
        CASE WHEN COUNT(*) = 0 THEN 0
             ELSE COUNT(*) FILTER (WHERE er.status = 'Accepted')::float / COUNT(*)
        END DESC,
        COUNT(*) ASC,
        u.created_at ASC
    )::int AS rank
  FROM users u
  INNER JOIN submissions s ON s.user_id = u.id
  LEFT JOIN evaluation_results er ON er.submission_id = s.id
  LEFT JOIN contests c ON c.id = s.contest_id
  WHERE u.id <> '0' AND s.status = 'finished'
  GROUP BY u.id, u.username, u.created_at
  HAVING COUNT(*) FILTER (
    WHERE er.status = 'Accepted'
      AND (s.contest_id IS NULL OR c.affect_global_ranking = TRUE)
  ) > 0;

CREATE UNIQUE INDEX idx_user_rankings_user_id ON user_rankings (user_id);
CREATE INDEX idx_user_rankings_rank ON user_rankings (rank);
