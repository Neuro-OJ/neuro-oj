# noj-core 域边界与所有权

> 本文档是 noj-core 代码级域隔离的事实来源。
> 每个域拥有自己的 routes / services / types；跨域只允许通过域门面（`index.ts`）或事件协作。

## 共享层 `src/shared/`

共享层只放“真正跨域复用且无业务归属”的基础设施，**不得反向依赖 `src/domains/**`**。

| 子目录 | 职责 |
|---|---|
| `shared/base/` | 错误体系、日志、常量、日期、SQL 行工具 |
| `shared/config/` | 系统设置注册表、生产配置校验 |
| `shared/db/` | 数据库连接、迁移、Drizzle schema |
| `shared/http/` | 请求体解析、分页、文件流、Hono Env 类型 |
| `shared/mq/` | Redis 连接管理、通用消费者基类 |
| `shared/sse/` | 事件总线、SSE 流、订阅/重放辅助 |
| `shared/rate-limit/` | 通用限流原语（依赖系统设置的限流在 system 域） |
| `shared/security/` | CIDR、公共 ID、图片校验 |
| `shared/middleware/` | 全局 request-context 中间件 |

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
| content-review | `src/domains/content-review/` | 内容审核、DM 私信审核消费者 |

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
| `llm_providers`、`llm_usage`、`llm_quotas` | noj-llm-gateway（同库 public schema，core 不直接读写） |

> 注：`check_ins` 由 identity 域拥有（用户签到）；`sse_events` 由 submission 域拥有（评测/状态事件），未来若作为通用 outbox 再调整为 shared。

## 跨域规则

1. 域 A 不得 import 域 B 的 `services/` 或 `routes/` 深路径。
2. 跨域只能 import `src/domains/<B>/index.ts`（门面）。
3. 共享内核 `src/shared/` 不得反向依赖 `src/domains/**`。
4. `src/domains/<domain>/tests/**` 可跨域深路径导入以构造集成场景；域边界规则只约束生产代码。
