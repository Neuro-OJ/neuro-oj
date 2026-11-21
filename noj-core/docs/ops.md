# 运行、配置与运维（noj-core）

> 技术栈：Deno 2 + TypeScript、Hono、PostgreSQL 16 + postgres.js + Drizzle ORM、
> Redis（ioredis）、JWT（jose）+ bcryptjs。仓库根的基础设施（PostgreSQL / Redis
> / MinIO 容器、开发凭据、`docker compose up -d`）见
> [`../../AGENTS.md`](../../AGENTS.md)。
>
> noj-core 负责认证授权、题目/提交/竞赛/社区 CRUD、Redis MQ 分发与结果落库、
> 审计。

## 1. 启动顺序

入口 `src/main.ts` 只调用 `startCore()`
（`src/modules/application/create-system.ts`）：

1. `JWT_SECRET` 强度与占位值校验（不足 32 字符拒绝启动）。
2. `TFA_ENCRYPTION_KEY` 强度与占位值校验（必须独立于 `JWT_SECRET`）。
3. 数据库 schema 只读兼容检查（HTTP 进程**不执行 DDL**）。
4. 系统设置注册表校验 + 设置缓存初始化。
5. 生产配置校验（`NOJ_ENV=production` 时）。
6. 连接 Redis、恢复评测 token 撤销记录、准备队列。
7. 启动后台消费者、worker 与定时任务。
8. 启动 HTTP（默认 `PORT=8000`）并注册优雅关闭。

迁移与系统初始化是显式步骤：`deno task db:migrate`、`deno task init:system`，
不在 HTTP 启动里隐式执行。

## 2. 配置分层

注册表单一事实源：`src/shared/config/settings-registry.ts` 的
`CONFIG_DEFINITIONS`。新增 env 变量必须登记并同步 `.env.example`；
`deno task check:env` 校验键覆盖一致性。

| 层                     | 读取链                    | 变更方式                         |
| ---------------------- | ------------------------- | -------------------------------- |
| runtime（DB-owned）    | `DB → env → 默认值`       | 后台 / 系统设置写入 DB，即时生效 |
| bootstrap（env-owned） | `env → 默认值`（不读 DB） | 改 `.env` 后重启；后台只读展示   |

必填 bootstrap：`DATABASE_URL`、`JWT_SECRET`（≥32 字符）、
`TFA_ENCRYPTION_KEY`（≥32 字符，必须独立于 `JWT_SECRET`）。生产环境必须配置
`TRUSTED_PROXIES`，否则 `X-Forwarded-For` 解析不正确。完整变量与默认值见
`.env.example` 与注册表。

## 3. 开发命令

```bash
deno task dev            # watch + .env
deno task start          # 生产运行
deno task dev-setup      # 幂等初始化：迁移 + 系统数据 + 管理员引导 + 题目包 + E2E 用户
deno task db:migrate     # 显式迁移
deno task db:generate    # 由 Drizzle schema 生成迁移
deno task problems:build # 构建题目支持包
deno task check          # fmt --check + lint + check:types
deno task check:env      # 注册表与 .env.example 键一致性
```

`dev-setup` 内部走 `scripts/noj.ts dev-setup`；脚本统一入口是 `scripts/noj.ts`。

## 4. 题目包与搜索

```bash
deno run --env-file=.env -A scripts/noj.ts problems import [--publish]
deno run --env-file=.env -A scripts/noj.ts search reindex
```

- 不加 `--publish` 只导入草稿，普通访问者读不到。
- `search reindex` 全量重建搜索索引。
- `data/problems-src/` 只放样例题与开发测试题；正式题目（含隐藏数据与评测脚本）
  不得提交到本仓库。
- `data/packages/` 是构建产物，已 gitignore。

## 5. 生产运维

生产统一使用 `noj-cli`（配置真相源 `.env.prod`）；安装与
`check|status|start|stop|restart|logs|update|backup|verify|config` 见
[`../../noj-cli/README.md`](../../noj-cli/README.md) 与
[`../../noj-docs/docs/operators/production-deploy.md`](../../noj-docs/docs/operators/production-deploy.md)。
