# NOJ 写操作限流矩阵

> 目标：让“写操作默认有速率限制”成为可审计、可维护的工程事实，避免新增端点时漏加。
> 本文档是 **A3 限流/写操作系统矩阵** 的落地记录与维护入口。

## 限流原语

- **登录限流**：`noj-core/src/domains/identity/middleware/login-rate-limit.ts`，专用于认证端点。
- **通用中间件限流**：`noj-core/src/domains/system/middleware/rate-limit.ts`，进程内最小间隔限流（多实例各自计数）。
- **Hardening 限流（推荐）**：`noj-core/src/domains/system/services/hardening-rate-limit.ts`，Redis 固定窗口、fail-closed，适合高价值/批量写操作。
- **服务层频率限制**：部分业务（社区发帖）在服务层按配置间隔限流，见 `community-post-crud.ts`。

## 已覆盖写操作

| 操作 | 路由 | 限流方式 | 阈值 |
| --- | --- | --- | --- |
| 注册 | `POST /auth/register` | hardening IP | 1h/100 |
| 重发验证邮件 | `POST /auth/email/resend` | hardening IP + user；服务层冷却兜底 | 60s/1 |
| 忘记密码 | `POST /auth/forgot-password` | hardening IP + email | IP 1h/30；email 1h/10 |
| 重置密码 | `POST /auth/reset-password` | hardening IP + email | 同上 |
| 修改密码 | `POST /auth/change-password` | 账号限流（loginThrottle） | 独立命名空间 |
| TFA 确认/禁用 | `POST /auth/tfa/*` | 账号限流（loginThrottle） | TFA_NAMESPACE |
| 私信发送 | `POST /conversations/:id/messages` | hardening user | 60s/60 |
| 代码提交 | `POST /submissions` | hardening IP+user | 60s/120 |
| 自测 | `POST /problems/:id/self-test` | hardening IP+user | 60s/30；user 60s/4 |
| 竞赛提交 | `POST /contests/:id/submit` | hardening IP+user | 60s/120 |
| 客观题提交 | `POST /problems/:id/submit`（objective） | hardening IP+user | 60s/60 |
| 创建题目 | `POST /problems` | hardening IP+user | 60s/30 |
| 题目导入 | `POST /problems/import-bundle` | hardening IP+user | 60s/10 |
| 帖子点赞/取消 | `POST /posts/:postId/like` | hardening IP+user | 60s/120 |
| 评论点赞/取消 | `POST /comments/:commentId/like` | hardening IP+user | 60s/120 |
| 收藏/取消 | `POST /posts/:postId/bookmark` | hardening IP+user | 60s/120 |
| 关注/取关 | `POST /users/:userId/follow` | hardening IP+user | 60s/120 |
| 举报 | `POST /reports` | hardening IP+user | 60s/30 |
| 社区发帖/评论 | `POST/PATCH/DELETE /community/posts|comments` | 服务层发布频率 + 内容审核 | 按社区配置 |

## 已知未覆盖/可接受

- **管理后台写操作**（admin settings/announcements/roles/blacklist/sanctions）：默认由管理员权限 + 审计日志兜底；不建议做宽松限流以免误伤合法管理操作。若未来公网管理员接口被扫描，可再按 IP 加宽限流。
- **通知已读、活动可见性**：幂等且低频，暂不限流。
- **题单/标签 CRUD**：权限受限、频率低，暂用服务层/权限兜底。

## 新增写端点 Checklist

1. 判断是否影响用户生成内容、资源创建或批量触发副作用。
2. 是 → 在 `hardening-rate-limit.ts` 添加 `XXX_IP_LIMIT` / `XXX_USER_LIMIT` 与 `enforceXxxRateLimit(c, userId)`。
3. 在路由 handler 最前面调用 `enforceXxxRateLimit(c, actorId)`。
4. 更新本文档矩阵。
5. 至少补充一个“超过阈值返回 429”的测试（可走 `enforceRateLimit` 基础测试 + 路由权限测试）。
