/**
 * Schema DDL SQL 字符串——与 src/db/schema.ts 同步。
 *
 * 供 PGlite 模式在测试中建表使用。当 Drizzle schema 变更时需同步更新此文件。
 */
export const SCHEMA_DDL: string[] = [
  // 1. users
  `CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    username TEXT NOT NULL UNIQUE,
    email TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'user',
    bio TEXT NOT NULL DEFAULT '',
    must_change_password BOOLEAN NOT NULL DEFAULT false,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,

  // 2. problems
  `CREATE TABLE IF NOT EXISTS problems (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    description TEXT NOT NULL,
    difficulty TEXT NOT NULL DEFAULT 'medium',
    judge_image TEXT NOT NULL,
    judge_command TEXT NOT NULL,
    support_package_storage_url TEXT,
    time_limit_ms INTEGER NOT NULL DEFAULT 5000,
    memory_limit_mb INTEGER NOT NULL DEFAULT 512,
    runtime_config JSONB CHECK (runtime_config IS NULL OR jsonb_typeof(runtime_config) = 'object'),
    number INTEGER NOT NULL,
    owner_id TEXT NOT NULL DEFAULT '0',
    type TEXT NOT NULL DEFAULT 'U' CHECK (type IN ('U', 'P')),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    search_vector TSVECTOR
  )`,

  // 3. judge_images
  `CREATE TABLE IF NOT EXISTS judge_images (
    id TEXT PRIMARY KEY,
    image TEXT NOT NULL,
    mode TEXT NOT NULL DEFAULT 'exact' CHECK (mode IN ('exact', 'all_versions')),
    kind TEXT NOT NULL DEFAULT 'evaluator' CHECK (kind IN ('evaluator', 'solution')),
    description TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,

  // 4. categories
  `CREATE TABLE IF NOT EXISTS categories (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    slug TEXT NOT NULL UNIQUE,
    description TEXT NOT NULL DEFAULT '',
    parent_id TEXT REFERENCES categories(id) ON DELETE SET NULL,
    level INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,

  // 5. problems_categories
  `CREATE TABLE IF NOT EXISTS problems_categories (
    problem_id TEXT NOT NULL REFERENCES problems(id) ON DELETE CASCADE,
    category_id TEXT NOT NULL REFERENCES categories(id) ON DELETE CASCADE,
    PRIMARY KEY (problem_id, category_id)
  )`,

  // 6. submissions
  `CREATE TABLE IF NOT EXISTS submissions (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id),
    problem_id TEXT NOT NULL REFERENCES problems(id),
    language TEXT NOT NULL,
    code TEXT NOT NULL,
    file_name TEXT,
    status TEXT NOT NULL DEFAULT 'pending',
    rejudge_seq INTEGER NOT NULL DEFAULT 0,
    judge_started_at TEXT,
    judge_finished_at TEXT,
    created_at TEXT NOT NULL
  )`,

  // 7. evaluation_results
  `CREATE TABLE IF NOT EXISTS evaluation_results (
    id TEXT PRIMARY KEY,
    submission_id TEXT NOT NULL UNIQUE REFERENCES submissions(id),
    status TEXT NOT NULL,
    score INTEGER NOT NULL DEFAULT 0,
    output TEXT NOT NULL DEFAULT '',
    details TEXT NOT NULL DEFAULT '{}',
    time_ms INTEGER,
    memory_kb INTEGER,
    created_at TEXT NOT NULL
  )`,

  // 8. check_ins
  `CREATE TABLE IF NOT EXISTS check_ins (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    checkin_date TEXT NOT NULL,
    streak INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL,
    UNIQUE (user_id, checkin_date)
  )`,

  // 9. password_reset_tokens
  `CREATE TABLE IF NOT EXISTS password_reset_tokens (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token_hash TEXT NOT NULL UNIQUE,
    expires_at TEXT NOT NULL,
    used_at TEXT,
    created_at TEXT NOT NULL
  )`,

  // 10. conversations
  `CREATE TABLE IF NOT EXISTS conversations (
    id TEXT PRIMARY KEY,
    user1_id TEXT NOT NULL REFERENCES users(id),
    user2_id TEXT NOT NULL REFERENCES users(id),
    last_message_at TEXT NOT NULL,
    created_at TEXT NOT NULL,
    UNIQUE (user1_id, user2_id),
    CHECK (user1_id < user2_id)
  )`,

  // 11. messages
  `CREATE TABLE IF NOT EXISTS messages (
    id TEXT PRIMARY KEY,
    conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    sender_id TEXT NOT NULL REFERENCES users(id),
    content TEXT NOT NULL,
    created_at TEXT NOT NULL
  )`,

  // 12. conversation_reads
  `CREATE TABLE IF NOT EXISTS conversation_reads (
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    last_read_message_id TEXT,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (user_id, conversation_id)
  )`,

  // 13. message_deletions
  `CREATE TABLE IF NOT EXISTS message_deletions (
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
    deleted_at TEXT NOT NULL,
    PRIMARY KEY (user_id, message_id)
  )`,

  // 14. system_settings (issue #99)
  `CREATE TABLE IF NOT EXISTS system_settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    is_secret BOOLEAN NOT NULL DEFAULT false,
    updated_at TEXT NOT NULL,
    updated_by TEXT REFERENCES users(id) ON DELETE SET NULL
  )`,

  // 15. audit_logs (issue #101)
  `CREATE TABLE IF NOT EXISTS audit_logs (
    id TEXT PRIMARY KEY,
    admin_id TEXT NOT NULL REFERENCES users(id),
    action TEXT NOT NULL,
    target_type TEXT,
    target_id TEXT,
    detail JSONB NOT NULL DEFAULT '{}',
    ip_address TEXT NOT NULL,
    created_at TEXT NOT NULL,
    CONSTRAINT audit_logs_action_check CHECK (action IN (
      'users.role_change','users.ban','users.unban',
      'problems.delete','problems.runtime_config_changed','categories.delete','submissions.rejudge','settings.update',
      'ip_ban.create','ip_ban.delete'
    ))
  )`,

  // 16. ip_bans (issue #102)
  `CREATE TABLE IF NOT EXISTS ip_bans (
    id TEXT PRIMARY KEY,
    ip_or_cidr TEXT NOT NULL,
    reason TEXT NOT NULL DEFAULT '',
    expires_at TEXT,
    created_at TEXT NOT NULL,
    created_by TEXT REFERENCES users(id) ON DELETE SET NULL
  )`,

  // 17. user_bans (issue #102)
  `CREATE TABLE IF NOT EXISTS user_bans (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    reason TEXT NOT NULL DEFAULT '',
    banned_until TEXT,
    banned_at TEXT NOT NULL,
    banned_by TEXT REFERENCES users(id) ON DELETE SET NULL,
    unbanned_at TEXT,
    unbanned_by TEXT REFERENCES users(id) ON DELETE SET NULL
  )`,
];

export const SCHEMA_INDEXES: string[] = [
  "CREATE UNIQUE INDEX IF NOT EXISTS problems_type_number_unique ON problems (type, number)",
  // 全文搜索扩展与索引（issue #100）
  "CREATE EXTENSION IF NOT EXISTS pg_trgm",
  "CREATE INDEX IF NOT EXISTS idx_problems_search_vector ON problems USING gin (search_vector)",
  "CREATE INDEX IF NOT EXISTS idx_problems_display_id_trgm ON problems USING gin ((type || number::text) gin_trgm_ops)",
  "CREATE INDEX IF NOT EXISTS idx_users_username_trgm ON users USING gin (username gin_trgm_ops)",
  "CREATE INDEX IF NOT EXISTS idx_users_email_trgm ON users USING gin (email gin_trgm_ops)",
  // trigger 函数 + trigger（issue #100）
  `CREATE OR REPLACE FUNCTION problems_search_vector_update() RETURNS trigger AS $$
   BEGIN
     NEW.search_vector :=
       setweight(to_tsvector('simple', coalesce(NEW.title, '')), 'A') ||
       setweight(to_tsvector('simple', coalesce(NEW.description, '')), 'B') ||
       setweight(to_tsvector('simple', coalesce(NEW.type || NEW.number::text, '')), 'A');
     RETURN NEW;
   END;
   $$ LANGUAGE plpgsql`,
  "DROP TRIGGER IF EXISTS trg_problems_search_vector ON problems",
  "CREATE TRIGGER trg_problems_search_vector BEFORE INSERT OR UPDATE OF title, description, type, number ON problems FOR EACH ROW EXECUTE FUNCTION problems_search_vector_update()",
  "CREATE INDEX IF NOT EXISTS idx_submissions_user_id ON submissions (user_id)",
  "CREATE INDEX IF NOT EXISTS idx_submissions_problem_id ON submissions (problem_id)",
  "CREATE INDEX IF NOT EXISTS idx_submissions_status ON submissions (status)",
  "CREATE INDEX IF NOT EXISTS idx_submissions_created_at ON submissions (created_at)",
  "CREATE INDEX IF NOT EXISTS idx_submissions_user_id_created_at ON submissions (user_id, created_at)",
  "CREATE UNIQUE INDEX IF NOT EXISTS idx_eval_results_submission_id ON evaluation_results (submission_id)",
  "CREATE INDEX IF NOT EXISTS idx_eval_results_created_at ON evaluation_results (created_at)",
  "CREATE INDEX IF NOT EXISTS idx_password_reset_tokens_user_id ON password_reset_tokens (user_id)",
  "CREATE INDEX IF NOT EXISTS idx_password_reset_tokens_expires_at ON password_reset_tokens (expires_at)",
  "CREATE INDEX IF NOT EXISTS idx_conversations_user1_id ON conversations (user1_id)",
  "CREATE INDEX IF NOT EXISTS idx_conversations_user2_id ON conversations (user2_id)",
  "CREATE INDEX IF NOT EXISTS idx_conversations_last_message_at ON conversations (last_message_at)",
  "CREATE INDEX IF NOT EXISTS idx_messages_conversation_created ON messages (conversation_id, created_at)",
  "CREATE INDEX IF NOT EXISTS idx_messages_sender_id ON messages (sender_id)",
  "CREATE INDEX IF NOT EXISTS idx_message_deletions_message_id ON message_deletions (message_id)",
  "CREATE INDEX IF NOT EXISTS idx_system_settings_updated_at ON system_settings (updated_at DESC)",
  "CREATE INDEX IF NOT EXISTS audit_logs_admin_id_idx ON audit_logs (admin_id)",
  "CREATE INDEX IF NOT EXISTS audit_logs_created_at_idx ON audit_logs (created_at)",
  "CREATE INDEX IF NOT EXISTS audit_logs_action_idx ON audit_logs (action)",
  "CREATE INDEX IF NOT EXISTS idx_ip_bans_ip_or_cidr ON ip_bans (ip_or_cidr)",
  "CREATE INDEX IF NOT EXISTS idx_ip_bans_expires_at ON ip_bans (expires_at)",
  "CREATE INDEX IF NOT EXISTS idx_user_bans_user ON user_bans (user_id)",
  "CREATE INDEX IF NOT EXISTS idx_user_bans_active ON user_bans (user_id) WHERE unbanned_at IS NULL",
];

export const ALL_TABLES = [
  "users",
  "problems",
  "judge_images",
  "categories",
  "problems_categories",
  "submissions",
  "evaluation_results",
  "check_ins",
  "password_reset_tokens",
  "conversations",
  "messages",
  "conversation_reads",
  "message_deletions",
  "system_settings",
  "audit_logs",
  "ip_bans",
  "user_bans",
] as const;
