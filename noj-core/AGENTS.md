# noj-core — Neuro OJ 核心后端

基于 **Deno 2 + Hono** 的 RESTful API
服务端：认证授权、题目/提交/竞赛/社区等业务 CRUD，作为 Redis MQ Producer 向
noj-judge 分发评测并消费结果落库。

> 仓库级规则（提交、GPG、迁移安全、多副本约束、测试命令）见根
> [`AGENTS.md`](../AGENTS.md)，此处只记模块特有约定。 **架构方向**：正迁移到
> `shared/` + `features/<name>/` 两层，结构、依赖规则与 分阶段计划以
> [openspec/changes/refactor-core-feature-slices/](../openspec/changes/refactor-core-feature-slices/)
> 为准（新代码按该提案组织，旧模块「改到即迁」）。

技术栈：Deno 2 + TypeScript、Hono、PostgreSQL 16 + postgres.js + Drizzle ORM、
Redis (ioredis)、JWT (jose) + bcryptjs。

## 目录结构

```text
noj-core/
├── deno.json / drizzle.config.ts / .env.example
├── drizzle/                 # SQL 迁移（自动生成，meta/_journal.json 勿手改）
├── data/                    # problems-src/（样例题源）、packages/（构建产物，gitignored）
├── scripts/                 # noj.ts 单入口 + test-launcher / test-domain.sh / test-shared.sh 等
├── tests/                   # 顶层共享测试与跨模块测试（00_migrate_test.ts 最先执行）
└── src/
    ├── main.ts              # 入口：启动校验 + 初始化顺序
    ├── app.ts / mod.ts      # Hono 应用工厂 / 公共导出
    ├── features/            # 功能切片：一个功能一个目录，index.ts 唯一出口（样例 trainings/）
    ├── features.ts          # 功能清单，一行一个；createApp / 启动流程遍历装配
    ├── modules/             # 业务模块（迁移中，见下）
    │   ├── access/          # identity + workspace：JWT、平台角色、域成员与授权
    │   ├── problems/ evaluations/ contests/ education/ communication/
    │   ├── platform/        # system（设置/公告/审计/存储/邮件）、gateway、observability
    │   ├── assets/ read-models/ runtime/   # 资源、读模型、后台任务运行时
    │   ├── application/     # 写用例编排层（重构中逐步消除）
    │   └── http/            # create-app 与 admin 路由聚合
    └── shared/              # 跨模块基础设施：access base config db http mq observability
                             # rate-limit runtime security sse testing versioning workspace
```

## 固定角色权限

平台角色仅 `user` / `admin`，域内角色仅 `member` / `educator` /
`admin`；能力映射是 静态表
`src/modules/access/identity/services/security/permissions.ts`，无 RBAC 表。

| 事实                      | 用途                     |
| ------------------------- | ------------------------ |
| `users.role`              | 平台角色，单值列 + CHECK |
| `domain_memberships.role` | 域内角色，单值列 + CHECK |
| `domains.owner_id`        | 域负责人，优先于成员角色 |

检查层次（共享请求级缓存）：

- `requireAdmin()`：纯 JWT fast path，用于 `/api/v1/admin/*` 路由组
- `requirePermission("x")`：平台能力守卫，只用于平台级端点
- `checkPermission` / `assertPermission`：handler/service 内部条件判断或断言
- `assertWorkspacePermission`（`src/modules/access/workspace/services/access.ts`）：
  域内授权唯一入口，域内权限不得用 `checkPermission` 代替

能力名按 `<resource>:<action>`（如
`problem:write_any`、`system:settings`），完整 清单见 `permissions.ts`
的静态表。

## 环境变量与配置分层

注册表单一事实源：`src/shared/config/settings-registry.ts`（`CONFIG_DEFINITIONS`）。
新 env 变量必须登记并同步 `.env.example`；`deno task check:env`
校验键覆盖一致性。

- **runtime（DB-owned，可热改）**：后台 > 系统设置 > 运行时配置写入 DB
  即时生效， 读取链 `DB → env → 默认值`，env 仅作兜底。
- **bootstrap（env-owned，启动期定型）**：读取链 `env → 默认值`（不读
  DB），后台只读 展示；改 `.env` 后需重启。

必填 bootstrap 项：`DATABASE_URL`、`JWT_SECRET`（≥32 字符）、
`TFA_ENCRYPTION_KEY`（≥32 字符，必须独立于 `JWT_SECRET`）。生产环境**必须**配置
`TRUSTED_PROXIES` 才能正确解析 `X-Forwarded-For`。完整变量与默认值见
`.env.example` 与注册表。

## 开发命令

```bash
deno task dev            # 开发模式（watch + .env）
deno task start          # 生产运行
deno task dev-setup      # 幂等首次初始化：迁移 + 系统数据 + 管理员引导 + 题目包 + E2E 用户
deno task db:migrate     # 迁移（启动时也自动执行）
deno task db:generate    # 由 Drizzle schema 生成迁移
deno task problems:build # 构建题目支持包
deno task check          # fmt --check + lint + check:types
deno task check:env      # 注册表与 .env.example 键一致性
```

`deno task dev-setup` 内部走 `scripts/noj.ts dev-setup`；导题目包用
`scripts/noj.ts problems import [--publish]`（不发布则只有草稿，普通访问者读不到），
全量重建搜索索引用 `scripts/noj.ts search reindex`。`data/problems-src/`
仅用于样例 题与开发测试，正式题目（含隐藏数据与评测脚本）不得提交到此仓库。

## 测试

统一由 `scripts/test-launcher.ts` / `scripts/test-domain.sh`
管理隔离资源；运行前 须提供
`TEST_PG_ADMIN_URL`、`TEST_REDIS_URL`、`TEST_STORAGE_ROOT`、`JWT_SECRET`，
启动器不读 `.env`。

```bash
deno task test:domain <domain>  # 指定 Domain（Agent 首选，禁止手拼 deno test）
bash scripts/test-shared.sh     # 共享测试
deno task test:parallel         # 并行分片（每 shard 独立库/Redis 容器/存储目录）
deno task test:smoke            # HTTP 冒烟
deno task test:logic            # 纯逻辑，不需要外部资源
deno task test                  # 全量真实 PostgreSQL
```

- 缺少依赖必须失败，不能用 `ignore: true` 静默跳过；也不要使用开发 `.env`。
- 使用 `sanitizeResources: false, sanitizeOps: false`（postgres.js 连接池）。
- 命名 `"<module>: <description>"`；每个测试前 `resetDbForTest()`；路由测试用
  `jsonRequest()` 构造请求。

## 代码规范与关键运行约束

- 路由文件默认导出 Hono 实例，由 `app.ts` 组合；API 路径 `/api/v1/{resource}`。
- 错误统一 `AppError` 继承体系，全局 `onError` 捕获并带 `request_id`。
- JWT：HS256、iss/aud 校验、24h（无刷新）；`jti` 校验 Redis 撤销记录，
  `session_version`
  与用户表实时比较。改密/重置原子递增版本使旧会话失效；签发必须
  使用凭据校验时读到的版本，不能在校验后重新读取给旧凭据续权。
- 分值 ×100 整数存储（`scoreToDb`/`scoreFromDb`）；时间戳用 ISO 8601 文本。
- 迁移：Drizzle migrator 按 `drizzle/` 编号顺序执行；`_journal.json` 与 SQL
  必须一致。
- 提交状态机 `pending → [judging, error]`，`judging → [finished, error]` 终态；
  评测尝试终态不可覆盖，重测新建 attempt（递增 `sequence`，旧的标记
  `superseded`）。
- 输出截断 8KB（`MAX_OUTPUT_LENGTH`）、代码上限 100KB（`MAX_CODE_LENGTH`）。
- 分页默认 page=1、per_page=20、max 100。
- 用户枚举防护：登录失败统一「用户名或密码错误」；`forgot-password` 恒返 200。
- 密码重置：DB 存 SHA-256 哈希，TTL 15 分钟，单 SQL 原子消耗。
- 强制改密守卫：`token.must_change_password` 时除白名单外全部 403
  `PASSWORD_CHANGE_REQUIRED`。
- Root 用户 UID="0"，随机密码不可登录，不计入管理员统计。

## 领域要点（详见各模块 README / 路由）

- **题目版本管理**：身份（`problems`）、不可变版本（`problem_versions`）、提交时版本
  （`submitted_version_id`）、评测尝试（`evaluation_attempts`）四概念分离；内容事实
  源是共享草稿 `problem_drafts`（`revision` 乐观锁，缺失 428 / 过时
  409），发布才 写版本。有效成绩由 `submission_version_results` +
  `selectEffectiveResults` 物化。 用户文档见
  [problem-versioning.md](../noj-docs/docs/features/problem-versioning.md)。
- **公开赛题目保密**：判定单一真相源为 contest 域 `problem-secrecy.ts`；新门控
  **禁止**再手写时间窗口比较。
- **竞赛提交隐私**：进行中竞赛排行榜仅返回本人一行；SSE 不下发他人 `user_id` /
  `submission_id`。
- **Redis MQ**：`noj:judge:queue:{high,medium,low}` 下发任务，`:processing` 由
  sweeper 超时重投，`noj:judge:results` 回流结果。DB 写入先于 MQ
  推送；推送失败时 submission 标记 `error`。
- **登录/搜索限流**：Redis 固定窗口，命名空间 `login` / `pwchange` / `tfa`
  与搜索桶 互相隔离；`RATE_LIMIT_ENABLED` 总开关，`NOJ_ENV=test` 强制关闭。
- **评测脚本（AI 题 dual 双容器）**：输出 `---RESULT---` + `{score, details}`；
  协议 v3 携带 `attempt_id` / `problem_version_id` / `run_id` / `result_kind`；
  `details.cases[].hidden` 必须为布尔，隐藏用例不得输出输入/期望/实际输出。

## 相关文档

- 工程规范：[`../dev-docs/engineering/`](../dev-docs/engineering/)
- 重构提案：
  [`../openspec/changes/refactor-core-feature-slices/`](../openspec/changes/refactor-core-feature-slices/)
- 外部：[Hono](https://hono.dev/)、[Deno](https://docs.deno.com/)、
  [Drizzle ORM](https://orm.drizzle.team/)
