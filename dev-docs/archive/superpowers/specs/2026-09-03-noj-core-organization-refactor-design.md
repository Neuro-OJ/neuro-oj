# noj-core 组织架构重构设计：域归属收拢 + 共享层分类

> Status: design
> Date: 2026-09-03
> Scope: noj-core

## 1. 背景与问题

noj-core 已完成主要业务代码的 `src/domains/` 域化迁移，但以下“全局横切目录”仍保留大量有明确业务归属的内容：

- `src/lib/`：44 个文件，混合了通用工具（logging/errors/pagination）和业务归属很强的模块（permissions/jwt/settings-registry/problem-resolve）。
- `src/middleware/`：6 个文件，其中 auth/login-rate-limit/banlist 属于 identity，search-rate-limit 属于 query。
- `src/mq/`：6 个文件，connection/base-consumer 是共享基础设施，consumer/producer/sweeper 属于 submission，review-consumer 属于 content-review。
- `src/routes/`：只剩 health、sse、admin barrel；但 `sse.ts` 混入了 submission/query/contest/community 的 SSE 端点。
- `src/types/`：10 个文件，多数是领域类型（contests/problems/community/objective/…）。

这导致读代码时需要在“全局目录”和“域目录”之间来回跳转，归属不直观；路由注册集中在 `app.ts`，import 列表很长且顺序敏感；测试仍按旧结构镜像，未随域内聚。

## 2. 目标

1. **域归属收拢**：把明显属于某域的 middleware、MQ 消费者、SSE 路由、类型、业务工具从全局目录迁入对应 `domains/<domain>/`。
2. **共享层分类**：新建 `src/shared/`，只保留真正跨域复用且无业务归属的基础设施；`shared/` 不反向依赖 `domains/**`。
3. **路由域自装配**：每个域提供自己的 `routes/index.ts`，`app.ts` 只做全局中间件 + 按域挂载。
4. **测试随域走**：领域测试迁移到 `domains/<domain>/tests/`，共享测试保留在顶层 `tests/shared/`。
5. **不改变任何行为**：API 路径、鉴权语义、MQ 队列名、SSE 事件名保持完全不变。

## 3. 目标目录总览

```text
noj-core/src/
├── app.ts                     # 全局中间件 + 按域挂载路由（装配点）
├── main.ts                    # 启动与生命周期（不变）
├── shared/                    # 跨域共享内核（无业务归属）
│   ├── base/                  # errors.ts、logging.ts、constants.ts、dates.ts、sql-rows.ts
│   ├── config/                # settings-registry.ts、production-config.ts
│   ├── db/                    # connection / migrate / schema（现有 db/ 整体迁入）
│   ├── http/                  # request.ts、pagination.ts、file-stream.ts、hono-env.ts
│   ├── sse/                   # event-bus.ts、sse-stream.ts、sse-events.ts、server-helpers.ts
│   ├── mq/                    # connection.ts、base-consumer.ts
│   ├── rate-limit/            # rate-limit.ts、rate-limit-env.ts、hardening-rate-limit.ts
│   ├── security/              # cidr.ts、public-id.ts、image-validation.ts
│   ├── storage/               # 现有 lib/storage/ 整体迁入
│   ├── email/                 # 现有 lib/email.ts + lib/email-providers/ 整体迁入
│   └── middleware/            # request-context.ts、rate-limit.ts（通用内存限流）
├── routes/
│   ├── health.ts              # 健康检查（顶层基础设施路由）
│   └── admin/index.ts         # 管理端路由组合根
└── domains/
    ├── identity/
    │   ├── middleware/        # auth、login-rate-limit、banlist
    │   ├── services/          # 现有服务 + jwt/password/tfa/resetToken/revokedTokens/loginThrottle/banCache/permissions
    │   ├── routes/            # auth/users/checkin/admin-* + routes/index.ts
    │   ├── types/             # auth.ts、permissions.ts
    │   └── tests/
    ├── catalog/
    │   ├── services/          # 现有服务 + problem-resolve/bundle-parser
    │   ├── routes/            # problems/tags/trainings/admin-* + routes/index.ts
    │   ├── types/             # problems.ts、problem-bundle.ts、trainings.ts、runtime-config.ts
    │   └── tests/
    ├── submission/
    │   ├── mq/                # consumer.ts、producer.ts、sweeper.ts
    │   ├── routes/            # submissions/queue/self-tests/sse + routes/index.ts
    │   ├── types/             # index.ts（JudgeTask/JudgeResult）、self-tests.ts
    │   └── tests/
    ├── query/
    │   ├── middleware/        # search-rate-limit.ts
    │   ├── routes/            # rankings/search/stats/statsSSE + routes/index.ts
    │   └── tests/
    ├── contest/
    │   ├── routes/            # contests/admin-contests/contestSSE + routes/index.ts
    │   ├── types/             # contests.ts
    │   └── tests/
    ├── community/
    │   ├── routes/            # community/community-admin/notificationsSSE + routes/index.ts
    │   ├── types/             # community.ts
    │   └── tests/
    ├── messaging/
    │   ├── routes/            # conversations + routes/index.ts
    │   └── tests/
    ├── objective/
    │   ├── services/          # 现有服务
    │   ├── types/             # objective.ts
    │   └── tests/
    ├── system/
    │   ├── services/          # 现有服务 + env-snapshot.ts
    │   ├── routes/            # announcements/admin-* + routes/index.ts
    │   ├── types/             # audit-log.ts
    │   └── tests/
    ├── gateway/
    │   ├── services/          # 现有服务 + llm-token.ts
    │   └── tests/
    └── content-review/
        ├── mq/                # review-consumer.ts
        └── tests/
```

## 4. 核心原则

1. `src/shared/**` 不得反向依赖 `src/domains/**`。
2. 域间只允许通过 `domains/<domain>/index.ts` 门面导入。
3. 路由域自装配：`app.ts` 不逐个 import 路由文件，只挂载各域 `routes/index.ts` 与管理端组合根。
4. 测试随域走，共享测试保留顶层 `tests/shared/`。
5. 本重构不修改数据库 schema、不修改 API 路径、不修改业务行为。

## 5. 共享层详细清单

| 新位置 | 文件/模块 | 说明 |
|---|---|---|
| `shared/base/` | `errors.ts`、`logging.ts`、`constants.ts`、`dates.ts`、`sql-rows.ts` | 无业务归属的基础设施 |
| `shared/config/` | `settings-registry.ts`、`production-config.ts` | 配置注册表被 `rate-limit-env` 等共享代码依赖，必须留在共享层 |
| `shared/db/` | 现有 `db/` 整体迁入 | connection / migrate / schema |
| `shared/http/` | `request.ts`、`pagination.ts`、`file-stream.ts`、`hono-env.ts` | HTTP 请求解析、分页、流、Hono Env 类型 |
| `shared/sse/` | `event-bus.ts`、`sse-stream.ts`、`sse-events.ts`、`server-helpers.ts` | SSE 事件总线、流工具、订阅/重放辅助 |
| `shared/mq/` | `mq/connection.ts`、`mq/base-consumer.ts` | Redis 连接与通用消费者基类 |
| `shared/rate-limit/` | `rate-limit.ts`、`rate-limit-env.ts`、`hardening-rate-limit.ts` | 通用限流能力 |
| `shared/security/` | `cidr.ts`、`public-id.ts`、`image-validation.ts` | IP/CIDR、公共 ID、图片校验 |
| `shared/storage/` | 现有 `lib/storage/` 整体迁入 | StorageProvider 抽象与 local/S3 实现 |
| `shared/email/` | 现有 `lib/email.ts` + `lib/email-providers/` | 邮件抽象与 Provider |
| `shared/middleware/` | `request-context.ts`、`rate-limit.ts` | 全局中间件 |

### 从 `lib/` 迁入各域

| 目标域 | 迁入文件 |
|---|---|
| `identity` | `jwt.ts`、`password.ts`、`tfa.ts`、`resetToken.ts`、`revokedTokens.ts`、`loginThrottle.ts`、`banCache.ts`、`permissions.ts` |
| `catalog` | `problem-resolve.ts`、`bundle-parser.ts` |
| `gateway` | `llm-token.ts` |
| `system` | `env-snapshot.ts` |

### 关键取舍

- `settings-registry.ts` **不迁入 system 域**：`rate-limit-env.ts`、`middleware/search-rate-limit.ts` 等共享/域代码依赖它；若迁入 system 会导致 `shared/` 反向依赖 `domains/`。因此留在 `shared/config/`。
- `permissions.ts` 迁入 identity 域，其他域通过 `domains/identity/index.ts` 门面使用。
- `public-id.ts` 留在 `shared/security/`，因为它被多个域复用。

## 6. 中间件 / MQ / 路由 / 类型收拢清单

### 6.1 Middleware

| 文件 | 去向 |
|---|---|
| `src/middleware/auth.ts` | `domains/identity/middleware/auth.ts` |
| `src/middleware/login-rate-limit.ts` | `domains/identity/middleware/login-rate-limit.ts` |
| `src/middleware/banlist.ts` | `domains/identity/middleware/banlist.ts` |
| `src/middleware/search-rate-limit.ts` | `domains/query/middleware/search-rate-limit.ts` |
| `src/middleware/request-context.ts` | `shared/middleware/request-context.ts` |
| `src/middleware/rate-limit.ts` | `shared/middleware/rate-limit.ts` |
| `app.ts` 内 `maintenanceMode` | 抽到 `shared/middleware/maintenance.ts`（可选） |

`auth.ts` 导出的 `AuthEnv` / `OptionalAuthEnv` 抽到 `shared/http/hono-env.ts`，避免所有域路由深路径 import identity 中间件。identity 门面可 `export type { AuthEnv }` 作为兼容出口。

### 6.2 MQ

| 文件 | 去向 |
|---|---|
| `src/mq/connection.ts` | `shared/mq/connection.ts` |
| `src/mq/base-consumer.ts` | `shared/mq/base-consumer.ts` |
| `src/mq/consumer.ts` | `domains/submission/mq/consumer.ts` |
| `src/mq/producer.ts` | `domains/submission/mq/producer.ts` |
| `src/mq/sweeper.ts` | `domains/submission/mq/sweeper.ts` |
| `src/mq/review-consumer.ts` | `domains/content-review/mq/review-consumer.ts` |

### 6.3 Routes（SSE 拆分）

| 现有端点 | 去向 |
|---|---|
| `GET /submissions/:id/events` | `domains/submission/routes/sse.ts` |
| `GET /queue/events` | `domains/submission/routes/sse.ts` |
| `GET /submissions/stats/events` | `domains/query/routes/sse.ts` |
| `GET /contests/:id/events` | `domains/contest/routes/sse.ts` |
| `GET /community/notifications/events` | `domains/community/routes/sse.ts` |
| `subscribeToChannel` / `replayToStream` / `lastEventId` | `shared/sse/server-helpers.ts` |

`src/routes/health.ts` 保留为顶层基础设施路由；`src/routes/admin/index.ts` 保留为管理端组合根。

### 6.4 Types

| 文件 | 去向 |
|---|---|
| `src/types/auth.ts` | `domains/identity/types/auth.ts` |
| `src/types/problems.ts` | `domains/catalog/types/problems.ts` |
| `src/types/problem-bundle.ts` | `domains/catalog/types/problem-bundle.ts` |
| `src/types/trainings.ts` | `domains/catalog/types/trainings.ts` |
| `src/types/index.ts` | **按所有权拆分**，见 6.5 |
| `src/types/self-tests.ts` | `domains/submission/types/self-tests.ts` |
| `src/types/contests.ts` | `domains/contest/types/contests.ts` |
| `src/types/community.ts` | `domains/community/types/community.ts` |
| `src/types/objective.ts` | `domains/objective/types/objective.ts` |
| `src/types/audit-log.ts` | `domains/system/types/audit-log.ts` |
| `src/types/` | 迁移完成后删除 |

### 6.5 `src/types/index.ts` 按所有权拆分

`src/types/index.ts` 不是单一 submission 类型文件，需要按内容拆分：

| 导出内容 | 去向 |
|---|---|
| `EvaluatorRuntime` / `SolutionRuntime` / `RuntimeConfig` | `domains/catalog/types/runtime-config.ts`（题目侧运行配置） |
| `JudgeTaskLlm` / `JudgeTask` / `JudgeResult` / `SubmissionStatus` / `SUBMISSION_STATUSES` / `assertNever` / `isTerminalSubmissionStatus` / `SCORE_SCALE` / `scoreToDb` / `scoreFromDb` / `LANGUAGE_EXT_MAP` | `domains/submission/types/index.ts`（评测协议/提交侧） |
| `PermissionName` / `PERMISSION_DEFS` | `domains/identity/types/permissions.ts`（RBAC） |

依赖方向：submission 的 `JudgeTask` 通过 `domains/catalog/index.ts` 门面引用 `RuntimeConfig`；catalog 的 `problems.ts` 在域内直接引用 `runtime-config.ts`。

## 7. 路由域自装配

### 7.1 每域 `routes/index.ts`

```ts
// domains/identity/routes/index.ts
import { Hono } from "hono";
import auth from "./auth.ts";
import users from "./users.ts";
import checkin from "./checkin.ts";

export const identityRouter = new Hono();
identityRouter.route("/auth", auth);
identityRouter.route("/users", users);
identityRouter.route("/checkin", checkin);

export const identityAdminRouter = new Hono();
// admin-users / admin-roles / admin-blacklist ...
```

### 7.2 `app.ts` 简化

```ts
app.route("/", health);
app.route("/api/v1", identityRouter);
app.route("/api/v1", catalogRouter);
app.route("/api/v1", submissionRouter);
app.route("/api/v1", queryRouter);
app.route("/api/v1", contestRouter);
app.route("/api/v1", communityRouter);
app.route("/api/v1", messagingRouter);
app.route("/api/v1", systemRouter);
app.route("/api/v1/admin", adminRouter);
```

### 7.3 管理端组合根

`src/routes/admin/index.ts` 保留组级 `authMiddleware + adminMiddleware`，改为从各域 `routes/index.ts` 收集 `xxxAdminRouter` 并挂载。`FINE_GRAINED_ADMIN_PREFIXES` 逻辑保持不变。

### 7.4 门面导出策略

- `domains/<domain>/index.ts` 继续作为服务门面。
- 被其他域使用的中间件通过门面导出；`AuthEnv` / `OptionalAuthEnv` 类型统一放 `shared/http/hono-env.ts`。
- `shared/` 不导出 Hono 实例，只导出工具/类型/中间件。

### 7.5 顺序敏感约束

现有 `app.ts` 中关于 SSE 必须在某些路由之前注册的注释，下沉到各域 `routes/index.ts` 内部并就地说明。`app.ts` 只保留真正全局的中间件顺序。

## 8. 测试随域走

### 8.1 目标结构

```text
noj-core/
├── tests/                      # 全局/共享测试基建
│   ├── 00_migrate_test.ts
│   ├── _setup.ts
│   ├── preload.ts
│   ├── helper.ts
│   ├── shared/                 # 对应 src/shared/ 的测试
│   ├── app.test.ts             # 全局装配/集成
│   └── smoke.test.ts
└── src/domains/
    ├── identity/tests/
    ├── catalog/tests/
    ├── submission/tests/
    ├── query/tests/
    ├── contest/tests/
    ├── community/tests/
    ├── messaging/tests/
    ├── objective/tests/
    ├── system/tests/
    ├── gateway/tests/
    └── content-review/tests/
```

### 8.2 迁移规则

- `tests/routes/*`、`tests/services/*`、`tests/middleware/*`、`tests/mq/*`、`tests/types/*` 按第 6 节归属表迁移到对应 `domains/<domain>/tests/`。
- 只测共享模块的测试移到 `tests/shared/`。
- 全局测试基建保留顶层。
- 域内测试之间允许相对导入；跨域需要被测对象时通过域门面导入。
- 保持 `deno task test` / `test:parallel` 执行方式不变，Deno 自动发现嵌套测试。

## 9. 迁移顺序、风险与验证

### 9.1 迁移顺序

| 阶段 | 内容 | 验收 |
|---|---|---|
| P0 试点 | 以 submission 域为试点，先建 `routes/index.ts`，迁入 submission SSE / MQ / 类型 | `check-domains`、`test:parallel` 通过 |
| P1 共享层 | 新建 `src/shared/`，迁入 db、base、http、sse、mq 连接与基类、存储、邮件、限流、配置 | `deno task check` + `test:parallel` 通过 |
| P2 域归属收拢 | identity/catalog/gateway/system 的 lib 迁入对应域；middleware、types、MQ、SSE 按清单迁移 | 每域迁移后跑对应测试 |
| P3 域自装配全量 | 为所有域建 `routes/index.ts`，简化 `app.ts`，管理端组合根改收集各域 adminRouter | 路由目录与现有 API 一致 |
| P4 测试随域走 | 按第 8 节迁移测试，清理顶层残留 | `deno task test:parallel` 全绿 |
| P5 清理与文档 | 删除 `src/lib/`、`src/types/` 空壳，更新 CLAUDE.md、domain-boundaries.md、route-catalog，写 Agent Note | `deno task check`、`check-domains`、`check-all` 全绿 |

### 9.2 关键风险

1. import 路径大规模变更 → 每域一步 + 每步跑测试。
2. Hono 路由顺序敏感 → 顺序约束下沉到域内 `routes/index.ts` 并对照现有注释核对。
3. `shared/` 反向依赖域 → 新增/扩展静态检查，强制 `src/shared/**` 不得 import `src/domains/**`。
4. 类型循环引用 → `AuthEnv` 抽到 shared，各域类型通过门面导出，用 `deno check` 尽早发现。
5. 测试并行执行 → 统一维护 `_setup.ts` / `preload.ts` 路径。

### 9.3 完成标准

- [ ] API 路径、鉴权语义、MQ 队列名、SSE 事件名完全不变
- [ ] `src/lib/`、`src/types/` 删除后无残留引用
- [ ] `src/shared/**` 零反向依赖 `src/domains/**`
- [ ] `deno task check`、`deno task check:domains`、`deno task test:parallel`、`check-all` 全绿
- [ ] `CLAUDE.md` 目录结构章节更新为新的目标结构
