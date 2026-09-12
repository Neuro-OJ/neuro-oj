# noj-core 域边界与所有权

> 本文档是 noj-core 代码级域隔离的事实来源。 每个域拥有自己的 routes / services
> / types；跨域只允许通过域门面（`index.ts`）或事件协作。

## 共享层 `src/shared/`

共享层只放“真正跨域复用且无业务归属”的基础设施，**不得反向依赖
`src/domains/**`**。

| 子目录                  | 职责                                                                 |
| ----------------------- | -------------------------------------------------------------------- |
| `shared/base/`          | 错误体系、日志、常量、日期、SQL 行工具                               |
| `shared/config/`        | 系统设置注册表、生产配置校验                                         |
| `shared/db/`            | 数据库连接、迁移、Drizzle schema                                     |
| `shared/http/`          | 请求体解析、分页、文件流、Hono Env 类型                              |
| `shared/mq/`            | Redis 连接管理、通用消费者基类                                       |
| `shared/sse/`           | 事件总线、SSE 流、订阅/重放辅助                                      |
| `shared/rate-limit/`    | 通用限流原语（依赖系统设置的限流在 system 域）                       |
| `shared/security/`      | CIDR、公共 ID、图片校验                                              |
| `shared/observability/` | 低层 kernel：指标注册表、写侧契约、日志上下文                        |

> 注：`shared/middleware/` 目录**已删除**（2026-09-10 观测域重构把 request-context
> 中间件迁入 `domains/observability/`），不再保留兼容目录。

## 域目录

| 域             | 目录（目标）                  | 主要职责                                                                      |
| -------------- | ----------------------------- | ----------------------------------------------------------------------------- |
| identity       | `src/domains/identity/`       | 注册/登录、JWT、TFA、密码重置、OAuth、用户资料、RBAC、用户封禁                |
| catalog        | `src/domains/catalog/`        | 题目、标签、题目包、支持包、题单                                              |
| objective      | `src/domains/objective/`      | 客观题套卷、题目、练习提交                                                    |
| submission     | `src/domains/submission/`     | 提交、评测结果、评测队列、重测、自测、SSE 事件                                |
| contest        | `src/domains/contest/`        | 竞赛、参赛者、题目关联、澄清、榜单                                            |
| community      | `src/domains/community/`      | 板块、帖子、评论、点赞、收藏、关注、动态、举报、审核、通知                    |
| messaging      | `src/domains/messaging/`      | 私信、会话、已读、删除                                                        |
| system         | `src/domains/system/`         | 系统设置、公告、审计日志、IP 封禁、Judge 镜像                                 |
| gateway        | `src/domains/gateway/`        | LLM Provider、用量、配额；远期迁入 noj-llm-gateway                            |
| query          | `src/domains/query/`          | 搜索、统计、排行榜、Dashboard 等读模型                                        |
| content-review | `src/domains/content-review/` | 内容审核、DM 私信审核消费者                                                   |
| observability  | `src/domains/observability/`  | 平台指标、探针、快照聚合、健康/指标路由、Judge 心跳、SLO、外部运行时契约 |

## 表所有权

| 表                                                                                                                                                                                                                                                                                                                            | 域                                                     |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------ |
| `users`、`oauth_accounts`、`roles`、`permissions`、`user_roles`、`password_reset_tokens`、`tfa_recovery_codes`、`user_bans`                                                                                                                                                                                                   | identity                                               |
| `problems`、`tags`、`problem_tags`、`trainings`、`training_problems`                                                                                                                                                                                                                                                          | catalog                                                |
| `objective_questions`、`objective_submissions`                                                                                                                                                                                                                                                                                | objective                                              |
| `submissions`、`evaluation_results`、`self_tests`、`sse_events`                                                                                                                                                                                                                                                               | submission                                             |
| `contests`、`contest_problems`、`contest_participants`、`contest_clarifications`                                                                                                                                                                                                                                              | contest                                                |
| `community_boards`、`community_board_role_grants`、`community_posts`、`community_comments`、`community_post_likes`、`community_comment_likes`、`community_bookmarks`、`community_follows`、`community_activity_events`、`community_reports`、`community_moderation_actions`、`community_sanctions`、`community_notifications` | community                                              |
| `conversations`、`messages`、`conversation_reads`、`message_deletions`                                                                                                                                                                                                                                                        | messaging                                              |
| `system_settings`、`announcements`、`audit_logs`、`ip_bans`、`judge_images`                                                                                                                                                                                                                                                   | system                                                 |
| `llm_providers`、`llm_usage`、`llm_quotas`                                                                                                                                                                                                                                                                                    | noj-llm-gateway（同库 public schema，core 不直接读写） |

> 注：`check_ins` 由 identity 域拥有（用户签到）；`sse_events` 由 submission
> 域拥有（评测/状态事件），未来若作为通用 outbox 再调整为 shared。

## 跨域规则

1. 域 A 不得 import 域 B 的 `services/` 或 `routes/` 深路径。
2. 跨域只能 import `src/domains/<B>/index.ts`（门面）。
3. 共享内核 `src/shared/` 不得反向依赖 `src/domains/**`。
4. `src/domains/<domain>/tests/**`
   可跨域深路径导入以构造集成场景；域边界规则只约束生产代码。
5. 业务域可 import
   `src/domains/observability/write.ts`（写侧门面），但不得深路径 import
   观测域的 `services/`、`routes/`、`metrics/`。
6. `domains/admin` 可 import `src/domains/observability/index.ts`
   （历史上用于挂载观测管理路由；该管理端点已于 2026-09-10 移除，
   故当前**没有任何代码使用此例外**，它仅作为规则保留，避免未来需要时再开口子）。
   **其他业务域不享受该例外**——观测域的 `index.ts` 是受限门面。
7. `domains/observability` 不得 import 任何其他业务域；聚合通过 `app.ts`
   组合根注入 provider 完成。

> 规则 5/6 由 `scripts/check-domains.ts` 强制执行：
> `PUBLIC_SUBPATHS.observability = ["write.ts"]`、`INDEX_IMPORT_RESTRICTED.observability = ["admin"]`。
> 回归用例见 `scripts/check-domains_test.ts`。

## 多副本约束（2026-09-12 架构评审 §2.6）

**当前部署为单副本**（`docker-compose.prod.yml` 未声明 `deploy.replicas`），
但代码中仍存在若干**进程内可变状态**。在水平扩展（K8s 化）之前，新增此类状态
必须显式标注"单副本专用"，否则应改为 Redis/DB 承载。

| 位置 | 状态 | 多副本后果 | 现状 |
| --- | --- | --- | --- |
| `domains/system/services/system-settings.ts` | 配置缓存 `Map` | A 副本改设置，B 副本读到旧值 | **已修**：变更广播 `noj:events:settings`，各副本重新加载（见下） |
| `domains/query/services/stats-cache.ts` | 站点统计计数器 | `/stats` 随负载均衡抖动 | 单副本专用（未修） |
| `domains/submission/mq/sweeper.ts` | `_firstSeen`/`_lastRequeue` | 重复重投判定失准，可能双份投递 | 单副本专用（重投本身 at-least-once 幂等） |
| `domains/identity/.../banCache.ts` | 封禁缓存（60s TTL） | 封禁生效延迟不一致（最长 60s） | 单副本专用（TTL 兜底） |
| `domains/system/middleware/rate-limit.ts` | 限流计数 | 阈值被放大 N 倍 | 单副本专用（文件内已注明） |
| `domains/query/services/rankings.ts` | 物化视图刷新节流 | 各副本各刷一次 | 单副本专用 |

**跨副本失效的正确做法（务必注意）**：`getSetting()` 在缓存未命中时**不回查 DB**，
而是走 env → default 兜底链。因此失效必须是**重新加载**（`refreshSettingsCache()`，
先读 DB 再原子替换缓存），**不能只 `cache.delete()`** —— 只删缓存会让副本读到默认值
而非真实新值。回归用例：
`domains/system/tests/services/system-settings-invalidation.test.ts`。

新增设置项/新配置读取方无需额外适配：只要走 `getSetting()`，就会自动获得该失效通道。

