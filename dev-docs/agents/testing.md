# 启动、测试与迁移

> 根 [`AGENTS.md`](../../AGENTS.md) 的 commands 落点：源码启动、生产运维、
> 测试矩阵、数据库迁移与改动检查清单。

## 1. 源码开发启动

**首次**：

```bash
docker compose up -d                 # 基础设施，另含 llm-gateway 容器 :8001
cd noj-core && deno task dev-setup   # 幂等：迁移 + 系统数据 + 管理员引导 + 题目包
```

之后各模块在自己的目录跑 `deno task dev`；`noj-judge` 用 `cargo run`。

从源码运行 `noj-llm-gateway` 前必须先 `docker compose stop llm-gateway`，否则
:8001 端口冲突。

noj-core 启动顺序为 env 校验 → **只读 schema 兼容检查** → 后台任务 → HTTP，以
[`noj-core/src/main.ts`](../../noj-core/src/main.ts) 的 `main()` 为准。`startCore()`
只做只读核对、不执行 DDL：库里有待执行（含缺失 / 漂移）的迁移时直接拒绝启动，
所以迁移与系统初始化是**显式前置步骤**（`deno task db:migrate` /
`deno task init:system`，与 [`noj-core/docs/ops.md`](../../noj-core/docs/ops.md)
一致），HTTP 启动不隐式迁移。

## 2. 生产运维

统一使用 `noj-cli`，单一配置真相源 `.env.prod`。安装与命令说明见
[`noj-cli/README.md`](../../noj-cli/README.md) 与
[production-deploy.md](../../noj-docs/docs/operators/production-deploy.md)。

可用命令：`check` `status` `start` `stop` `restart` `logs` `update` `backup`
`verify` `config`。

## 3. 测试矩阵

| 范围              | 命令                                                 | 说明                                                                              |
| ----------------- | ---------------------------------------------------- | --------------------------------------------------------------------------------- |
| noj-core 全量     | `cd noj-core && deno task test:parallel`             | 优先使用                                                                          |
| noj-core 全量(PG) | `cd noj-core && deno task test`                      | 真实 PostgreSQL，需 `TEST_PG_ADMIN_URL`；**不是零依赖**                           |
| noj-core 零依赖   | `cd noj-core && deno task test:logic`                | 无外部依赖时                                                                      |
| noj-core 快速     | `cd noj-core && deno task test:smoke`                | 快速反馈                                                                          |
| noj-core 按域     | `cd noj-core && deno task test:domain <domain>`      | 单元/集成                                                                         |
| noj-core 共享     | `cd noj-core && deno task test:shared`               | 等价 `bash scripts/test-shared.sh`                                                |
| noj-ui            | `cd noj-ui && deno task test`                        | 前端                                                                              |
| noj-judge         | `cd noj-judge && cargo nextest run --all-targets`    | 不含 Docker E2E；`--ignored` 入口见 [testing.md](../../noj-judge/docs/testing.md) |
| noj-tests E2E     | `cd noj-tests && deno task test:domain <domain>`     | 按域                                                                              |
| 跨域 E2E          | `cd noj-tests && deno task test:domain cross-domain` | 跨模块全链路                                                                      |

**禁止手拼 `deno test`**：上述命令统一处理迁移/种子、环境变量与测试路径；手拼会
丢失必要配置，CI 与本地必须使用同一套命令。

测试分层与更多约定见
[`dev-docs/engineering/testing.md`](../engineering/testing.md)。

## 4. 数据库与迁移

- 迁移文件位于 `noj-core/drizzle/*.sql`，由 `deno task db:generate` 生成。
- **禁止手动修改 `_journal.json`**；迁移严格按编号，只能追加。
- 完整 Schema、迁移约定与表关系见
  [`noj-core/AGENTS.md`](../../noj-core/AGENTS.md)。
- **迁移安全**：禁止 `ALTER TABLE ... ADD COLUMN ... NOT NULL` 不带 `DEFAULT`
  （存量库升级必失败，空库无法发现）；必须三步式：加可空列 → 回填 →
  `SET NOT NULL`。由
  [`scripts/check-migration-safety.ts`](../../scripts/check-migration-safety.ts)
  强制。

```bash
cd noj-core && deno task db:generate
```

## 5. 改动检查清单

- [ ] `deno fmt` / `cargo fmt` 已运行，`deno lint` / `cargo clippy` 无警告
- [ ] 新功能/修复有对应测试，且通过 `deno task` 运行
- [ ] 新表/字段已通过 `deno task db:generate` 生成迁移
- [ ] 新环境变量已登记注册表并加入对应模块 `.env.example`
- [ ] 中文提交描述符合 Conventional Commits，GPG 签名可用
- [ ] 移动被跨模块引用的目录或共享文件（尤其是 `noj-ui/` 下的 `utils/`、`components/`、
      `tests/`）后，已全仓 `rg` 过旧路径并核对消费方模块的类型检查；涉及 `noj-ui` 时，
      必须**先 `cd noj-tests`** 再运行 `deno check e2e/browser/*.test.ts`（从仓库根直接跑
      会找不到 `noj-tests/deno.json`，且跨模块引用不在 `noj-ui` 自身检查范围内；2026-11
      曾因此两次挂掉 E2E Browser `TS2307`）。

## 6. CI 校验

除构建与测试外，CI 还执行：

```bash
deno run -A scripts/verify-md-links.ts
```

本地改完文档后可先跑这条，避免 CI 才暴露链接问题。
