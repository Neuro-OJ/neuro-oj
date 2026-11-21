# noj-core — Neuro OJ 核心后端

Deno 2 + Hono 的 RESTful API 与业务后端。仓库级规则见
[`../AGENTS.md`](../AGENTS.md)。

> 本文件只保留**禁令、命令、细节路由**；背景、schema 与领域约定在
> [`docs/`](./docs/)。架构方向为 `shared/` + `features/<name>/`，依据
> [`../openspec/changes/refactor-core-feature-slices/`](../openspec/changes/refactor-core-feature-slices/)。

## 禁令

1. **禁止手改迁移元数据与锁文件**：`drizzle/meta/_journal.json`、`deno.lock`
   一律不改；迁移只能由 `deno task db:generate` 生成并按编号追加。
2. **迁移必须三步式**：加可空列 → 回填 → `SET NOT NULL`。禁止
   `ALTER TABLE ... ADD COLUMN ... NOT NULL` 不带 `DEFAULT`（存量库升级必失败，
   空库发现不了）。
3. **新功能必须落切片**：`src/features/<name>/`，`index.ts` 唯一出口，用
   `defineFeature` 声明，`src/features.ts` 加一行完成装配。不新建 `modules/`
   模块，旧模块改到即迁。
4. **按 Domain 测试必须用规定命令**：`deno task test:domain <domain>`；
   共享测试用 `deno task test:shared`（等价
   `bash scripts/test-shared.sh`）。禁止手拼 `deno test`。
5. **搜索必须用 `rg`**：禁止 `grep`；仅当环境没有 `rg` 时才允许回退。
6. 禁止直连生产库改 schema；禁止把真实凭据写进 `.env`。
7. 正式题目（含隐藏数据与评测脚本）禁止提交到 `data/problems-src/`，该目录
   只放样例题与开发测试题。
8. 测试缺少依赖必须失败：禁止 `ignore: true` 静默跳过，禁止用开发 `.env`
   跑测试。

## 命令

```bash
cd noj-core
deno task check                 # fmt --check + lint + check:types
deno task test:domain <domain>  # 按 Domain 测试（Agent 首选）
deno task test:shared           # 共享测试（等价 bash scripts/test-shared.sh）
deno task test:parallel         # 并行分片：独立库 / Redis / 存储目录
deno task test:smoke            # HTTP 冒烟
deno task test:logic            # 纯逻辑，无需外部资源
deno task db:generate           # 改 Drizzle schema 后生成迁移
deno task db:migrate            # 执行迁移（HTTP 启动不执行 DDL）
deno task check:env             # 注册表与 .env.example 键一致性
```

首次启动：`docker compose up -d`（仓库根）→ `deno task dev-setup` →
`deno task dev`。测试所需环境变量与测试写法见
[`docs/testing.md`](./docs/testing.md)；完整开发/运维命令见
[`docs/ops.md`](./docs/ops.md)。

## 细节路由

| 要查的内容                                        | 去哪                                       |
| ------------------------------------------------- | ------------------------------------------ |
| Drizzle schema、迁移约定、状态机、数值存储        | [`docs/database.md`](./docs/database.md)   |
| `features/` 切片、`defineFeature`、路由与错误规范 | [`docs/structure.md`](./docs/structure.md) |
| 测试命令、隔离资源、测试写法                      | [`docs/testing.md`](./docs/testing.md)     |
| 环境变量分层、启动顺序、开发/运维命令             | [`docs/ops.md`](./docs/ops.md)             |
| 固定角色、鉴权/会话、密码与账号防护               | [`docs/access.md`](./docs/access.md)       |
| 领域不变量、MQ、评测协议、限流与分页              | [`docs/domain.md`](./docs/domain.md)       |

**关键代码入口**：

| 入口                                                           | 用途                       |
| -------------------------------------------------------------- | -------------------------- |
| `src/main.ts` → `src/modules/application/create-system.ts`     | 启动与装配顺序             |
| `src/features.ts` / `src/shared/feature.ts`                    | 功能清单与 `defineFeature` |
| `src/features/trainings/`                                      | 新功能切片样例             |
| `src/modules/access/identity/services/security/permissions.ts` | 能力静态表                 |
| `src/shared/config/settings-registry.ts`                       | 配置注册表                 |

仓库级规则：[`../AGENTS.md`](../AGENTS.md)　工程规范：[`../dev-docs/engineering/`](../dev-docs/engineering/)
外部文档：[Hono](https://hono.dev/) · [Deno](https://docs.deno.com/) ·
[Drizzle ORM](https://orm.drizzle.team/)
