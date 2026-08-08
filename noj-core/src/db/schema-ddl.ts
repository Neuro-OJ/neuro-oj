/**
 * Schema DDL SQL 字符串——与 src/db/schema.ts 同步。
 *
 * 供 PGlite 模式在测试中建表使用。当 Drizzle schema 变更时需同步更新此文件。
 */
export const SCHEMA_DDL: string[] = [
  // 1. users（issue #100：含 search_vector 列供 PGlite 模式测试）
  `CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    username TEXT NOT NULL UNIQUE,
    email TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'user',
    bio TEXT NOT NULL DEFAULT '',
    must_change_password BOOLEAN NOT NULL DEFAULT false,
    community_activity_visibility TEXT NOT NULL DEFAULT 'following'
      CHECK (community_activity_visibility IN ('hidden', 'following', 'everyone')),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    search_vector tsvector GENERATED ALWAYS AS (
      setweight(to_tsvector('simple', coalesce(username, '')), 'A') ||
      setweight(to_tsvector('simple', coalesce(email, '')), 'B')
    ) STORED
  )`,

  // 2. roles（依赖预置：community 表与 RBAC 表均引用，需先于二者建表）
  `CREATE TABLE IF NOT EXISTS roles (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL UNIQUE,
    description TEXT NOT NULL DEFAULT '',
    is_system BOOLEAN NOT NULL DEFAULT false,
    is_default BOOLEAN NOT NULL DEFAULT false,
    is_admin BOOLEAN NOT NULL DEFAULT false,
    parent_id TEXT REFERENCES roles(id) ON DELETE SET NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,

  // 3. problems（issue #100：含 search_vector 列供 PGlite 模式测试）
  `CREATE TABLE IF NOT EXISTS problems (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    description TEXT NOT NULL,
    difficulty TEXT NOT NULL DEFAULT 'medium',
    support_package_storage_url TEXT,
    runtime_config JSONB CHECK (jsonb_typeof(runtime_config) = 'object'),
    number INTEGER NOT NULL,
    owner_id TEXT NOT NULL DEFAULT '0',
    type TEXT NOT NULL DEFAULT 'U' CHECK (type IN ('U', 'P')),
    is_objective BOOLEAN NOT NULL DEFAULT false,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    search_vector tsvector GENERATED ALWAYS AS (
      setweight(to_tsvector('simple', coalesce(title, '')), 'A') ||
      setweight(to_tsvector('simple',
        coalesce(type, '') || ' ' || coalesce(number::text, '')
      ), 'B')
    ) STORED
  )`,

  // 3.1 objective_questions（客观题小题，必须绑定套卷）
  `CREATE TABLE IF NOT EXISTS objective_questions (
    id TEXT PRIMARY KEY,
    paper_id TEXT NOT NULL REFERENCES problems(id) ON DELETE CASCADE,
    sort_order INTEGER NOT NULL DEFAULT 0,
    type TEXT NOT NULL CHECK (type IN ('single', 'multiple', 'judge')),
    prompt TEXT NOT NULL,
    options JSONB NOT NULL DEFAULT '[]',
    answer JSONB NOT NULL,
    explanation TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE (paper_id, sort_order)
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

  `CREATE TABLE IF NOT EXISTS contests (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    start_time TEXT NOT NULL,
    end_time TEXT NOT NULL,
    type TEXT NOT NULL CHECK (type IN ('icpc', 'ioi', 'oi')),
    config JSONB NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(config) = 'object'),
    is_public BOOLEAN NOT NULL DEFAULT true,
    password TEXT,
    affect_global_ranking BOOLEAN NOT NULL DEFAULT false,
    created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
    announcement TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    CHECK (end_time > start_time)
  )`,

  `CREATE TABLE IF NOT EXISTS contest_problems (
    contest_id TEXT NOT NULL REFERENCES contests(id) ON DELETE CASCADE,
    problem_id TEXT NOT NULL REFERENCES problems(id) ON DELETE CASCADE,
    sort_order INTEGER NOT NULL DEFAULT 0,
    label TEXT NOT NULL,
    score INTEGER,
    PRIMARY KEY (contest_id, problem_id),
    UNIQUE (contest_id, label),
    UNIQUE (contest_id, sort_order)
  )`,

  `CREATE TABLE IF NOT EXISTS contest_participants (
    contest_id TEXT NOT NULL REFERENCES contests(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    registered_at TEXT NOT NULL,
    PRIMARY KEY (contest_id, user_id)
  )`,

  // 3.3 objective_submissions（客观题提交，服务端即时判定；依赖 contests 表）
  `CREATE TABLE IF NOT EXISTS objective_submissions (
    id TEXT PRIMARY KEY,
    paper_id TEXT NOT NULL REFERENCES problems(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL REFERENCES users(id),
    contest_id TEXT REFERENCES contests(id) ON DELETE SET NULL,
    submission_type TEXT NOT NULL CHECK (submission_type IN ('practice', 'contest')),
    answers JSONB NOT NULL,
    status TEXT NOT NULL DEFAULT 'finished',
    score INTEGER NOT NULL DEFAULT 0,
    details JSONB NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL,
    UNIQUE (paper_id, user_id, contest_id)
  )`,

  `CREATE TABLE IF NOT EXISTS contest_clarifications (
    id TEXT PRIMARY KEY,
    contest_id TEXT NOT NULL REFERENCES contests(id) ON DELETE CASCADE,
    problem_id TEXT REFERENCES problems(id) ON DELETE SET NULL,
    sender_id TEXT NOT NULL REFERENCES users(id),
    content TEXT NOT NULL,
    reply_to_id TEXT REFERENCES contest_clarifications(id),
    is_public BOOLEAN NOT NULL DEFAULT false,
    created_at TEXT NOT NULL
  )`,

  // 6. submissions
  `CREATE TABLE IF NOT EXISTS submissions (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id),
    problem_id TEXT NOT NULL REFERENCES problems(id),
    contest_id TEXT REFERENCES contests(id) ON DELETE SET NULL,
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

  // 15. audit_logs (issue #101 + PR-2)
  `CREATE TABLE IF NOT EXISTS audit_logs (
    id TEXT PRIMARY KEY,
    -- PR-2：admin_id 改为 nullable——auth.* 事件可能无 actor（登录失败等）
    admin_id TEXT REFERENCES users(id),
    action TEXT NOT NULL,
    target_type TEXT,
    target_id TEXT,
    detail JSONB NOT NULL DEFAULT '{}',
    ip_address TEXT NOT NULL,
    created_at TEXT NOT NULL,
    CONSTRAINT audit_logs_action_check CHECK (action IN (
      'users.role_change','users.ban','users.unban',
      'problems.delete','categories.delete','submissions.rejudge','settings.update',
      'ip_ban.create','ip_ban.delete',
      -- PR-2 新增 auth.* 动作
      'auth.login_success','auth.login_failure','auth.register',
      'auth.change_password','auth.forgot_password_request','auth.password_reset',
      'community.post_moderated','community.report_resolved',
      'community.sanction_created','community.sanction_revoked','community.preset_applied',
      'announcement.create','announcement.update','announcement.delete')
    ))
  `,

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

  // 社区表依赖 RBAC 角色（roles 已在顶部预置，见 SCHEMA_DDL 第 2 项）

  `CREATE TABLE IF NOT EXISTS community_boards (
    id TEXT PRIMARY KEY,
    slug TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    sort_order INTEGER NOT NULL DEFAULT 0,
    is_archived BOOLEAN NOT NULL DEFAULT false,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,

  `CREATE TABLE IF NOT EXISTS community_board_role_grants (
    board_id TEXT NOT NULL REFERENCES community_boards(id) ON DELETE CASCADE,
    role_id TEXT NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
    can_read BOOLEAN NOT NULL DEFAULT true,
    can_post BOOLEAN NOT NULL DEFAULT false,
    can_moderate BOOLEAN NOT NULL DEFAULT false,
    PRIMARY KEY (board_id, role_id)
  )`,

  `CREATE TABLE IF NOT EXISTS community_posts (
    id TEXT PRIMARY KEY,
    type TEXT NOT NULL CHECK (type IN ('solution', 'discussion', 'moment')),
    author_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    problem_id TEXT REFERENCES problems(id) ON DELETE CASCADE,
    board_id TEXT REFERENCES community_boards(id) ON DELETE SET NULL,
    title TEXT,
    content TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'published'
      CHECK (status IN ('draft', 'pending', 'published', 'hidden', 'deleted')),
    is_locked BOOLEAN NOT NULL DEFAULT false,
    is_pinned BOOLEAN NOT NULL DEFAULT false,
    moderation_reason TEXT,
    published_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    CHECK (
      (type = 'solution' AND problem_id IS NOT NULL AND board_id IS NULL AND title IS NOT NULL)
      OR (type = 'discussion' AND board_id IS NOT NULL AND problem_id IS NULL AND title IS NOT NULL)
      OR (type = 'moment' AND problem_id IS NULL AND board_id IS NULL AND title IS NULL)
    )
  )`,

  `CREATE TABLE IF NOT EXISTS community_comments (
    id TEXT PRIMARY KEY,
    post_id TEXT NOT NULL REFERENCES community_posts(id) ON DELETE CASCADE,
    author_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    parent_id TEXT REFERENCES community_comments(id) ON DELETE CASCADE,
    content TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'published'
      CHECK (status IN ('pending', 'published', 'hidden', 'deleted')),
    moderation_reason TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,

  `CREATE TABLE IF NOT EXISTS community_post_likes (
    post_id TEXT NOT NULL REFERENCES community_posts(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at TEXT NOT NULL,
    PRIMARY KEY (post_id, user_id)
  )`,

  `CREATE TABLE IF NOT EXISTS community_comment_likes (
    comment_id TEXT NOT NULL REFERENCES community_comments(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at TEXT NOT NULL,
    PRIMARY KEY (comment_id, user_id)
  )`,

  `CREATE TABLE IF NOT EXISTS community_bookmarks (
    post_id TEXT NOT NULL REFERENCES community_posts(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at TEXT NOT NULL,
    PRIMARY KEY (post_id, user_id)
  )`,

  `CREATE TABLE IF NOT EXISTS community_follows (
    follower_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    followee_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at TEXT NOT NULL,
    PRIMARY KEY (follower_id, followee_id),
    CHECK (follower_id <> followee_id)
  )`,

  `CREATE TABLE IF NOT EXISTS community_activity_events (
    id TEXT PRIMARY KEY,
    actor_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    type TEXT NOT NULL CHECK (type IN ('first_accepted', 'solution_published', 'contest_joined')),
    subject_type TEXT NOT NULL,
    subject_id TEXT NOT NULL,
    metadata JSONB NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL,
    UNIQUE (actor_id, type, subject_type, subject_id)
  )`,

  `CREATE TABLE IF NOT EXISTS community_reports (
    id TEXT PRIMARY KEY,
    reporter_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    post_id TEXT REFERENCES community_posts(id) ON DELETE SET NULL,
    comment_id TEXT REFERENCES community_comments(id) ON DELETE SET NULL,
    reason TEXT NOT NULL,
    content_snapshot TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'resolved', 'dismissed')),
    resolution TEXT,
    resolved_by TEXT REFERENCES users(id) ON DELETE SET NULL,
    resolved_at TEXT,
    created_at TEXT NOT NULL,
    CHECK (num_nonnulls(post_id, comment_id) = 1)
  )`,

  `CREATE TABLE IF NOT EXISTS community_moderation_actions (
    id TEXT PRIMARY KEY,
    moderator_id TEXT REFERENCES users(id) ON DELETE SET NULL,
    action TEXT NOT NULL,
    target_type TEXT NOT NULL,
    target_id TEXT NOT NULL,
    reason TEXT NOT NULL DEFAULT '',
    metadata JSONB NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL
  )`,

  `CREATE TABLE IF NOT EXISTS community_sanctions (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    reason TEXT NOT NULL,
    expires_at TEXT,
    created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
    created_at TEXT NOT NULL,
    revoked_at TEXT,
    revoked_by TEXT REFERENCES users(id) ON DELETE SET NULL
  )`,

  `CREATE TABLE IF NOT EXISTS community_notifications (
    id TEXT PRIMARY KEY,
    recipient_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    actor_id TEXT REFERENCES users(id) ON DELETE SET NULL,
    type TEXT NOT NULL CHECK (type IN ('reply', 'like', 'follow', 'moderation')),
    post_id TEXT REFERENCES community_posts(id) ON DELETE SET NULL,
    comment_id TEXT REFERENCES community_comments(id) ON DELETE SET NULL,
    data JSONB NOT NULL DEFAULT '{}',
    read_at TEXT,
    created_at TEXT NOT NULL
  )`,

  // 18. announcements (issue #231)
  `CREATE TABLE IF NOT EXISTS announcements (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    content TEXT NOT NULL,
    is_pinned BOOLEAN NOT NULL DEFAULT false,
    is_active BOOLEAN NOT NULL DEFAULT true,
    created_by TEXT NOT NULL REFERENCES users(id),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,
];

export const SCHEMA_INDEXES: string[] = [
  // issue #100：search_vector GIN 索引（schema-ddl 用于 PGlite 模式测试）
  "CREATE INDEX IF NOT EXISTS idx_users_search_vector ON users USING GIN (search_vector)",
  "CREATE INDEX IF NOT EXISTS idx_problems_search_vector ON problems USING GIN (search_vector)",
  "CREATE UNIQUE INDEX IF NOT EXISTS problems_type_number_unique ON problems (type, number)",
  "CREATE INDEX IF NOT EXISTS idx_submissions_user_id ON submissions (user_id)",
  "CREATE INDEX IF NOT EXISTS idx_submissions_problem_id ON submissions (problem_id)",
  "CREATE INDEX IF NOT EXISTS idx_submissions_status ON submissions (status)",
  "CREATE INDEX IF NOT EXISTS idx_submissions_created_at ON submissions (created_at)",
  "CREATE INDEX IF NOT EXISTS idx_submissions_user_id_created_at ON submissions (user_id, created_at)",
  "CREATE INDEX IF NOT EXISTS idx_submissions_contest_id ON submissions (contest_id)",
  "CREATE INDEX IF NOT EXISTS idx_submissions_contest_problem_user ON submissions (contest_id, problem_id, user_id, created_at)",
  "CREATE INDEX IF NOT EXISTS idx_contests_created_by ON contests (created_by)",
  "CREATE INDEX IF NOT EXISTS idx_contests_start_time ON contests (start_time)",
  "CREATE INDEX IF NOT EXISTS idx_contests_end_time ON contests (end_time)",
  "CREATE INDEX IF NOT EXISTS idx_contest_participants_user ON contest_participants (user_id)",
  // 客观题表索引（与 schema.ts 定义一致，PGlite 测试模式）
  "CREATE INDEX IF NOT EXISTS idx_objective_questions_paper_id ON objective_questions (paper_id)",
  "CREATE INDEX IF NOT EXISTS idx_objective_submissions_paper_id ON objective_submissions (paper_id)",
  // 公告公开列表查询索引（与 schema.ts 定义一致，PGlite 测试模式）
  "CREATE INDEX IF NOT EXISTS idx_announcements_active_pinned_created ON announcements (is_active, is_pinned, created_at)",
  "CREATE INDEX IF NOT EXISTS idx_objective_submissions_user_id ON objective_submissions (user_id)",
  "CREATE INDEX IF NOT EXISTS idx_objective_submissions_user_paper_created ON objective_submissions (user_id, paper_id, created_at)",
  "CREATE INDEX IF NOT EXISTS idx_objective_submissions_contest_id ON objective_submissions (contest_id)",
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
  "CREATE INDEX IF NOT EXISTS idx_community_boards_sort ON community_boards (is_archived, sort_order)",
  "CREATE INDEX IF NOT EXISTS idx_community_board_role_grants_role ON community_board_role_grants (role_id)",
  "CREATE INDEX IF NOT EXISTS idx_community_posts_author ON community_posts (author_id, created_at)",
  "CREATE INDEX IF NOT EXISTS idx_community_posts_problem ON community_posts (problem_id, created_at)",
  "CREATE INDEX IF NOT EXISTS idx_community_posts_board ON community_posts (board_id, created_at)",
  "CREATE INDEX IF NOT EXISTS idx_community_posts_published ON community_posts (type, is_pinned, created_at) WHERE status = 'published'",
  "CREATE INDEX IF NOT EXISTS idx_community_posts_pending ON community_posts (created_at) WHERE status = 'pending'",
  "CREATE INDEX IF NOT EXISTS idx_community_comments_post ON community_comments (post_id, created_at)",
  "CREATE INDEX IF NOT EXISTS idx_community_comments_author ON community_comments (author_id)",
  "CREATE INDEX IF NOT EXISTS idx_community_comments_parent ON community_comments (parent_id)",
  "CREATE INDEX IF NOT EXISTS idx_community_post_likes_user ON community_post_likes (user_id)",
  "CREATE INDEX IF NOT EXISTS idx_community_comment_likes_user ON community_comment_likes (user_id)",
  "CREATE INDEX IF NOT EXISTS idx_community_bookmarks_user ON community_bookmarks (user_id, created_at)",
  "CREATE INDEX IF NOT EXISTS idx_community_follows_followee ON community_follows (followee_id, created_at)",
  "CREATE INDEX IF NOT EXISTS idx_community_activity_events_actor ON community_activity_events (actor_id, created_at)",
  "CREATE INDEX IF NOT EXISTS idx_community_reports_pending ON community_reports (created_at) WHERE status = 'pending'",
  "CREATE INDEX IF NOT EXISTS idx_community_reports_reporter ON community_reports (reporter_id)",
  "CREATE INDEX IF NOT EXISTS idx_community_reports_post ON community_reports (post_id)",
  "CREATE INDEX IF NOT EXISTS idx_community_reports_comment ON community_reports (comment_id)",
  "CREATE INDEX IF NOT EXISTS idx_community_moderation_actions_target ON community_moderation_actions (target_type, target_id, created_at)",
  "CREATE INDEX IF NOT EXISTS idx_community_moderation_actions_moderator ON community_moderation_actions (moderator_id)",
  "CREATE INDEX IF NOT EXISTS idx_community_sanctions_active ON community_sanctions (user_id) WHERE revoked_at IS NULL",
  "CREATE INDEX IF NOT EXISTS idx_community_sanctions_creator ON community_sanctions (created_by)",
  "CREATE INDEX IF NOT EXISTS idx_community_notifications_recipient ON community_notifications (recipient_id, created_at)",
  "CREATE INDEX IF NOT EXISTS idx_community_notifications_unread ON community_notifications (recipient_id, created_at) WHERE read_at IS NULL",
  "CREATE INDEX IF NOT EXISTS idx_community_notifications_actor ON community_notifications (actor_id)",
  "CREATE INDEX IF NOT EXISTS idx_community_notifications_post ON community_notifications (post_id)",
  "CREATE INDEX IF NOT EXISTS idx_community_notifications_comment ON community_notifications (comment_id)",
  // RBAC 权限系统（roles 表已在顶部预置，见 SCHEMA_DDL 第 2 项）
  `CREATE TABLE IF NOT EXISTS permissions (
    id TEXT PRIMARY KEY,
    resource TEXT NOT NULL,
    action TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    UNIQUE (resource, action)
  )`,
  `CREATE TABLE IF NOT EXISTS role_permissions (
    role_id TEXT NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
    permission_id TEXT NOT NULL REFERENCES permissions(id) ON DELETE CASCADE,
    PRIMARY KEY (role_id, permission_id)
  )`,
  `CREATE TABLE IF NOT EXISTS user_roles (
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    role_id TEXT NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
    PRIMARY KEY (user_id, role_id)
  )`,
  "CREATE INDEX IF NOT EXISTS idx_roles_parent_id ON roles (parent_id)",
];

export const ALL_TABLES = [
  "users",
  "problems",
  "judge_images",
  "categories",
  "problems_categories",
  "contests",
  "contest_problems",
  "contest_participants",
  "contest_clarifications",
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
  "roles",
  "permissions",
  "role_permissions",
  "user_roles",
  "community_boards",
  "community_board_role_grants",
  "community_posts",
  "community_comments",
  "community_post_likes",
  "community_comment_likes",
  "community_bookmarks",
  "community_follows",
  "community_activity_events",
  "community_reports",
  "community_moderation_actions",
  "community_sanctions",
  "community_notifications",
  "announcements",
] as const;
