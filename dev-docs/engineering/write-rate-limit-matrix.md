# NOJ 写操作限流矩阵

> 目标：让“写操作默认有速率限制”成为可审计、可维护的工程事实，避免新增端点时漏加。
> 本文档是 **A3 限流/写操作系统矩阵** 的落地记录与维护入口。

## 限流原语

- **登录限流**：`noj-core/src/domains/identity/middleware/login-rate-limit.ts`，专用于认证端点。
- **通用中间件限流**：`noj-core/src/domains/system/middleware/rate-limit.ts`，进程内最小间隔限流（多实例各自计数）。
- **Hardening
  限流（推荐）**：`noj-core/src/modules/platform/system/services/hardening-rate-limit.ts`，Redis
  固定窗口，适合高价值/批量写操作。Redis 不可用时默认
  fail-closed（503）；社区互动、 教学写操作与创建题目显式传 `"allow"`
  放行并记告警（见下文「Redis 故障策略」）。
- **服务层频率限制**：部分业务（社区发帖）在服务层按配置间隔限流，见
  `community-post-crud.ts`。

## 已覆盖写操作

| 操作                                       | 路由                                                                                       | 限流方式                                                      | 阈值                                                            |
| ------------------------------------------ | ------------------------------------------------------------------------------------------ | ------------------------------------------------------------- | --------------------------------------------------------------- |
| 注册                                       | `POST /auth/register`                                                                      | hardening IP                                                  | 1h/100                                                          |
| 重发验证邮件                               | `POST /auth/email/resend`                                                                  | hardening IP + user；服务层冷却兜底                           | 60s/1                                                           |
| 忘记密码                                   | `POST /auth/forgot-password`                                                               | hardening IP + email                                          | IP 1h/30；email 1h/10                                           |
| 重置密码                                   | `POST /auth/reset-password`                                                                | hardening IP + email                                          | 同上                                                            |
| 修改密码                                   | `POST /auth/change-password`                                                               | 账号限流（loginThrottle）                                     | 独立命名空间                                                    |
| TFA 确认/禁用                              | `POST /auth/tfa/*`                                                                         | 账号限流（loginThrottle）                                     | TFA_NAMESPACE                                                   |
| 私信发送                                   | `POST /conversations/:id/messages`                                                         | hardening user                                                | 60s/60                                                          |
| 代码提交                                   | `POST /submissions`                                                                        | hardening IP+user                                             | IP 60s/7200；user 60s/120                                       |
| 自测                                       | `POST /problems/:id/self-test`                                                             | hardening IP+user                                             | IP 60s/240；user 60s/4                                          |
| 竞赛提交                                   | `POST /contests/:id/submit`                                                                | hardening IP+user                                             | IP 60s/7200；user 60s/120                                       |
| 客观题提交                                 | `POST /problems/:id/submit`（objective）                                                   | hardening IP+user                                             | IP 60s/3600；user 60s/60                                        |
| 创建题目                                   | `POST /problems`                                                                           | hardening IP+user                                             | 60s/30                                                          |
| 题目导入                                   | `POST /problems/import-bundle`                                                             | hardening IP+user                                             | 60s/10                                                          |
| 帖子点赞/取消                              | `POST /posts/:postId/like`                                                                 | hardening IP+user                                             | 60s/120                                                         |
| 评论点赞/取消                              | `POST /comments/:commentId/like`                                                           | hardening IP+user                                             | 60s/120                                                         |
| 收藏/取消                                  | `POST /posts/:postId/bookmark`                                                             | hardening IP+user                                             | 60s/120                                                         |
| 关注/取关                                  | `POST /users/:userId/follow`                                                               | hardening IP+user                                             | 60s/120                                                         |
| 举报                                       | `POST /reports`                                                                            | hardening IP+user                                             | 60s/30                                                          |
| 社区发帖/评论                              | `POST/PATCH/DELETE /community/posts                                                        | comments`                                                     | 服务层发布频率 + 内容审核                                       |
| 升级任务受理                               | `POST /submission-upgrade-jobs`                                                            | hardening IP+user                                             | 60s/10；user 60s/3                                              |
| 作业写操作、复制与批量补题                 | `POST/PATCH /domains/:slug/assignments/*`、`POST /domains/:slug/classrooms/:id/assignments | contest-remediation*`                                         | hardening 域 slug + user；与教学互动共享 `education-write` 窗口 |
| 教学反馈、学生求助/回复/处理、教学通知已读 | `POST/PATCH/DELETE /domains/:slug/assignments/:id/feedback                                 | help-requests*`、`POST /domains/:slug/notifications/:id/read` | hardening 域 slug + user；与作业写操作共享窗口，GET/HEAD 不扣额 |

## IP 维度与机房 NAT

代码提交、竞赛提交、客观题提交与自测的 IP 阈值为「用户阈值 ×
`SHARED_IP_SEATS`（60）」。 学校机房通常整间共用一个出口 IP，IP
维度只拦截明显的脚本刷量，单人上限由用户维度负责 （#698
P0-1）。新增面向考生的写端点时沿用同一口径，不要让 IP 阈值等于用户阈值。

## Redis 故障策略

`enforceRateLimit(key, cfg, message, onUnavailable)` 的 `onUnavailable` 默认
`"reject"`：

| 策略                     | 适用端点                                                                            |
| ------------------------ | ----------------------------------------------------------------------------------- |
| `reject`（503）          | 注册、找回/重置密码、验证邮件、私信、代码/竞赛/客观题提交、自测、升级任务、题目导入 |
| `allow`（放行并记 warn） | 帖子/评论点赞、收藏、关注、举报、教学写窗口、创建题目                               |

判断标准：被绕过时是否会产生评测算力、邮件、存储或垃圾内容等实际代价。有代价用
`reject`， 否则用 `allow`，避免 Redis 抖动时整站写入一起不可用（#698 P0-2）。

## 已知未覆盖/可接受

- **管理后台写操作**（admin
  settings/announcements/roles/blacklist/sanctions/版本策略/批量重测）：默认由管理员权限 +
  审计日志兜底；不建议做宽松限流以免误伤合法管理操作。若未来公网管理员接口被扫描，可再按
  IP 加宽限流。
  - 版本管理相关：`admin/routes/problem-versions.ts`（策略切换、竞赛固定版本、发布/草稿管理）与
    `admin/routes/submission-jobs.ts`（批量重测受理/重试）同属此类；单条重测的旧接口在
    `admin/routes/submission.ts` 内，同样由 admin 权限兜底。
- **账号层通知已读、活动可见性**：幂等且低频，暂不限流；教学通知已读属于上述域内共享写窗口。
- **题单/标签 CRUD**：权限受限、频率低，暂用服务层/权限兜底。
  - 显式域题单 `catalog/routes/domain-trainings.ts`
    同样只允许本域资源管理人员创建，记录域审计，沿用该管理豁免；它没有学生求助或评论类内容写入。
- **内部维护/排空端点**（`system/routes/internal-drain.ts` 的
  enter/exit）：只接受内部服务
  凭据（`NOJ_INTERNAL_SERVICE_TOKEN`，常量时间比较），由容器内
  `/app/bin/noj maintain` 与 noj-cli
  自动排空调用，不对浏览器或匿名开放；对其做用户向限流会 破坏 `wait`
  轮询语义，故显式豁免（见 `scripts/check-write-rate-limits.ts` 的 ALLOWLIST）。

## 新增写端点 Checklist

1. 判断是否影响用户生成内容、资源创建或批量触发副作用。
2. 是 → 在 `hardening-rate-limit.ts` 添加 `XXX_IP_LIMIT` / `XXX_USER_LIMIT` 与
   `enforceXxxRateLimit(c, userId)`。
3. 在路由 handler 最前面调用 `enforceXxxRateLimit(c, actorId)`。
4. 更新本文档矩阵。
5. 至少补充一个“超过阈值返回 429”的测试（可走 `enforceRateLimit` 基础测试 +
   路由权限测试）。
