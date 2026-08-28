# NOJ 测试体系

本文档汇总 NOJ 各模块的测试分层、运行命令与约定。详细模块级内容以各模块 `CLAUDE.md` 为准。

## 分层

| 层 | 位置 | 说明 |
|---|---|---|
| 单元/服务测试 | `noj-core/tests/` | lib/middleware/types/data/app 等 |
| 路由/集成测试 | `noj-core/tests/routes/`、`tests/services/`、`tests/mq/` | 需要 DB/Redis 的测试 |
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
deno task test
```

## 约定

- 必须使用 `deno task` 封装命令运行 Deno 测试，不要手拼 `deno test`。
- DB 依赖测试在缺少 `DATABASE_URL` / `JWT_SECRET` 时静默跳过。
- 测试数据使用 `Date.now()` 生成唯一用户名/邮箱，避免冲突。
- 路由测试使用 `jsonRequest()` 辅助函数。
- judge E2E 使用 `#[serial_test::serial]` 串行执行，避免 Docker 资源竞争。
- 资源测试必须自建自清，失败/重试/超时也要清理。

## 后续计划

- 集中 gate runner：`scripts/check-all.ts` / `scripts/check-ci.ts`。
- 覆盖率门禁：noj-core ≥ 75%、noj-judge ≥ 80%、noj-llm-gateway ≥ 80%、noj-ui 关键 composables ≥ 60%。
- 真实入口 smoke：judge release binary / Docker 镜像、core `deno compile`。
- LLM 回放测试：录制-回放快照。
