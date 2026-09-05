CREATE TABLE IF NOT EXISTS contest_ranking_snapshots (
  id text PRIMARY KEY,
  contest_id text NOT NULL REFERENCES contests(id) ON DELETE CASCADE,
  version integer NOT NULL,
  status text NOT NULL DEFAULT 'published',
  note text NOT NULL DEFAULT '',
  rows jsonb NOT NULL,
  created_by text REFERENCES users(id) ON DELETE SET NULL,
  created_at text NOT NULL,
  CONSTRAINT contest_ranking_snapshots_contest_version_unique UNIQUE (contest_id, version)
);
CREATE INDEX IF NOT EXISTS idx_contest_ranking_snapshots_contest_created
  ON contest_ranking_snapshots (contest_id, created_at);
