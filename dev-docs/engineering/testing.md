# NOJ 测试体系

本文档汇总 NOJ 各模块的测试分层、运行命令与约定。详细模块级内容以各模块 `AGENTS.md` / `CLAUDE.md` 为准。

## 分层

| 层 | 位置 | 说明 |
|---|---|---|
| Domain 单元/集成测试 | `noj-core/src/domains/<domain>/tests/`（按 `routes/`、`services/`、`mq/`、`middleware/` 等分组） | 各业务域的路由、服务与 MQ 测试，部分需要 DB/Redis；由 `deno task test:domain <domain>` 运行 |
| 共享/全局测试 | `noj-core/tests/`（`shared/`、`routes/`、`app.test.ts` 等） | 跨域共享基础设施、全局中间件与应用装配；由 `scripts/test-shared.sh` 运行 |
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
deno task test            # 串行全量（无 DATABASE_URL 时走 PGlite）
deno task test:parallel   # 并行分片（需本地 PG）
deno task test:smoke      # 快速冒烟
deno task test:domain identity   # 按 Domain 跑单元/集成测试
bash scripts/test-shared.sh      # 共享/全局测试 + smoke

# noj-llm-gateway
cd noj-llm-gateway
deno task test

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
- DB 依赖测试在缺少 `DATABASE_URL` / `JWT_SECRET` 时静默跳过。
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
