## ADDED Requirements

### Requirement: 公告表（announcements）

系统 SHALL 提供 `announcements` 表：

- `id` TEXT PRIMARY KEY（uuid）
- `title` TEXT NOT NULL
- `content` TEXT NOT NULL（Markdown）
- `is_pinned` BOOLEAN NOT NULL DEFAULT FALSE
- `is_active` BOOLEAN NOT NULL DEFAULT TRUE
- `created_by` TEXT NOT NULL REFERENCES `users(id)`
- `created_at` TEXT NOT NULL、`updated_at` TEXT NOT NULL（ISO 8601）

系统 SHALL 为该表创建索引 `idx_announcements_active_pinned_created` ON `(is_active, is_pinned, created_at)`。表与索引通过 Drizzle 迁移（0035）创建，迁移由 `deno task db:generate` 生成，不可手改 `_journal.json`。

#### Scenario: 迁移建表

- **WHEN** 执行 0035 迁移
- **THEN** `announcements` 表与索引创建成功

#### Scenario: 级联行为

- **WHEN** 引用 `users.id` 的 `created_by` 用户被删除
- **THEN** 按既有约束行为处理（`users` 表无级联删除，公告保留，字段为历史记录）
