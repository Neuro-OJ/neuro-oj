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
│   ├── routes/            # 路由层（参数校验 + 调用 service）
│   ├── services/          # 业务逻辑层（数据库读写）
│   ├── db/                # 数据库连接 & Drizzle schema
│   │   ├── index.ts       # 数据库连接管理（单例模式）
│   │   ├── migrate.ts     # 迁移执行器（绝对路径解析，不依赖 CWD）
│   │   └── schema/        # Drizzle 表定义
│   ├── middleware/         # 认证中间件
│   ├── mq/                # Redis 消息队列（Producer + Consumer）
│   ├── lib/               # 工具函数（JWT、密码、错误类、请求解析、日志）
│   │   ├── errors.ts      # AppError 继承体系（6 个子类）
│   │   ├── jwt.ts         # JWT 签发/验证（HS256, iss/aud 校验）
│   │   ├── password.ts    # bcrypt 哈希/比对（cost 12）
│   │   ├── request.ts     # parseJsonBody<T>() 安全 JSON 解析
│   │   └── logging.ts     # 生产安全日志（UUID 截断、分值隐藏）
│   └── types/             # 类型定义
│       ├── auth.ts        # RegisterInput, LoginInput, UserResponse
│       └── problems.ts    # DIFFICULTIES, PROBLEM_TYPES, 校验函数
├── scripts/               # CLI 脚本（seed、build-packages、migrate）
├── data/
│   ├── problems-src/<id>/ # 题目源文件（版本控制，仅样例题）
│   └── packages/<id>.zip  # 构建产物（gitignored）
└── tests/                 # 测试文件（与 src 镜像结构）
    ├── 00_migrate_test.ts # 最先执行：迁移 + seed root 用户
    ├── services/          # 服务层测试
    └── routes/            # 路由层测试（使用 jsonRequest() 辅助函数）
```

## 环境变量

从 `.env` 文件或 `Deno.env` 读取。**必须配置**：

| 变量                       | 默认值                    | 说明                             |
| -------------------------- | ------------------------- | -------------------------------- |
| `DATABASE_URL`             | —                         | PostgreSQL 连接串（无默认值）    |
| `JWT_SECRET`               | —                         | HS256 签名密钥（≥32 字符）       |
| `JWT_EXPIRES_IN`           | `24h`                     | Token 有效期                     |
| `REDIS_URL`                | `redis://127.0.0.1:6379/` | Redis 连接串                     |
| `PORT`                     | `8000`                    | HTTP 监听端口                    |
| `NOJ_ENV`                  | 空（development）         | `production` 启用生产模式        |
| `ADMIN_EMAIL`              | —                         | Seed 管理员邮箱                  |
| `ADMIN_PASS`               | —                         | Seed 管理员密码                  |
| `DATABASE_POOL_MAX`        | `10`                      | PostgreSQL 连接池大小            |
| `DATABASE_CONNECT_TIMEOUT` | `10`                      | 连接超时秒数                     |
| `DATABASE_IDLE_TIMEOUT`    | `300`                     | 空闲连接超时秒数                 |
| `DATABASE_MAX_LIFETIME`    | `3600`                    | 连接最大生命周期秒数             |
| `CORS_ALLOWED_ORIGINS`     | —                         | 生产环境 CORS 白名单（逗号分隔） |

## 开发命令

```bash
# 开发模式（热重载）
deno task dev

# 生产运行
deno task start

# 数据库迁移（启动时自动执行，也可单独运行）
deno task migrate

# 生成 Drizzle 迁移文件
deno task db:generate

# 种子数据（示例题 + 分类 + 管理员）
deno task seed

# 构建支持包
deno task build-packages

# 一键初始化
deno task setup          # = build-packages + seed

# 测试
deno task test
```

## 基础设施

```bash
docker compose up -d    # 启动 PostgreSQL:5432 + Redis:6379
docker compose down     # 停止
```

## API 路由

| 方法   | 路径                             | 权限   | 说明                                         |
| ------ | -------------------------------- | ------ | -------------------------------------------- |
| POST   | `/api/v1/auth/register`          | 公开   | 用户注册                                     |
| POST   | `/api/v1/auth/login`             | 公开   | 用户登录（返回 JWT）                         |
| GET    | `/api/v1/auth/me`                | 登录   | 当前用户信息                                 |
| GET    | `/api/v1/categories`             | 公开   | 分类树                                       |
| POST   | `/api/v1/categories`             | 管理员 | 创建分类                                     |
| GET    | `/api/v1/categories/:id`         | 公开   | 分类详情                                     |
| PUT    | `/api/v1/categories/:id`         | 管理员 | 更新分类                                     |
| DELETE | `/api/v1/categories/:id`         | 管理员 | 删除分类                                     |
| GET    | `/api/v1/problems`               | 公开   | 题目列表（分页+筛选）                        |
| GET    | `/api/v1/problems/:id`           | 公开   | 题目详情（**双索引**：UUID/display_id/数字） |
| POST   | `/api/v1/problems`               | 登录   | 创建题目（U/P 类型）                         |
| PUT    | `/api/v1/problems/:id`           | 登录   | 更新题目                                     |
| DELETE | `/api/v1/problems/:id`           | 登录   | 删除题目                                     |
| GET    | `/api/v1/submissions`            | 登录   | 我的提交列表                                 |
| POST   | `/api/v1/submissions`            | 登录   | 创建提交                                     |
| GET    | `/api/v1/submissions/:id`        | 登录   | 提交详情                                     |
| GET    | `/api/v1/submissions/:id/status` | 登录   | 提交队列状态                                 |
| GET    | `/api/v1/admin/submissions`      | 管理员 | 全部提交管理                                 |
| GET    | `/api/v1/admin/users`            | 管理员 | 用户列表                                     |
| PATCH  | `/api/v1/admin/users/:id/role`   | 管理员 | 角色变更                                     |
| GET    | `/api/v1/users/:id/profile`      | 公开   | 用户主页                                     |
| PUT    | `/api/v1/users/me`               | 登录   | 更新个人简介                                 |
| GET    | `/health`                        | 公开   | 健康检查                                     |

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
- 两者独立，避免 BRPOP 阻塞影响 LPUSH
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
4. **连接 Redis** — 失败则 degraded 模式（HTTP 仍启动，评测功能不可用）
5. **启动评测结果消费者** — 后台自动重连（指数退避 1s→2s→4s→…→30s）
6. **启动 HTTP 服务**

## 数据库 Schema 设计

| 表                    | 关键列                                                                                                | 约束 / 索引                                                    |
| --------------------- | ----------------------------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| `users`               | `id`(UUID), `username`(unique), `email`(unique), `password_hash`, `role`(user/admin), `bio`           | PK, UK(username), UK(email)                                    |
| `problems`            | `id`(UUID), `type`(U/P), `number`(int), `display_id`(unique), `title`, `difficulty`, `owner_id`       | PK, UK(display_id), UK(type,number), FK→users                  |
| `categories`          | `id`(UUID), `name`, `parent_id`, `level`(缓存深度)                                                    | PK, FK→categories(parent_id) ON DELETE SET NULL                |
| `problems_categories` | `problem_id`, `category_id`                                                                           | FK→problems ON DELETE CASCADE, FK→categories ON DELETE CASCADE |
| `submissions`         | `id`(UUID), `user_id`, `problem_id`, `status`, `language`, `code`                                     | PK, FK→users, FK→problems, idx(user_id,created_at)             |
| `evaluation_results`  | `id`(UUID), `submission_id`(unique), `status`, `score`(INTEGER×100), `output`, `time_ms`, `memory_kb` | PK, UK(submission_id), FK→submissions                          |

**设计要点**：

- 所有时间戳使用 ISO 8601 **文本**格式存储（非原生 `timestamptz`）
- `evaluation_results.score` 为 `INTEGER`（×100），`scoreToDb`/`scoreFromDb`
  在应用层转换
- `problems.number` 按 `type` 分别自增（`(type, number)` UNIQUE）
- `categories.level` 为应用层计算的缓存深度（非触发器自动维护）
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

| 规则           | 说明                                                                                |
| -------------- | ----------------------------------------------------------------------------------- |
| 提交状态机     | `pending → [judging, error]` → `judging → [finished, error]`，finished/error 为终态 |
| 输出截断       | API 返回时截断至 8KB（`MAX_OUTPUT_LENGTH`），数据库保留完整内容                     |
| 代码大小上限   | 100KB（`MAX_CODE_LENGTH`），路由层校验                                              |
| 个人简介上限   | 5000 字符                                                                           |
| 支持包读取失败 | 非致命：日志记录后继续（无支持包），由 judge 端处理                                 |
| 题目更新       | 静默忽略 `type` 和 `number` 字段（API 接受但不处理）                                |
| 题目编号冲突   | 自动分配时重试 3 次（PG 23505），手动指定时立即报错                                 |
| 评测结果写入   | UPSERT 语义（`onConflictDoNothing`），防止重复处理                                  |
| 队列位置查询   | 即使 DB 状态为 "judging" 也检查 Redis 队列（状态在入队时已更新）                    |
| 问题列表默认   | 默认只显示 `type='P'` 的题目，U 类型需直接 URL 或所有者主页访问                     |
| 分页默认值     | page=1, per_page=20, max per_page=100                                               |
| 用户枚举防护   | 登录失败统一返回"用户名或密码错误"，不区分"用户不存在"和"密码错误"                  |
| Root 用户      | UID="0"，admin 角色，随机密码不可登录，不计入管理员统计，不出现在用户列表           |

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

## CORS 配置

| 环境                                | 行为                                     |
| ----------------------------------- | ---------------------------------------- |
| 开发（默认）                        | `Access-Control-Allow-Origin: *`         |
| 生产（`CORS_ALLOWED_ORIGINS` 设置） | 仅允许白名单域名，空列表拒绝所有跨域请求 |

- `credentials: true`（为 Cookie 认证预留）
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

## 脚本说明

| 脚本                        | 行为                                                                                         |
| --------------------------- | -------------------------------------------------------------------------------------------- |
| `scripts/seed.ts`           | 幂等（`ON CONFLICT DO NOTHING`），先迁移→确保 root 用户→种子数据，`finally` 中关闭 DB 连接   |
| `scripts/build-packages.ts` | 调用系统 `zip` 命令（非 JS 库），在 `data/problems-src/<id>/` 目录执行，排除 `submission.py` |
| `scripts/migrate.ts`        | 日志中脱敏数据库密码（`"//***@"`），迁移后关闭 DB 连接确保进程退出                           |

## 评测脚本协议（Judge 集成）

noj-core 不直接执行评测，但 `data/problems-src/` 中的 evaluate.py 遵循以下约定：

- 可见测试用例：`visible.jsonl`，隐藏测试用例：`hidden.jsonl`（位于支持包 zip
  中）
- 用户代码路径：`/tmp/main.py`（或对应扩展名）
- 输出格式：`---RESULT---` 标记行 + JSON `{status, score, details}`
- 超时处理：evaluate.py 内部使用 `subprocess.run(timeout=TIMEOUT)`
- 评分公式：每题独立定义在 evaluate.py 中（非通用可配置系统）

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
