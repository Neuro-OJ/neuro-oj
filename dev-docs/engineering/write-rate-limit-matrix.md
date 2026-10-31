# NOJ 写操作限流矩阵

> 目标：让“写操作默认有速率限制”成为可审计、可维护的工程事实，避免新增端点时漏加。
> 本文档是 **A3 限流/写操作系统矩阵** 的落地记录与维护入口。

## 限流原语

- **登录限流**：`noj-core/src/domains/identity/middleware/login-rate-limit.ts`，专用于认证端点。
- **通用中间件限流**：`noj-core/src/domains/system/middleware/rate-limit.ts`，进程内最小间隔限流（多实例各自计数）。
- **Hardening
  限流（推荐）**：`noj-core/src/modules/platform/system/services/hardening-rate-limit.ts`，Redis
  固定窗口，适合高价值/批量写操作。Redis 不可用时默认 fail-closed（503）；社区互动、签到、
  教学写操作与创建题目显式传 `"allow"` 放行并记告警（见下文「Redis 故障策略」）。
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
| 代码提交                                   | `POST /submissions`                                                                        | hardening IP+user                                             | IP 60s/7200；user 60s/120                                        |
| 自测                                       | `POST /problems/:id/self-test`                                                             | hardening IP+user                                             | IP 60s/240；user 60s/4                                          |
| 竞赛提交                                   | `POST /contests/:id/submit`                                                                | hardening IP+user                                             | IP 60s/7200；user 60s/120                                        |
| 客观题提交                                 | `POST /problems/:id/submit`（objective）                                                   | hardening IP+user                                             | IP 60s/3600；user 60s/60                                         |
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

代码提交、竞赛提交、客观题提交与自测的 IP 阈值为「用户阈值 × `SHARED_IP_SEATS`（60）」。
学校机房通常整间共用一个出口 IP，IP 维度只拦截明显的脚本刷量，单人上限由用户维度负责
（#698 P0-1）。新增面向考生的写端点时沿用同一口径，不要让 IP 阈值等于用户阈值。

## Redis 故障策略

`enforceRateLimit(key, cfg, message, onUnavailable)` 的 `onUnavailable` 默认 `"reject"`：

| 策略 | 适用端点 |
| --- | --- |
| `reject`（503） | 注册、找回/重置密码、验证邮件、邮件投递回执、私信、代码/竞赛/客观题提交、自测、升级任务、题目导入 |
| `allow`（放行并记 warn） | 帖子/评论点赞、收藏、关注、举报、每日签到、教学写窗口、创建题目 |

判断标准：被绕过时是否会产生评测算力、邮件、存储或垃圾内容等实际代价。有代价用 `reject`，
否则用 `allow`，避免 Redis 抖动时整站写入一起不可用（#698 P0-2）。

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
- **内部维护/排空端点**（`system/routes/internal-drain.ts` 的 enter/exit）：只接受内部服务
  凭据（`NOJ_INTERNAL_SERVICE_TOKEN`，常量时间比较），由容器内
  `/app/bin/noj maintain` 与 noj-cli 自动排空调用，不对浏览器或匿名开放；对其做用户向限流会
  破坏 `wait` 轮询语义，故显式豁免（见 `scripts/check-write-rate-limits.ts` 的 ALLOWLIST）。
- **域管理级写操作**（域社区治理 `/manage/*`、域 LLM 配置、域题库资源管理）：都要求域管理员级
  权限（`community:moderate` / `llm:manage` / `problem:create` / `problem:policy`）并写域审计，
  沿用管理豁免；逐文件依据登记在 ALLOWLIST。
  - `POST /domains/:slug/community/reports` 由父路由 `domain-community.ts` 的
    `enforceReportRateLimit` 覆盖（60s/30），不是无限制端点。
- **仍待偿还的欠债（`pending`，保持可见）**：无。此前登记的两条已于 2026-10-31 补齐
  （见下节），`check-write-rate-limits` 现在的输出是"待偿还欠债 0 个"。

## 2026-10-31 偿还的两条欠债

这两条是门禁此前唯一暴露出来、却一直挂着的 `pending`：都是真写端点，只是理由当时没写清。

| 操作 | 路由 | 限流方式 | 阈值 | 为什么是这个维度 |
| --- | --- | --- | --- | --- |
| 每日签到 | `POST /api/v1/checkin` | `enforceCheckinRateLimit(userId)` | 60s/10（账号） | 按天幂等**不等于**可以无限调用：重复请求仍会开事务写 `check_ins` 并重算连续天数。只按账号计数、**不按 IP**——机房/校园 NAT 下同班学生共用出口 IP，IP 窗口会让他们互相顶掉签到 |
| 邮件投递回执 | `POST /api/v1/email-events/:provider` | `enforceEmailDeliveryEventRateLimit(c)` | 60s/120（来源 IP） | 该端点对公网开放（厂商回调），签名校验是第一道门；限流挡的是伪造/重放的高频请求在验签前后白白消耗连接与 DB。窗口放到 120 是因为厂商会批量追送回执 |

两条都补了 HTTP 层回归：预置窗口计数到上限前一次，断言"最后一次放行 + 超额 429 +
带 `Retry-After`"，并断言被拒的请求**没有业务副作用**（签到不写 `check_ins`、回执不进入
验签）。签名校验与限流的顺序明确写死：**限流不替代验签**。

## 2026-10-31 补齐的域内写端点

`educationWriteRateLimit`（`education/routes/write-rate-limit.ts`）此前只装在 `assignments.ts`。
下列 6 条写路由**完全没有限流**，而门禁也没发现——原因是门禁的写路由正则不认局部常量/模板
路径写法（见下节），这两个文件根本没进入检查。现已装上限流并补回归断言：

| 操作 | 路由 | 限流方式 | 阈值 |
| --- | --- | --- | --- |
| 学生入班申请 | `POST /domains/:slug/classrooms/:id/join` | `educationWriteRateLimit` | 60s/120（域 slug + user） |
| 入班申请审阅 | `POST .../join-requests/:requestId/review` | `educationWriteRateLimit` | 60s/120 |
| 班级名单导入预览 | `POST .../imports/preview` | `educationWriteRateLimit` | 60s/120 |
| 班级名单导入执行 | `POST .../imports/execute` | `educationWriteRateLimit` | 60s/120 |
| 提交批注创建 | `POST .../submissions/submission/:submissionId/annotations` | `educationWriteRateLimit` | 60s/120 |
| 提交批注更新 | `PATCH .../annotations/:annotationId` | `educationWriteRateLimit` | 60s/120 |

比赛侧另有两处，此前已在矩阵外被漏记：

| 操作 | 路由 | 限流方式 | 阈值 |
| --- | --- | --- | --- |
| 比赛报名 | `POST /contests/:id/register`、`POST /domains/:slug/contests/:id/register` | `enforceContestRegisterRateLimit` | 见 `CONTEST_REGISTER_*` 配置 |
| 竞赛答疑提问 | `POST /contests/:id/clarifications`、`POST /domains/:slug/contests/:id/clarifications` | 服务层 `checkRateLimit` | 60s/5（比赛 + 用户） |

## 门禁口径与已知盲区（2026-10-31）

`scripts/check-write-rate-limits.ts` 是**文件级**判定：文件内出现任一限流证据即视为已覆盖。
这个粒度是有意为之（逐 handler 解析容易误判），但它此前还有一个更严重的问题——**路径解析**：

```ts
const path = "/domains/:slug/contests";
router.post(path, ...);
router.patch(`${path}/:id`, ...);
```

正则只认字符串字面量路径，于是 `domain-contests.ts` 的 8 条写路由（含"创建比赛""批量加参赛
者""发布正式成绩"）**一条都没被解析**，文件因"没有写路由"直接跳过判定——不是判定太粗，是根本
没进入检查。修正后写路由总数从 171 条升到 237 条；新暴露的 5 个文件已逐条处置（2 个补限流、
3 个登记管理豁免），并补了「域比赛 8 条写路由必须全部被发现」的回归断言。

文件级判定仍然成立：同一文件里"有一条限流"不代表每条都限流，因此**新增写端点时必须同时更新
本矩阵**；门禁只负责拦住"整个文件没考虑限流"这一类漂移。

## 新增写端点 Checklist

1. 判断是否影响用户生成内容、资源创建或批量触发副作用。
2. 是 → 在 `hardening-rate-limit.ts` 添加 `XXX_IP_LIMIT` / `XXX_USER_LIMIT` 与
   `enforceXxxRateLimit(c, userId)`。
3. 在路由 handler 最前面调用 `enforceXxxRateLimit(c, actorId)`。
4. 更新本文档矩阵。
5. 至少补充一个“超过阈值返回 429”的测试（可走 `enforceRateLimit` 基础测试 +
   路由权限测试）。
