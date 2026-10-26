# NOJ 测试体系

本文档汇总 NOJ 各模块的测试分层、运行命令与约定。详细模块级内容以各模块 `AGENTS.md` / `CLAUDE.md` 为准。

## 分层

| 层 | 位置 | 说明 |
|---|---|---|
| Domain 单元/集成测试 | `noj-core/src/domains/<domain>/tests/`（按 `routes/`、`services/`、`mq/`、`middleware/` 等分组） | 各业务域的路由、服务与 MQ 测试，部分需要 DB/Redis；由 `deno task test:domain <domain>` 运行 |
| 共享/全局测试 | `noj-core/tests/`（`shared/`、`routes/`、`app.test.ts` 等） | 跨域共享基础设施、全局中间件与应用装配；由 `scripts/test-shared.sh` 运行 |
| 纯逻辑/契约测试 | `noj-core/tests/scripts/` 与 `noj-core/tests/shared/runtime/` | 参数、资源命名、分片覆盖与生命周期 fake；不连接 PostgreSQL、Redis 或 Docker，由 `deno task test:logic` 运行 |
| 冒烟测试 | `noj-core/tests/smoke.test.ts` | 快速验证 HTTP 核心路径 |
| noj-llm-gateway 测试 | `noj-llm-gateway/tests/` | 网关逻辑、限流、审计 |
| noj-ui 测试 | `noj-ui/tests/` | 工具函数、部分 composable |
| judge 单元测试 | `noj-judge/`（cargo test） | 无需 Docker |
| judge Docker E2E | `noj-judge/tests/e2e_*.rs` | 需要 Docker + `NOJ_RUN_E2E=1` |
| 跨模块 E2E | `noj-tests/e2e/` | 启动完整栈后运行 |

## 常用命令

```bash
# noj-core
cd noj-core
# 除 `test:logic` 外的正式入口不会读取 .env；先提供本次隔离 run 的资源：
# TEST_PG_ADMIN_URL / TEST_REDIS_URL / TEST_STORAGE_ROOT / JWT_SECRET
deno task test            # 全量真实 PostgreSQL（迁移 + 显式 seed）
deno task test:parallel   # 模板克隆的独立数据库分片
deno task test:smoke      # HTTP 冒烟（真实 PostgreSQL + Redis）
deno task test:logic      # 纯逻辑/契约测试（不连接 PostgreSQL、Redis 或 Docker）
deno task test:domain identity   # 按 Domain 跑单元/集成测试
bash scripts/test-shared.sh      # 共享/全局测试
deno task test:pg         # 真实 PostgreSQL 全量别名
deno task test:perf       # 显式性能基准
deno task test:watch      # 长驻 watch，退出时清理 run 资源

# noj-llm-gateway
cd noj-llm-gateway
# 正式入口需要专用测试资源；启动器创建随机 PostgreSQL database，
# 为每个 run 使用唯一 Redis prefix，并在 finally 只清理本 run 资源。
TEST_PG_ADMIN_URL=postgres://noj:noj@127.0.0.1:5432/postgres \
TEST_REDIS_URL=redis://127.0.0.1:6379/15 \
deno task test
# 只跑零依赖启动器参数/生命周期逻辑：
deno task test:logic

# noj-ui
cd noj-ui
deno task test

# noj-judge
cd noj-judge
cargo nextest run --all-targets   # 推荐
cargo test                        # 等价

# judge Docker E2E
cd noj-judge
NOJ_RUN_E2E=1 cargo test --test e2e_docker_basic -- --ignored

# 跨模块 E2E
cd noj-tests
deno task test                    # 全量（需完整评测栈）
deno task test:domain identity    # 按 Domain 跑 E2E
deno task test:domain cross-domain # 跨域 E2E
```

## 约定

- 必须使用 `deno task` 封装命令运行 Deno 测试，不要手拼 `deno test`。
- 按 Domain 测试必须使用 `deno task test:domain <domain>` 或 `scripts/test-shared.sh`，禁止手拼 `deno test` 绕过脚本。
- noj-tests E2E 文件按 Domain 目录组织：`e2e/<domain>/`、`e2e/cross-domain/`、`e2e/browser/`。
- noj-core DB 测试由 `scripts/test-launcher.ts` 创建独立模板库、执行正式迁移和
  显式 seed，再为每个入口克隆本 run 数据库；缺少
  `TEST_PG_ADMIN_URL`、`TEST_REDIS_URL`、`TEST_STORAGE_ROOT` 或 `JWT_SECRET`
  时直接失败。
- `TEST_REDIS_URL` 是模板迁移与显式 seed 使用的 bootstrap endpoint；启动器先检查
  它可用，再为每个 run/shard 创建带 owner label 的独立 `redis:7-alpine` 容器供
  child 测试使用。测试进程不对共享 Redis 执行 `FLUSHDB`，也不依赖固定 DB slot。
  finally 只在 container ID 与
  owner/name/created-by 标签精确匹配时删除本 run 创建的容器。对象存储测试目录
  位于 `TEST_STORAGE_ROOT/<run-prefix>/`；父目录可由启动器递归创建，run 目录使用
  独占创建，预存在时直接失败，finally 只清理本次创建的 run 目录，不删除父目录。
- 启动器要求 `docker` 可执行文件及 `redis:7-alpine` 镜像可用；Docker 或显式
  `TEST_REDIS_URL` 不可用时直接失败，不降级到 fake Redis、开发 `.env` 或静默跳过。
- 分片不共享 PostgreSQL schema 或 truncate；每个分片从同一正式迁移/seed 模板
  克隆独立数据库，helper 通过 `NOJ_TEST_DATABASE_OWNED=1`、前缀、精确库名及
  `current_database()` 复核清理范围。
- 测试数据使用 `Date.now()` 生成唯一用户名/邮箱，避免冲突。
- 路由测试使用 `jsonRequest()` 辅助函数。
- judge E2E 使用 `#[serial_test::serial]` 串行执行，避免 Docker 资源竞争。
- 资源测试必须自建自清，失败/重试/超时也要清理。

## 覆盖率报告与基线

- 覆盖率报告：`deno run -A scripts/coverage-report.ts --report`，输出到 `dev-docs/engineering/test-coverage.md`（生成物，不入库）。
  加 `--check` 时各模块 `test:coverage` 自带的 `--threshold` 生效（当前 noj-llm-gateway ≥ 54%、noj-ui ≥ 60%）；
  CI 的 Coverage Check job 即以 `--report --check` 运行，属于**硬门禁**。noj-core / noj-judge 的覆盖率由各自 CI job 采集，不在该报告聚合范围内。
- 静默跳过清单：`deno run -A scripts/silent-skip-report.ts`，输出到 `dev-docs/engineering/test-silent-skips.md`。
- 慢测试基线：`deno run -A scripts/test-baseline.ts`，输出到 `dev-docs/engineering/test-baseline.md`（生成物，不入库）。

## 已落地的配套门禁

- 集中 gate runner：`scripts/check-all.ts`（本地）/ `scripts/check-ci.ts`（CI），闸门清单见 `scripts/gate-list.ts`。
- 入口存在性检查：`scripts/smoke-entrypoints.ts`（CI 中运行；仅校验入口源文件与已构建产物存在，不启动进程）。
- LLM 回放测试：`cd noj-llm-gateway && deno task test:snapshot`（录制用 `test:snapshot:record`）。

## 后续计划

- 真实入口 smoke：启动 judge release binary / Docker 镜像、core `deno compile` 产物并探活。
- 提高覆盖率阈值：目标 noj-core ≥ 75%、noj-judge ≥ 80%、noj-llm-gateway ≥ 80%、noj-ui 关键 composables ≥ 60%。
