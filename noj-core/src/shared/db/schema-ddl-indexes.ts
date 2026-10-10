/**
 * PGlite 测试用索引 DDL——从 `schema-ddl.ts` 拆出，保持单文件规模在棘轮阈值内
 * （见 `scripts/check-file-size.ts`）。索引语句没有任何跨表顺序约束（都在建表之后
 * 执行），因此可以独立成模块；`schema-ddl.ts` 继续 re-export，调用方无需改动。
 */

export const SCHEMA_INDEXES: string[] = [
  "CREATE INDEX IF NOT EXISTS idx_oauth_accounts_user_id ON oauth_accounts (user_id)",
  // issue #100：search_vector GIN 索引（schema-ddl 用于 PGlite 模式测试）
  "CREATE INDEX IF NOT EXISTS idx_users_search_vector ON users USING GIN (search_vector)",
  "CREATE INDEX IF NOT EXISTS idx_problems_search_vector ON problems USING GIN (search_vector)",
  // NOJ-083：社区搜索 FTS 表达式索引（与 drizzle/0039_community_search_index.sql 同步）
  "CREATE INDEX IF NOT EXISTS idx_community_posts_search_fts ON community_posts USING GIN (to_tsvector('simple', coalesce(title, '') || ' ' || content))",
  "CREATE UNIQUE INDEX IF NOT EXISTS problems_type_number_unique ON problems (type, number)",
  "CREATE INDEX IF NOT EXISTS idx_submissions_user_id ON submissions (user_id)",
  "CREATE INDEX IF NOT EXISTS idx_submissions_problem_accepted_user ON submissions (problem_id, is_accepted, user_id)",
  "CREATE INDEX IF NOT EXISTS idx_submissions_problem_valid_user ON submissions (problem_id, is_valid, user_id)",
  "CREATE INDEX IF NOT EXISTS idx_submissions_contest_valid_user ON submissions (contest_id, problem_id, is_contest_valid, user_id)",
  "CREATE INDEX IF NOT EXISTS idx_submissions_problem_id ON submissions (problem_id)",
  "CREATE INDEX IF NOT EXISTS idx_submissions_status ON submissions (status)",
  "CREATE INDEX IF NOT EXISTS idx_submissions_created_at ON submissions (created_at)",
  "CREATE INDEX IF NOT EXISTS idx_submissions_user_id_created_at ON submissions (user_id, created_at)",
  "CREATE INDEX IF NOT EXISTS idx_submissions_contest_id ON submissions (contest_id)",
  "CREATE INDEX IF NOT EXISTS idx_submissions_contest_problem_user ON submissions (contest_id, problem_id, user_id, created_at)",
  "CREATE INDEX IF NOT EXISTS idx_contests_created_by ON contests (created_by)",
  "CREATE INDEX IF NOT EXISTS idx_contests_start_time ON contests (start_time)",
  "CREATE INDEX IF NOT EXISTS idx_contests_end_time ON contests (end_time)",
  "CREATE INDEX IF NOT EXISTS idx_contest_clarifications_contest ON contest_clarifications (contest_id, created_at)",
  "CREATE INDEX IF NOT EXISTS idx_contest_ranking_snapshots_contest_created ON contest_ranking_snapshots (contest_id, created_at)",
  "CREATE INDEX IF NOT EXISTS idx_contest_participants_user ON contest_participants (user_id)",
  // 题单索引（issue #224）
  "CREATE INDEX IF NOT EXISTS idx_trainings_visibility_pinned_created ON trainings (visibility, is_pinned, created_at)",
  "CREATE INDEX IF NOT EXISTS idx_trainings_created_by ON trainings (created_by)",
  "CREATE INDEX IF NOT EXISTS idx_training_problems_training_position ON training_problems (training_id, position)",
  // 客观题表索引（与 schema.ts 定义一致，PGlite 测试模式）
  "CREATE INDEX IF NOT EXISTS idx_objective_submissions_paper_id ON objective_submissions (paper_id)",
  // 公告公开列表查询索引（与 schema.ts 定义一致，PGlite 测试模式）
  "CREATE INDEX IF NOT EXISTS idx_announcements_active_pinned_created ON announcements (is_active, is_pinned, created_at)",
  // SSE 事件索引（与 schema.ts 定义一致，PGlite 测试模式）
  "CREATE INDEX IF NOT EXISTS idx_sse_events_channel_id ON sse_events (channel, id)",
  "CREATE INDEX IF NOT EXISTS idx_objective_submissions_user_id ON objective_submissions (user_id)",
  "CREATE INDEX IF NOT EXISTS idx_objective_submissions_user_paper_created ON objective_submissions (user_id, paper_id, created_at)",
  "CREATE INDEX IF NOT EXISTS idx_objective_submissions_contest_id ON objective_submissions (contest_id)",
  "CREATE INDEX IF NOT EXISTS idx_objective_submissions_paper_accepted_user ON objective_submissions (paper_id, is_accepted, user_id)",
  "CREATE INDEX IF NOT EXISTS idx_objective_submissions_paper_valid_user ON objective_submissions (paper_id, is_valid, user_id)",
  "CREATE INDEX IF NOT EXISTS idx_objective_submissions_contest_valid_user ON objective_submissions (contest_id, paper_id, is_contest_valid, user_id)",
  // LLM 网关表索引已移交 noj-llm-gateway 管理，PGlite 不再创建
  "CREATE INDEX IF NOT EXISTS idx_self_tests_user_id ON self_tests (user_id)",
  "CREATE INDEX IF NOT EXISTS idx_self_tests_problem_id ON self_tests (problem_id)",
  "CREATE INDEX IF NOT EXISTS idx_self_tests_created_at ON self_tests (created_at)",
  "CREATE INDEX IF NOT EXISTS idx_self_tests_user_id_created_at ON self_tests (user_id, created_at)",
  "CREATE INDEX IF NOT EXISTS idx_self_tests_status_created_at ON self_tests (status, created_at)",
  "CREATE INDEX IF NOT EXISTS idx_password_reset_tokens_user_id ON password_reset_tokens (user_id)",
  "CREATE INDEX IF NOT EXISTS idx_password_reset_tokens_expires_at ON password_reset_tokens (expires_at)",
  "CREATE INDEX IF NOT EXISTS idx_conversations_user1_id ON conversations (user1_id)",
  "CREATE INDEX IF NOT EXISTS idx_conversations_user2_id ON conversations (user2_id)",
  "CREATE INDEX IF NOT EXISTS idx_conversations_last_message_at ON conversations (last_message_at)",
  "CREATE INDEX IF NOT EXISTS idx_messages_conversation_created ON messages (conversation_id, created_at)",
  "CREATE INDEX IF NOT EXISTS idx_messages_sender_id ON messages (sender_id)",
  "CREATE INDEX IF NOT EXISTS idx_message_reactions_message_id ON message_reactions (message_id)",
  "CREATE INDEX IF NOT EXISTS idx_message_deletions_message_id ON message_deletions (message_id)",
  "CREATE INDEX IF NOT EXISTS idx_system_settings_updated_at ON system_settings (updated_at DESC)",
  "CREATE INDEX IF NOT EXISTS audit_logs_admin_id_idx ON audit_logs (admin_id)",
  "CREATE INDEX IF NOT EXISTS audit_logs_created_at_idx ON audit_logs (created_at)",
  "CREATE INDEX IF NOT EXISTS audit_logs_action_idx ON audit_logs (action)",
  "CREATE INDEX IF NOT EXISTS idx_ip_bans_ip_or_cidr ON ip_bans (ip_or_cidr)",
  "CREATE INDEX IF NOT EXISTS idx_ip_bans_expires_at ON ip_bans (expires_at)",
  "CREATE INDEX IF NOT EXISTS idx_user_bans_user ON user_bans (user_id)",
  "CREATE INDEX IF NOT EXISTS idx_user_bans_active ON user_bans (user_id) WHERE unbanned_at IS NULL",
  "CREATE INDEX IF NOT EXISTS idx_email_delivery_events_recipient_hash ON email_delivery_events (recipient_hash)",
  "CREATE INDEX IF NOT EXISTS idx_email_delivery_events_occurred_at ON email_delivery_events (occurred_at)",
  "CREATE INDEX IF NOT EXISTS idx_email_suppressions_recipient_hash ON email_suppressions (recipient_hash)",
  "CREATE UNIQUE INDEX IF NOT EXISTS email_suppressions_active_recipient_unique ON email_suppressions (recipient_hash) WHERE cleared_at IS NULL",
  "CREATE INDEX IF NOT EXISTS idx_email_suppressions_suppressed_at ON email_suppressions (suppressed_at)",
  "CREATE INDEX IF NOT EXISTS idx_community_boards_sort ON community_boards (is_archived, sort_order)",
  "CREATE INDEX IF NOT EXISTS idx_community_board_role_grants_role ON community_board_role_grants (role_id)",
  "CREATE INDEX IF NOT EXISTS idx_community_posts_author ON community_posts (author_id, created_at)",
  "CREATE INDEX IF NOT EXISTS idx_community_posts_problem ON community_posts (problem_id, created_at)",
  "CREATE INDEX IF NOT EXISTS idx_community_posts_board ON community_posts (board_id, created_at)",
  "CREATE INDEX IF NOT EXISTS idx_community_posts_published ON community_posts (type, is_pinned, created_at) WHERE status = 'published'",
  "CREATE INDEX IF NOT EXISTS idx_community_posts_pending ON community_posts (created_at) WHERE status = 'pending'",
  "CREATE INDEX IF NOT EXISTS idx_community_posts_official ON community_posts (problem_id, is_official, created_at)",
  "CREATE INDEX IF NOT EXISTS idx_community_comments_post ON community_comments (post_id, created_at)",
  "CREATE INDEX IF NOT EXISTS idx_community_comments_author ON community_comments (author_id)",
  "CREATE INDEX IF NOT EXISTS idx_community_comments_parent ON community_comments (parent_id)",
  "CREATE INDEX IF NOT EXISTS idx_community_post_likes_user ON community_post_likes (user_id)",
  "CREATE INDEX IF NOT EXISTS idx_community_comment_likes_user ON community_comment_likes (user_id)",
  "CREATE INDEX IF NOT EXISTS idx_community_bookmarks_user ON community_bookmarks (user_id, created_at)",
  "CREATE INDEX IF NOT EXISTS idx_community_follows_followee ON community_follows (followee_id, created_at)",
  "CREATE INDEX IF NOT EXISTS idx_community_reports_pending ON community_reports (created_at) WHERE status = 'pending'",
  "CREATE INDEX IF NOT EXISTS idx_community_reports_reporter ON community_reports (reporter_id)",
  "CREATE INDEX IF NOT EXISTS idx_community_reports_post ON community_reports (post_id)",
  "CREATE INDEX IF NOT EXISTS idx_community_reports_comment ON community_reports (comment_id)",
  "CREATE INDEX IF NOT EXISTS idx_community_reports_message ON community_reports (message_id)",
  "CREATE INDEX IF NOT EXISTS idx_community_moderation_actions_target ON community_moderation_actions (target_type, target_id, created_at)",
  "CREATE INDEX IF NOT EXISTS idx_community_moderation_actions_moderator ON community_moderation_actions (moderator_id)",
  "CREATE INDEX IF NOT EXISTS idx_community_sanctions_active ON community_sanctions (user_id) WHERE revoked_at IS NULL",
  "CREATE INDEX IF NOT EXISTS idx_community_sanctions_creator ON community_sanctions (created_by)",
  "CREATE INDEX IF NOT EXISTS idx_community_notifications_recipient ON community_notifications (recipient_id, created_at)",
  "CREATE INDEX IF NOT EXISTS idx_community_notifications_unread ON community_notifications (recipient_id, created_at) WHERE read_at IS NULL",
  "CREATE INDEX IF NOT EXISTS idx_community_notifications_actor ON community_notifications (actor_id)",
  "CREATE INDEX IF NOT EXISTS idx_community_notifications_post ON community_notifications (post_id)",
  "CREATE INDEX IF NOT EXISTS idx_community_notifications_comment ON community_notifications (comment_id)",
  // content_review_queue 索引（issue #413，与 schema.ts 定义一致）
  "CREATE INDEX IF NOT EXISTS idx_content_review_queue_pending_status ON content_review_queue (status, created_at)",
  "CREATE INDEX IF NOT EXISTS idx_content_review_queue_type_status ON content_review_queue (content_type, status)",
  "CREATE INDEX IF NOT EXISTS idx_content_review_queue_target ON content_review_queue (target_id)",
  // search_entries 索引（与 schema.ts 定义一致，PGlite 测试模式）
  "CREATE UNIQUE INDEX IF NOT EXISTS idx_search_entries_entity ON search_entries (entity_type, entity_id)",
  "CREATE INDEX IF NOT EXISTS idx_search_entries_vector ON search_entries USING GIN (search_vector)",
  "CREATE INDEX IF NOT EXISTS idx_search_entries_owner ON search_entries (owner_id)",
  "CREATE INDEX IF NOT EXISTS idx_search_entries_participants ON search_entries USING GIN (participant_ids)",
  "CREATE INDEX IF NOT EXISTS idx_search_entries_public ON search_entries (is_public)",
  "CREATE INDEX IF NOT EXISTS idx_search_entries_updated ON search_entries (updated_at)",
  "CREATE INDEX IF NOT EXISTS idx_roles_parent_id ON roles (parent_id)",
];

/**
 * PostgreSQL 生产环境中的可选扩展索引。
 *
 * PGlite 测试运行时不打包 pg_trgm 扩展，因此 connection.ts 会尽力执行
 * 这些语句并在扩展不可用时跳过；真实 PostgreSQL 由 0070 迁移强制创建。
 */
export const OPTIONAL_EXTENSION_INDEXES: string[] = [
  "CREATE EXTENSION IF NOT EXISTS pg_trgm",
  "CREATE INDEX IF NOT EXISTS idx_community_posts_title_trgm ON community_posts USING GIN (title gin_trgm_ops)",
  "CREATE INDEX IF NOT EXISTS idx_community_posts_content_trgm ON community_posts USING GIN (content gin_trgm_ops)",
  "CREATE INDEX IF NOT EXISTS idx_search_entries_title_trgm ON search_entries USING GIN (title gin_trgm_ops)",
  "CREATE INDEX IF NOT EXISTS idx_search_entries_body_trgm ON search_entries USING GIN (body gin_trgm_ops)",
];
