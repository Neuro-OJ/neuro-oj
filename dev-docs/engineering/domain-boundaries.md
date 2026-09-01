# noj-core 域边界与所有权

> 本文档是 noj-core 代码级域隔离的事实来源。
> 每个域拥有自己的 routes / services / types；跨域只允许通过域门面（`index.ts`）或事件协作。

## 域目录

| 域 | 目录（目标） | 主要职责 |
|---|---|---|
| identity | `src/domains/identity/` | 注册/登录、JWT、TFA、密码重置、OAuth、用户资料、RBAC、用户封禁 |
| catalog | `src/domains/catalog/` | 题目、标签、题目包、支持包、题单 |
| objective | `src/domains/objective/` | 客观题套卷、题目、练习提交 |
| submission | `src/domains/submission/` | 提交、评测结果、评测队列、重测、自测、SSE 事件 |
| contest | `src/domains/contest/` | 竞赛、参赛者、题目关联、澄清、榜单 |
| community | `src/domains/community/` | 板块、帖子、评论、点赞、收藏、关注、动态、举报、审核、通知 |
| messaging | `src/domains/messaging/` | 私信、会话、已读、删除 |
| system | `src/domains/system/` | 系统设置、公告、审计日志、IP 封禁、Judge 镜像 |
| gateway | `src/domains/gateway/` | LLM Provider、用量、配额；远期迁入 noj-llm-gateway |
| query | `src/domains/query/` | 搜索、统计、排行榜、Dashboard 等读模型 |

## 遗留服务目录 → 域映射

下列 `src/services/*` 目录/文件在迁移完成前视为对应域的一部分：

| 遗留路径 | 域 |
|---|---|
| `src/services/auth`、`src/services/users`、`src/services/oauth.ts`、`src/services/tfa.ts`、`src/services/passwordReset.ts`、`src/services/banlist.ts`、`src/services/checkin.ts` | identity |
| `src/services/problems`、`src/services/tags.ts`、`src/services/trainings.ts`、`src/services/support-package.ts` | catalog |
| `src/services/submissions`、`src/services/queue.ts`、`src/services/self-tests.ts` | submission |
| `src/services/contest/` | contest |
| `src/services/community/`、`src/services/notifications.ts` | community |
| `src/services/objective/` | objective |
| `src/services/messages.ts` | messaging |
| `src/services/system-settings.ts`、`src/services/announcements.ts`、`src/services/audit-log.ts`、`src/services/seed/` | system |
| `src/services/llm.ts` | gateway |
| `src/services/search.ts`、`src/services/rankings.ts`、`src/services/stats-cache.ts`、`src/services/dashboard.ts` | query |

## 表所有权

| 表 | 域 |
|---|---|
| `users`、`oauth_accounts`、`roles`、`permissions`、`user_roles`、`password_reset_tokens`、`tfa_recovery_codes`、`user_bans` | identity |
| `problems`、`tags`、`problem_tags`、`trainings`、`training_problems` | catalog |
| `objective_questions`、`objective_submissions` | objective |
| `submissions`、`evaluation_results`、`self_tests`、`sse_events` | submission |
| `contests`、`contest_problems`、`contest_participants`、`contest_clarifications` | contest |
| `community_boards`、`community_board_role_grants`、`community_posts`、`community_comments`、`community_post_likes`、`community_comment_likes`、`community_bookmarks`、`community_follows`、`community_activity_events`、`community_reports`、`community_moderation_actions`、`community_sanctions`、`community_notifications` | community |
| `conversations`、`messages`、`conversation_reads`、`message_deletions` | messaging |
| `system_settings`、`announcements`、`audit_logs`、`ip_bans`、`judge_images` | system |
| `llm_providers`、`llm_usage`、`llm_quotas` | gateway |

> 注：`check_ins` 由 identity 域拥有（用户签到）；`sse_events` 由 submission 域拥有（评测/状态事件），未来若作为通用 outbox 再调整为 shared。

## 跨域规则

1. 域 A 不得 import 域 B 的 `services/` 或 `routes/` 深路径。
2. 跨域只能 import `src/domains/<B>/index.ts`（门面）。
3. 共享内核 `src/shared/` 不得反向依赖 `src/domains/**`。
4. 遗留迁移期间，旧 `src/services/<域>` 也按上述规则检查，直到迁移完成。
