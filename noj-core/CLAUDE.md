# noj-core — Neuro OJ 核心后端

基于 **Deno + Hono** 的 RESTful API 服务端。

## 职责

- 提供 RESTful API 供 noj-ui 调用
- 用户认证与授权
- 题目管理（CRUD）
- 提交管理（接收代码提交）
- 通过 Redis MQ 向 noj-judge 分发评测任务（Producer）
- 接收评测结果并持久化

## 技术栈

| 组件     | 选择                        |
| -------- | --------------------------- |
| 运行时   | Deno 2                      |
| 语言     | TypeScript                  |
| Web 框架 | Hono                        |
| 数据库   | PostgreSQL 16 + postgres.js |
| ORM      | Drizzle ORM                 |
| 消息队列 | Redis (ioredis)             |
| 认证     | JWT (jose) + bcryptjs       |

## RBAC 权限系统

项目使用基于角色访问控制（RBAC）替代硬编码 `userRole === "admin"` 字符串比较。

### 数据模型

| 表                 | 用途                                                 |
| ------------------ | ---------------------------------------------------- |
| `roles`            | 角色定义（`is_admin`/`is_default`/`is_system` 标记） |
| `permissions`      | 权限定义（`resource:action` 格式，22 个预置）        |
| `role_permissions` | 角色-权限多对多关联                                  |
| `user_roles`       | 用户-角色多对多关联                                  |

### 权限检查层次

一次 HTTP 请求中，权限检查有三个调用层次，共享请求级缓存：

```
authMiddleware → 注入 isAdmin
    │
    ├─ requireAdmin()          纯 JWT fast path，零 DB 查询
    │   └─ 用于 /api/v1/admin/* 路由组
    │
    ├─ requirePermission("x")  中间件（isAdmin fast path | DB）
    │   └─ 用于非 admin 路由的精确权限拦截
    │
    └─ 社区管理（routes/community.ts）：
        requireCommunityModeration 守卫（admin 或 community_moderation:review）
        └─ 端点细分：system:settings（预设）/ community_board:manage（板块）/
           community_moderation:lock（锁定置顶）/ community_moderation:sanction（处罚）
    │
    └─ checkPermission(c, "x") / assertPermission(c, "x")
        工具函数（isAdmin fast path | DB）
        └─ 用于 handler/service 内部的条件判断或断言
```

### 关键函数

| 函数                         | 位置                        | 用途                                          |
| ---------------------------- | --------------------------- | --------------------------------------------- |
| `getUserPermissions(userId)` | `src/lib/permissions.ts`    | 递归 CTE 查询用户所有权限，返回 `Set<string>` |
| `resolvePermissions(c)`      | 同上                        | 请求级缓存封装                                |
| `checkPermission(c, perm)`   | 同上                        | 返回 boolean，service 层条件判断              |
| `assertPermission(c, perm)`  | 同上                        | 无权限时抛 ForbiddenError                     |
| `requireAdmin()`             | 同上                        | 中间件，纯 JWT fast path                      |
| `requirePermission(perm)`    | 同上                        | 中间件工厂函数                                |
| `ensureRbacSeeds()`          | `src/services/seed-rbac.ts` | 全量幂等初始化                                |

### Permissions

| `resource` | `action`                                                                                             | 说明               |
| ---------- | ---------------------------------------------------------------------------------------------------- | ------------------ |
| problem    | create/create_p/read/write_own/write_any/delete_own/delete_any/package_manage_own/package_manage_any | 题目 CRUD + 支持包 |
| submission | create/read_own/read_all/rejudge                                                                     | 提交操作           |
| user       | read_profile/search/manage                                                                           | 用户操作           |
| tag        | read/manage                                                                                          | 标签操作           |
| system     | settings/judge_images/audit_logs/ip_bans                                                             | 系统管理           |

### 迁移策略

- `users.role` 列保留（标记为 deprecated），用于向前兼容和 JWT `role` claim
- 旧服务函数保留 `userRole` 参数作为 fallback，新增 `c?: Context` 参数启用 RBAC
- `createProblem`/`updateProblem`/`deleteProblem` 等已迁移到
  `assertPermission()`
- `getSubmission` 使用 `c.var.isAdmin` 替代 `viewerRole === "admin"`
- 路由层通过 `c.var.isAdmin ?? c.var.userRole === "admin"` 双兼容

## 目录结构

```
noj-core/
├── deno.json              # 项目配置 & 导入映射
├── drizzle.config.ts      # Drizzle Kit 配置
├── drizzle/               # SQL 迁移文件（自动生成）
│   ├── meta/_journal.json # 迁移日志（勿手动编辑）
│   └── 0000_*.sql
├── .env                   # 环境变量（不提交）
├── src/
│   ├── main.ts            # 入口（启动校验 + 初始化顺序）
│   ├── app.ts             # Hono 应用工厂（CORS + 路由 + 错误处理）
│   ├── mod.ts             # 公共导出
│   ├── routes/            # 路由层（参数校验 + 调用 service）：admin / auth / tags / checkin / community / contests / conversations / health / problems / queue / rankings / search / sse / stats / submissions / users
│   ├── services/          # 业务逻辑层（数据库读写，34 个文件，含 problems-*/submissions-* 拆分与 community/contests/dashboard/stats-cache 等）
│   ├── db/                # 数据库连接 & Drizzle schema
│   │   ├── index.ts       # 数据库连接管理（单例模式）
│   │   ├── migrate.ts     # 迁移执行器（绝对路径解析，不依赖 CWD）
│   │   └── schema.ts      # Drizzle 表定义（38 张表）
│   ├── middleware/         # 认证中间件（auth / banlist / rateLimit / searchRateLimit / request-context）
│   ├── mq/                # Redis 消息队列（Producer + Consumer）
│   │   ├── connection.ts   #   连接管理（共享 + 消费者 + Pub/Sub）
│   │   ├── base-consumer.ts#   BRPOP 消费基类
│   │   ├── consumer.ts     #   评测结果消费者（BRPOP 阻塞）
│   │   └── producer.ts     #   评测任务生产者（LPUSH）
│   ├── lib/               # 工具函数（JWT、密码、错误类、请求解析、日志、存储、限流、RBAC 等）
│   │   ├── email.ts            # 邮件发送抽象入口（动态选择 Provider）
│   │   ├── email-providers/    # 邮件 Provider 实现（types / mock / aliyun / tencent）
│   │   ├── storage/            # 抽象存储层（StorageProvider）
│   │   │   ├── types.ts        #   StorageProvider 接口 + URL 工具
│   │   │   ├── local.ts        #   LocalStorageProvider（dev 专用）
│   │   │   ├── s3.ts           #   S3StorageProvider（生产环境）
│   │   │   ├── factory.ts      #   工厂函数（环境变量选择实现）
│   │   │   └── mod.ts          #   公共导出
│   │   ├── errors.ts           # AppError 继承体系（6 个子类）
│   │   ├── jwt.ts              # JWT 签发/验证（HS256, iss/aud 校验）
│   │   ├── password.ts         # bcrypt 哈希/比对（cost 12）
│   │   ├── request.ts          # parseJsonBody<T>() 安全 JSON 解析
│   │   ├── permissions.ts      # RBAC 权限工具（getUserPermissions / requireAdmin / requirePermission 等）
│   │   ├── logging.ts          # 生产安全日志（UUID 截断、分值隐藏）
│   │   ├── event-bus.ts        # 进程内事件总线（SSE 推送）
│   │   ├── env-snapshot.ts     # 环境变量快照（启动期记录）
│   │   ├── settings-registry.ts# 系统设置注册表
│   │   ├── rateLimit.ts / loginThrottle.ts / rateLimitEnv.ts / cidr.ts  # 速率限制
│   │   ├── pagination.ts / samples.ts / sql-rows.ts / resetToken.ts / revokedTokens.ts / banCache.ts / requestContext.ts  # 其他工具
│   │   └── ...
│   └── types/             # 类型定义
│       ├── index.ts        # JudgeTask, JudgeResult, SubmissionStatus, LANGUAGE_EXT_MAP
│       ├── auth.ts         # RegisterInput, LoginInput, UserResponse
│       └── problems.ts     # DIFFICULTIES, PROBLEM_TYPES, 校验函数
├── scripts/               # CLI 工具（noj.ts 单入口 + migrate.ts + check-env.ts）
├── data/
│   ├── problems-src/<id>/ # 题目源文件（版本控制，仅样例题）
│   └── packages/<id>.zip  # 构建产物（gitignored，local 模式使用）
└── tests/                 # 测试文件（与 src 镜像结构）
    ├── 00_migrate_test.ts # 最先执行：迁移 + seed root 用户
    ├── services/          # 服务层测试
    └── routes/            # 路由层测试（使用 jsonRequest() 辅助函数）
```

## 环境变量

从 `.env` 文件或 `Deno.env` 读取。**必须配置**：

| 变量                              | 默认值                    | 说明                                                                        |
| --------------------------------- | ------------------------- | --------------------------------------------------------------------------- |
| `DATABASE_URL`                    | —                         | PostgreSQL 连接串（无默认值）                                               |
| `JWT_SECRET`                      | —                         | HS256 签名密钥（≥32 字符）                                                  |
| `TFA_ENCRYPTION_KEY`              | —                         | TOTP secret 加密密钥（≥32 字符，与 JWT_SECRET 隔离）                        |
| `JWT_EXPIRES_IN`                  | `24h`                     | Token 有效期                                                                |
| `REDIS_URL`                       | `redis://127.0.0.1:6379/` | Redis 连接串                                                                |
| `RESULT_CONSUMER_CONCURRENCY`     | `4`                       | 评测结果消费者连接数（1-16）                                                |
| `PORT`                            | `8000`                    | HTTP 监听端口                                                               |
| `NOJ_ENV`                         | 空（development）         | `production` 启用生产模式                                                   |
| `LOG_LEVEL`                       | prod=info / dev=debug     | 日志级别：`debug`/`info`/`warn`/`error`，低于阈值的日志被抑制               |
| `LOG_FORMAT`                      | prod=json / dev=pretty    | 日志输出格式：`json`（结构化）/ `pretty`（人类可读）                        |
| `ADMIN_EMAIL`                     | —                         | 管理员邮箱（**强烈推荐**）。未设置时 bootstrap admin 自动创建临时引导管理员 |
| `ADMIN_PASS`                      | —                         | Seed 管理员密码（需与 ADMIN_EMAIL 配合）                                    |
| `DATABASE_POOL_MAX`               | `10`                      | PostgreSQL 连接池大小                                                       |
| `DATABASE_CONNECT_TIMEOUT`        | `10`                      | 连接超时秒数                                                                |
| `DATABASE_IDLE_TIMEOUT`           | `300`                     | 空闲连接超时秒数                                                            |
| `DATABASE_MAX_LIFETIME`           | `3600`                    | 连接最大生命周期秒数                                                        |
| `CORS_ALLOWED_ORIGINS`            | —                         | 生产环境 CORS 白名单（逗号分隔）                                            |
| `EMAIL_PROVIDER`                  | `mock`                    | 邮件 Provider：`mock`/`aliyun`/`tencent`                                    |
| `ALIBABA_ACCESS_KEY_ID`           | —                         | 阿里云 DirectMail AccessKey（aliyun 时必填）                                |
| `ALIBABA_ACCESS_KEY_SECRET`       | —                         | 阿里云 DirectMail AccessKey Secret                                          |
| `ALIBABA_FROM_EMAIL`              | —                         | 阿里云发信地址（需控制台验证域名）                                          |
| `TENCENT_SECRET_ID`               | —                         | 腾讯云 SecretId（tencent 时必填）                                           |
| `TENCENT_SECRET_KEY`              | —                         | 腾讯云 SecretKey                                                            |
| `TENCENT_FROM_EMAIL`              | —                         | 腾讯云发信地址（需控制台验证域名）                                          |
| `TENCENT_REGION`                  | `ap-guangzhou`            | 腾讯云地域                                                                  |
| `STORAGE_PROVIDER`                | `local`                   | 存储 Provider：`local`（开发测试）或 `s3`（生产环境）                       |
| `S3_ENDPOINT`                     | —                         | S3 兼容对象存储端点（s3 模式必填）                                          |
| `S3_REGION`                       | `us-east-1`               | S3 区域                                                                     |
| `S3_ACCESS_KEY`                   | —                         | S3 访问密钥（s3 模式必填）                                                  |
| `S3_SECRET_KEY`                   | —                         | S3 秘密密钥（s3 模式必填）                                                  |
| `S3_BUCKET`                       | `noj-support-packages`    | S3 存储桶名                                                                 |
| `S3_FORCE_PATH_STYLE`             | `false`                   | 使用路径风格 URL（MinIO 需要设为 `true`）                                   |
| `RATE_LIMIT_ENABLED`              | `true`                    | 速率限制总开关（NOJ_ENV=test 时强制关闭）                                   |
| `RATE_LIMIT_LOGIN_IP_WINDOW`      | `30`                      | IP 维度限流窗口（秒）                                                       |
| `RATE_LIMIT_LOGIN_IP_MAX`         | `10`                      | IP 维度窗口内最大尝试次数                                                   |
| `RATE_LIMIT_LOGIN_ACC_WINDOW`     | `30`                      | 账号维度限流窗口（秒）                                                      |
| `RATE_LIMIT_LOGIN_ACC_MAX`        | `5`                       | 账号维度窗口内最大尝试次数                                                  |
| `RATE_LIMIT_LOGIN_BACKOFF_SEC`    | `15`                      | 每次失败累计退避秒数                                                        |
| `RATE_LIMIT_LOGIN_LOCK_THRESHOLD` | `10`                      | 连续失败锁定阈值                                                            |
| `RATE_LIMIT_LOGIN_LOCK_SECONDS`   | `3600`                    | 锁定时长（秒）                                                              |
| `RATE_LIMIT_SEARCH_ENABLED`       | `true`                    | 搜索限流总开关（issue #100）                                                |
| `RATE_LIMIT_SEARCH_WINDOW`        | `30`                      | 搜索限流窗口（秒）                                                          |
| `RATE_LIMIT_SEARCH_MAX_ANON`      | `60`                      | 匿名 IP 窗口内最大搜索尝试次数                                              |
| `RATE_LIMIT_SEARCH_MAX_AUTHED`    | `120`                     | 登录用户窗口内最大搜索尝试次数                                              |
| `TRUSTED_PROXIES`                 | —                         | 可信代理白名单（逗号分隔 IP/CIDR）。生产环境**必须**配置                    |
| `AUDIT_LOG_RETENTION_DAYS`        | `90`                      | 审计日志保留天数（0 = 禁用清理）                                            |

## 开发命令

```bash
# 开发模式（热重载）
deno task dev

# 生产运行
deno task start

# 数据库迁移（启动时自动执行，也可单独运行）
deno task db:migrate

# 生成 Drizzle 迁移文件
deno task db:generate

# 种子数据（示例题 + 标签 + 管理员）
deno task dev-setup

# 构建支持包
deno task problems:build

# 一键初始化
deno task dev-setup          # 开发环境一键初始化（迁移 + 系统数据 + 题目导入）

# 测试
deno task test              # 串行全量（无 DATABASE_URL 时走 PGlite 内存库）
deno task test:parallel     # 并行分片（需本地 PG：TEST_SCHEMA=test_unit/test_db
                            # 双 schema 隔离，两组并行，全绿约 2-3 min）
deno task test:smoke        # 快速冒烟（Hono server + /health，需 Redis）
```

### 测试并行分片（TEST_SCHEMA）

`deno task test:parallel`（`scripts/test-parallel.ts`）把测试按目录分为
`unit`（lib/middleware/types/data/app）与
`db`（services/routes/mq/db/迁移/种子） 两组，每组独占一个 PG
schema（`test_unit` / `test_db`），进程级并行互不干扰：

- `src/db/connection.ts` 支持 `TEST_SCHEMA` 环境变量：通过 libpq startup 参数
  `-csearch_path=<schema>,public` 让连接池内所有连接落在目标 schema （TRUNCATE /
  SELECT / INSERT 均自动隔离）
- `src/db/migrate.ts` 在 TEST_SCHEMA 下把 `migrationsSchema` 指向同 schema，
  避免各分片共享 `drizzle` 迁移记录导致"已迁移"误判跳过
- 约束：分片目录集合与 CI 的 `core-test-db` 一致；CI 的 `core-test-unit` 是
  PGlite 模式（无需迁移），本地 unit 分片走真实 PG（需 00_migrate_test）

注意：迁移 SQL 中历史文件（0010/0027/0029）曾带 drizzle-kit 生成的
`REFERENCES "public"."xxx"` 硬编码前缀，分片下 FK 会错指 public schema （已在
2026-07 修复为不带前缀，按 search_path 解析）。新增迁移请保持 不带 schema
前缀，否则分片测试会静默失败。

## 基础设施

```bash
docker compose up -d    # 启动 PostgreSQL:5432 + Redis:6379
docker compose down     # 停止
```

## API 路由

| 方法   | 路径                                         | 权限        | 说明                                          |
| ------ | -------------------------------------------- | ----------- | --------------------------------------------- |
| POST   | `/api/v1/auth/register`                      | 公开        | 用户注册                                      |
| POST   | `/api/v1/auth/login`                         | 公开        | 用户登录（返回 JWT）                          |
| GET    | `/api/v1/auth/me`                            | 登录        | 当前用户信息                                  |
| GET    | `/api/v1/tags`                               | 公开        | 标签列表（含算法标签名，发现路径）            |
| POST   | `/api/v1/tags`                               | tag:manage  | 创建标签（默认仅 admin，可配置）              |
| PUT    | `/api/v1/tags/:id`                           | tag:manage  | 更新标签（改名/改 kind）                      |
| DELETE | `/api/v1/tags/:id`                           | tag:manage  | 删除标签（级联清理关联）                      |
| POST   | `/api/v1/tags/:id/merge`                     | tag:manage  | 合并标签（关联重指向后删除源标签）            |
| GET    | `/api/v1/problems`                           | 公开        | 题目列表（分页+筛选）                         |
| GET    | `/api/v1/problems/:id`                       | 公开        | 题目详情（**双索引**：UUID/display_id/数字）  |
| POST   | `/api/v1/problems`                           | 登录        | 创建题目（U/P 类型）                          |
| PUT    | `/api/v1/problems/:id`                       | 登录        | 更新题目                                      |
| DELETE | `/api/v1/problems/:id`                       | 登录        | 删除题目                                      |
| GET    | `/api/v1/submissions`                        | 登录        | 我的提交列表                                  |
| POST   | `/api/v1/submissions`                        | 登录        | 创建提交                                      |
| GET    | `/api/v1/submissions/:id`                    | 登录        | 提交详情                                      |
| GET    | `/api/v1/submissions/:id/status`             | 登录        | 提交队列状态                                  |
| GET    | `/api/v1/admin/submissions`                  | 管理员      | 全部提交管理                                  |
| GET    | `/api/v1/admin/users`                        | 管理员      | 用户列表                                      |
| PATCH  | `/api/v1/admin/users/:id/role`               | 管理员      | 角色变更                                      |
| GET    | `/api/v1/users/:id/profile`                  | 公开        | 用户主页                                      |
| PUT    | `/api/v1/users/me`                           | 登录        | 更新个人简介                                  |
| POST   | `/api/v1/auth/change-password`               | 登录        | 修改密码（issue #75 强制改密）                |
| POST   | `/api/v1/auth/tfa/setup`                     | 登录        | 生成 TOTP secret 与 otpauth URL（issue #228） |
| POST   | `/api/v1/auth/tfa/confirm`                   | 登录        | 确认启用 TFA，返回一次性恢复码（issue #228）  |
| POST   | `/api/v1/auth/tfa/disable`                   | 登录        | 禁用 TFA（需 TOTP/恢复码确认，issue #228）    |
| POST   | `/api/v1/auth/tfa/recovery-codes/regenerate` | 登录        | 重新生成恢复码（issue #228）                  |
| POST   | `/api/v1/auth/logout`                        | 公开        | 登出（no-op stub，客户端自行清 Cookie）       |
| GET    | `/api/v1/problems/:id/support-package`       | 登录        | 下载支持包（通过 core 代理，不暴露 S3 URL）   |
| POST   | `/api/v1/checkin`                            | 登录        | 每日签到（返回当前连续天数）                  |
| GET    | `/api/v1/checkin/today`                      | 登录        | 查询今日签到状态                              |
| GET    | `/api/v1/search`                             | 公开/管理员 | 全局搜索（题目+用户，分页，issue #100）       |
| GET    | `/health`                                    | 公开        | 健康检查                                      |

### 路由层关键模式

**Problem ID 四步解析**（`routes/problems.ts`）：

1. UUID 格式 → 按 PK 查询
2. `display_id` 格式（`P1001`/`U42`）→ 解析 type+number →
   `getProblemByTypeAndNumber()`
3. 纯数字（遗留种子数据如 `1001`）→ 按 PK 查询
4. 兜底 → 按 PK 查询

**路由注册顺序敏感**（`routes/users.ts`）：

- `PUT /me` 必须在 `GET /:id/profile` **之前**注册，否则 "me" 会被匹配为 `:id`
- 注释明确警告此顺序依赖

**管理路由挂载**（`app.ts`）：

- 管理路由以 `/api/v1/admin` 为前缀挂载，子路由内部路径为 `/`（相对路径）

## Redis MQ 约定

| 队列                | 方向                 | 说明                    |
| ------------------- | -------------------- | ----------------------- |
| `noj:judge:queue`   | noj-core → noj-judge | 评测任务（LPUSH/BRPOP） |
| `noj:judge:results` | noj-judge → noj-core | 评测结果（BRPOP/LPUSH） |

**Redis 连接设计**：

- `getRedis()` — 共享连接，用于 LPUSH
  评测任务（`enableOfflineQueue: false`，重试 5 次后停止）
- `createConsumerRedis()` — 独立连接，用于 BRPOP
  阻塞等待结果（`lazyConnect: true`，指数退避永不停止）
- `getRedis()` 在 `connect` 事件中清除错误状态，使健康检查可恢复

**Producer 行为**：

- 发送前检查 `redis.status !== "ready"`，连接不可用时拒绝发送
- 消息大小上限 16MB（`TextEncoder().encode(message).length`）
- 数据库写入**先于** MQ 推送：若推送失败，submission 标记为 `error`

**Consumer 行为**：

- BRPOP 超时 10 秒，超时后循环重试
- 解析失败或缺少 `submission_id` → `continue` 跳过
- 数据库错误 → 记录日志后继续
- 后台自动重连：指数退避 1s→2s→4s→…→30s 封顶

## 启动顺序（main.ts）

1. **JWT_SECRET 强度校验** — ≥32 字符，不足则拒绝启动
2. **数据库迁移** — 失败为致命错误，终止启动
3. **确保 root 系统用户** — UID=0，admin 角色，不可登录，不计入管理员统计
4. **邮件 Provider 配置检查** — 非致命：配置缺失时降级到 mock 并 console.warn
5. **连接 Redis** — 失败则 degraded 模式（HTTP 仍启动，评测功能不可用）
6. **启动评测结果消费者** — 后台自动重连（指数退避 1s→2s→4s→…→30s）
7. **启动 HTTP 服务**

## 数据库 Schema 设计

| 表                      | 关键列                                                                                                                    | 约束 / 索引                                                 |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| `users`                 | `id`(UUID), `username`(unique), `email`(unique), `password_hash`, `role`(user/admin), `bio`, `must_change_password`(bool) | PK, UK(username), UK(email)                                 |
| `problems`              | `id`(UUID), `type`(U/P), `number`(int), `display_id`(unique), `title`, `difficulty`, `owner_id`                           | PK, UK(display_id), UK(type,number), FK→users               |
| `tags`                  | `id`(UUID), `name`(unique), `kind`(problem/algorithm), `created_at`, `updated_at`                                         | PK, UK(name), CHECK(kind)                                   |
| `problem_tags`          | `problem_id`, `tag_id`                                                                                                    | FK→problems ON DELETE CASCADE, FK→tags ON DELETE CASCADE    |
| `submissions`           | `id`(UUID), `user_id`, `problem_id`, `status`, `language`, `code`                                                         | PK, FK→users, FK→problems, idx(user_id,created_at)          |
| `evaluation_results`    | `id`(UUID), `submission_id`(unique), `status`, `score`(INTEGER×100), `output`, `time_ms`, `memory_kb`                     | PK, UK(submission_id), FK→submissions                       |
| `check_ins`             | `id`(UUID), `user_id`, `checkin_date`(YYYY-MM-DD UTC), `streak`                                                           | PK, FK→users, UK(user_id,checkin_date)                      |
| `judge_images`          | `id`(UUID), `image`(text), `enabled`(bool)                                                                                | PK, UK(image)                                               |
| `password_reset_tokens` | `id`(UUID), `user_id`, `token_hash`(text), `expires_at`(text), `used`(bool)                                               | PK, FK→users, UK(token_hash)                                |
| `conversations`         | `id`(UUID), `participant_a_id`, `participant_b_id`, `last_message_at`(text)                                               | PK, FK→users, UK(participant_a,participant_b)               |
| `messages`              | `id`(UUID), `conversation_id`, `sender_id`, `content`(text), `created_at`(text)                                           | PK, FK→conversations, idx(conversation_id,created_at)       |
| `conversation_reads`    | `id`(UUID), `conversation_id`, `user_id`, `last_read_at`(text)                                                            | PK, FK→conversations, FK→users, UK(conversation_id,user_id) |
| `message_deletions`     | `id`(UUID), `message_id`, `user_id`, `deleted_at`(text)                                                                   | PK, FK→messages, FK→users                                   |

> 上表为核心表速查。完整 Schema 共 38 张表（`src/db/schema.ts`），另有：
>
> - **竞赛**：`contests` / `contest_problems` / `contest_participants` /
>   `contest_clarifications`
> - **RBAC**：`roles` / `permissions` / `role_permissions` / `user_roles`
> - **社区**：`community_boards` / `community_posts` / `community_comments` /
>   `community_follows` / `community_activity_events` / `community_reports` /
>   `community_moderation_actions` / `community_sanctions` /
>   `community_notifications` 等 17 张
> - **其他**：`system_settings` / `audit_logs` / `ip_bans` / `user_bans`

**设计要点**：

- 所有时间戳使用 ISO 8601 **文本**格式存储（非原生 `timestamptz`）
- `evaluation_results.score` 为 `INTEGER`（×100），`scoreToDb`/`scoreFromDb`
  在应用层转换
- `problems.number` 按 `type` 分别自增（`(type, number)` UNIQUE）
- `tags.kind`
  区分题目标签（problem，人人可见）与算法标签（algorithm，通过题目后可见，spoiler
  门控后端强制）
- `submissions` 有复合索引 `(user_id, created_at)` 优化"我的提交历史"查询

## 代码规范

- TypeScript 严格模式
- 路由文件默认导出 Hono 实例，由 `app.ts` 组合
- API 路径：`/api/v1/{resource}`
- 错误处理：统一 `AppError` 继承体系（6 个子类），全局 `onError` 捕获，带
  `request_id`
- 密码强度：≥12 位、含大小写字母和数字（OWASP 2025+）
- JWT：HS256、iss/aud 校验、24h 有效期（无刷新机制）、`jti` 已生成但未持久化校验
- 分值：×100 整数值存储（`scoreToDb`/`scoreFromDb`），避免浮点误差
- 迁移：Drizzle ORM migrator，`drizzle/` 目录下 SQL 文件按序执行
- `_journal.json` 与 SQL 文件必须一致，删除文件需同步更新 journal

## 服务层业务规则

| 规则                 | 说明                                                                                                                                |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| 提交状态机           | `pending → [judging, error]` → `judging → [finished, error]`，finished/error 为终态                                                 |
| 输出截断             | API 返回时截断至 8KB（`MAX_OUTPUT_LENGTH`），数据库保留完整内容                                                                     |
| 代码大小上限         | 100KB（`MAX_CODE_LENGTH`），路由层校验                                                                                              |
| 个人简介上限         | 5000 字符                                                                                                                           |
| 支持包读取失败       | 非致命：日志记录后继续（无支持包），由 judge 端处理                                                                                 |
| 题目更新             | 静默忽略 `type` 和 `number` 字段（API 接受但不处理）                                                                                |
| 题目编号冲突         | 自动分配时重试 3 次（PG 23505），手动指定时立即报错                                                                                 |
| 评测结果写入         | UPSERT 语义（`onConflictDoUpdate`），用最新结果覆盖旧数据；配合 `rejudge_seq` 防护乱序覆盖                                          |
| 队列位置查询         | 即使 DB 状态为 "judging" 也检查 Redis 队列（状态在入队时已更新）                                                                    |
| 问题列表默认         | 默认只显示 `type='P'` 的题目，U 类型需直接 URL 或所有者主页访问                                                                     |
| 分页默认值           | page=1, per_page=20, max per_page=100                                                                                               |
| 用户枚举防护         | 登录失败统一返回"用户名或密码错误"，不区分"用户不存在"和"密码错误"                                                                  |
| Root 用户            | UID="0"，admin 角色，随机密码不可登录，不计入管理员统计，不出现在用户列表                                                           |
| 密码重置邮箱枚举防护 | `POST /forgot-password` 不管邮箱是否存在都返 200 + 同一消息（与登录失败防枚举共存）                                                 |
| 密码重置令牌         | DB 存 SHA-256 hex 哈希（**不存明文**），URL 传明文 base64url；32 字节随机数                                                         |
| 密码重置 TTL         | 15 分钟（OWASP 2025+ 建议 ≤ 15 分钟），单 SQL 原子消耗防并发                                                                        |
| 密码重置邮件         | 策略模式：`EMAIL_PROVIDER` 选择 mock（默认）/ aliyun / tencent；mock 为控制台输出；真实 Provider 在发送前校验环境变量完整性         |
| 引导管理员           | 无可登录 admin 且未设 ADMIN_EMAIL 时，bootstrap admin 自动创建 username=admin 临时账号，must_change_password=true，终端打印随机密码 |
| 强制改密守卫         | authMiddleware 检测 token.must_change_password=true，白名单（/change-password, /me）外全部 403 PASSWORD_CHANGE_REQUIRED             |
| change-password限流  | 独立 pwchange 命名空间，不污染 /login 限流桶（issue #75 评审 H4）                                                                   |

## 登录速率限制（issue #73）

三机制组合使用，配置项全部支持环境变量覆盖（见 `.env.example`）：

| 维度     | 默认值    | Redis Key                    | 说明                                            |
| -------- | --------- | ---------------------------- | ----------------------------------------------- |
| IP 窗口  | 30s/10 次 | `ratelimit:login:ip:<ip>`    | 单 IP 暴力破解防护                              |
| 账号窗口 | 30s/5 次  | `ratelimit:login:acc:<user>` | 分布式撞同一账号防护                            |
| 失败计数 | 10 次触发 | `loginfail:<user>`           | 跨进程一致（Redis）                             |
| 失败退避 | +15s/次   | 内存 Map `inMemoryBackoff`   | 不阻塞响应（不依赖 Redis）                      |
| 失败锁定 | 1h TTL    | `loginlock:<user>`           | 阈值后拒绝登录，需 `clearLoginFailure` 或等 TTL |

**响应头**（触发限流时返回 429）：

```
X-RateLimit-Limit: 10
X-RateLimit-Remaining: 0
X-RateLimit-Reset: 1751606400
Retry-After: 25
```

**架构决策**：

- 服务层（`services/auth.ts`）保持纯粹，限流逻辑全部在路由层 + 中间件
- IP 维度用中间件（`loginIpRateLimit()`），账号/锁定/退避在路由 handler 内
- 失败时"立即返 401 + 下次 sleep"，避免暴露失败响应时间差
- 总开关 `RATE_LIMIT_ENABLED` + `NOJ_ENV=test` 强制关闭（测试环境）
- 生产部署需要**配置可信代理白名单**才能正确解析
  `X-Forwarded-For`（默认信任首项）

## 全局搜索（issue #100）

`GET /api/v1/search` 是统一的全局搜索入口，覆盖题目搜索（公开）与用户搜索
（admin only），分页返回。设计文档见
`docs/superpowers/specs/2026-07-13-global-search-design.md`。

**数据库列**：

- `problems.search_vector` — `tsvector` GENERATED 列：
  `setweight(to_tsvector('simple', coalesce(title,'')), 'A')` + `||`
  `setweight(to_tsvector('simple', coalesce(type,'')||' '||coalesce(number::text,'')), 'B')`
- `users.search_vector` — `tsvector` GENERATED 列：`username` 权重 A + `email`
  权重 B
- 由 PostgreSQL `GENERATED ALWAYS AS ... STORED` 自动维护，应用层只读

**索引策略**（双 GIN 索引，中英文友好）：

- `idx_*_search_vector` — GIN(tsvector)，英文/数字分词精确匹配
- `idx_*_title_trgm` / `idx_users_username_trgm` — GIN(pg_trgm)，中文 trigram
  模糊匹配
- 查询走 `tsvector @@ websearch_to_tsquery(...) OR ILIKE '%q%'` 联合，PG planner
  自动选最优索引

**权重设计**：`title`/`username` = A (1.0)，`display_id`/`email` = B (0.4)，
`ts_rank` 自动按权重排序。

**权限矩阵**：

| type      | 匿名       | 登录用户   | admin                       |
| --------- | ---------- | ---------- | --------------------------- |
| `problem` | ✅ 仅 P 型 | ✅ 仅 P 型 | ✅ U+P（`?include_u=true`） |
| `user`    | ❌ 401     | ❌ 403     | ✅                          |

**输入校验**：

- `q`：trim 后 2 ≤ length ≤ 100；UTF-8
- `type`：enum `problem` \| `user`
- `page`：1 ≤ page ≤ 1000（默认 1）
- `limit`：1 ≤ limit ≤ 50（默认 20）
- `include_u`：boolean（admin + type=problem 时生效）

**SQL 安全**：

- 用户输入通过 Drizzle `sql\`...${input}...\`` 占位符参数化
- `q` 字符串经 `websearch_to_tsquery` 处理，避免 tsquery 注入
- `ILIKE` 子串经 `escapeLikePattern()` 转义 `%`/`_`/`\`，配合 `ESCAPE '\'` 子句
  （`dcabe8d`，reviewer issue 2）

**响应字段**：

- 题目：`{id, type, number, display_id, title, difficulty, rank, highlight}`
- 用户：`{id, username, email, role, rank, highlight}`
- 高亮：用 `[[HIGHLIGHT]]...[[/HIGHLIGHT]]` marker 包裹（非 HTML），前端
  `SearchResultItem` 替换为 `<mark>`
- 响应头：`X-Search-Took-Ms`、`X-Search-Query`、触发限流时附 `X-RateLimit-*` +
  `Retry-After`

**搜索限流**（与登录限流**独立桶**，避免互相污染）：

| 维度     | Redis Key                         | 默认配置   |
| -------- | --------------------------------- | ---------- |
| 匿名 IP  | `ratelimit:search:ip:<ip>`        | 30s/60 次  |
| 登录用户 | `ratelimit:search:user:<user_id>` | 30s/120 次 |
| admin    | 不限流                            | —          |

通过 `lib/settings-registry.ts` 注册 4 个配置项（`rate_limit_search_*`），由
`searchRateLimit("anon")` 中间件在 `/api/v1/search` 路径级统一处理，admin 经
`c.get("userRole")` 跳过。

**Service 层防御性鉴权**（`dcabe8d`，reviewer issue 3）：

- `searchUsers()` 入口检查 `params.isAdmin === true`，否则
  `throw new
  ForbiddenError`，路由守卫缺失时也 fail-closed
- `searchProblems()` 默认仅返回 `type='P'`，admin 显式传 `includeU=true` 才返回
  U+P

**实现文件**：

- 路由：`src/routes/search.ts`（`optionalAuthMiddleware` + 权限校验 + service
  调用）
- 服务：`src/services/search.ts`（`searchProblems` / `searchUsers`， tsvector +
  ILIKE 联合查询）
- 中间件：`src/middleware/searchRateLimit.ts`（Redis 固定窗口）
- Schema：`src/db/schema.ts`（`tsvector` customType + GIN 索引定义）

## CORS 配置

| 环境                                | 行为                                                      |
| ----------------------------------- | --------------------------------------------------------- |
| 开发（默认）                        | 仅允许 `http://localhost:3000` 与 `http://127.0.0.1:3000` |
| 生产（`CORS_ALLOWED_ORIGINS` 设置） | 仅允许白名单域名，空列表拒绝所有跨域请求                  |

- `credentials: true`（为 Cookie 认证预留）
- 暴露 `Retry-After`、`X-RateLimit-*`、`X-Request-Id`
  响应头，供前端读取限流和请求追踪信息
- `maxAge: 86400`（预请求缓存 24h）
- 允许方法：`GET, POST, PUT, PATCH, DELETE, OPTIONS`
- 允许头：`Content-Type, Authorization`

## 测试约定

- DB 依赖测试检查 `!!Deno.env.get("DATABASE_URL")` 和
  `!!Deno.env.get("JWT_SECRET")`，缺失时设置 `ignore: true` 静默跳过
- 使用 `sanitizeResources: false, sanitizeOps: false`（postgres.js 连接池触发
  Deno 资源泄漏检测）
- `resetDbForTest()` 在每个测试前重置单例状态
- 测试命名格式：`"module: description"`（`Deno.test({ name, ignore, sanitizeResources, sanitizeOps, fn })`）
- 清理测试在文件末尾执行，通过 `db.delete()` 直接删除测试数据
- 测试数据使用 `Date.now()` 生成唯一用户名/邮箱避免冲突
- `00_migrate_test.ts` 按字母序最先执行，负责迁移和 seed root 用户
- 路由测试使用 `jsonRequest()` 辅助函数创建原始 `Request` 对象（确保 Hono
  路由兼容性）

## CLI 说明

| 命令                                                          | 行为                                                                                                                    |
| ------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `deno task dev-setup`（`scripts/noj.ts dev-setup`）           | 幂等：迁移 → 系统基础数据（root/RBAC/镜像白名单/标签）→ 管理员引导 → 构建题目包 → 导入题目包 → dev 专用数据（E2E 用户） |
| `deno task problems:build`（`scripts/noj.ts problems build`） | 调用系统 `zip` 命令（非 JS 库），在 `data/problems-src/<id>/` 目录执行，排除 `submission*`/`__pycache__`/`.git`         |
| `deno task db:migrate`（`scripts/noj.ts db migrate`）         | 日志中脱敏数据库密码（`"//***@"`），迁移后关闭 DB 连接确保进程退出                                                      |

## 评测脚本协议（Judge 集成）

noj-core 不直接执行评测，但 `data/problems-src/` 中的 evaluate.py 遵循以下约定
（双容器架构）：

- 可见测试用例：`visible.jsonl`，隐藏测试用例：`hidden.jsonl`（位于支持包 zip
  中）
- evaluate.py 运行在 **Evaluator 容器**，通过
  `noj_evaluator_sdk.runner.SolutionRunner` 与 **Solution
  容器**（承载用户代码）交互（NDJSON 帧协议，见
  `noj-judge/src/dual/protocol.rs`）
- 输出格式：`---RESULT---` 标记行 + JSON `{status, score, details}`
- 评分公式：每题独立定义在 evaluate.py 中（非通用可配置系统）
- 镜像白名单：`judgeImages` 按 `evaluator` / `solution` 两类 kind 管理

## 题目数据约束

**`data/problems-src/` 仅用于样例题和开发测试。**
正式比赛题目（含隐藏测试数据和评测脚本）**不得提交到此 git 仓库**。 应通过管理
API 或独立的安全通道部署，`support_package_path` 指向受控存储。

## 贡献要求

- **所有提交必须 GPG 签名**（详见根目录 README.md）
- **所有代码必须通过 PR 提交**，禁止直接推送到 main
- 提交信息格式：`feat(core): 中文描述` / `fix(core): 中文描述`

## 相关文档

- [Hono 文档](https://hono.dev/)
- [Deno 文档](https://docs.deno.com/)
- [Drizzle ORM](https://orm.drizzle.team/)
- [ioredis](https://github.com/redis/ioredis)
