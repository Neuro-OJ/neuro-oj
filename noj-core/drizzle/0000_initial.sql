CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  username TEXT NOT NULL,
  email TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'user',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS users_username_unique ON users (username);
CREATE UNIQUE INDEX IF NOT EXISTS users_email_unique ON users (email);

CREATE TABLE IF NOT EXISTS problems (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  description TEXT NOT NULL,
  difficulty TEXT NOT NULL DEFAULT 'medium',
  judge_image TEXT NOT NULL,
  judge_command TEXT NOT NULL,
  support_package_path TEXT,
  time_limit_ms INTEGER NOT NULL DEFAULT 5000,
  memory_limit_mb INTEGER NOT NULL DEFAULT 512,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS submissions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  problem_id TEXT NOT NULL REFERENCES problems(id),
  language TEXT NOT NULL,
  code TEXT NOT NULL,
  file_name TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_submissions_user_id ON submissions (user_id);
CREATE INDEX IF NOT EXISTS idx_submissions_problem_id ON submissions (problem_id);
CREATE INDEX IF NOT EXISTS idx_submissions_status ON submissions (status);
CREATE INDEX IF NOT EXISTS idx_submissions_created_at ON submissions (created_at);

CREATE TABLE IF NOT EXISTS evaluation_results (
  id TEXT PRIMARY KEY,
  submission_id TEXT NOT NULL REFERENCES submissions(id),
  status TEXT NOT NULL,
  score INTEGER NOT NULL DEFAULT 0,
  output TEXT NOT NULL DEFAULT '',
  details TEXT NOT NULL DEFAULT '{}',
  time_ms INTEGER,
  memory_kb INTEGER,
  created_at TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_eval_results_submission_id ON evaluation_results (submission_id);
