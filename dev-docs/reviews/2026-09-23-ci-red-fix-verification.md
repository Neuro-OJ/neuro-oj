# CI 红灯修复与验证记录（2026-09-23）

- 基线：`main` @ `95315c5c2`（CI 为 failure）
- 范围：修复 `CI` 工作流两个红灯 job，并落地此前搁置的可代码修复项
- 环境：本地 PG 16 / Redis 7（`docker compose up -d`）；Deno 2.9.7；Docker 可用

## 一、修复项

| # | 问题                         | 根因                                                                           | 修复                                                                                    |
| - | ---------------------------- | ------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------- |
| 1 | Root Gates：文件规模棘轮     | `noj-judge/src/dual/mod.rs` 1861 → 1884（+23）                                 | 抽 `build_llm_env` 及测试到 `dual/llm_env.rs`；`mod.rs` 降至 1843，下调 `SIZE_BASELINE` |
| 2 | Core Perf：10 万题搜索 604ms | 中文 2 字不切词 → 退化 `ILIKE '%测试%'` → 全表扫描 → 触发 PG JIT（编译 238ms） | 连接 startup 参数默认 `-cjit=off`（`DATABASE_JIT=on` 可恢复）                           |
| 3 | issue #554                   | `buildContestEntry` 把竞赛内全部题目标题写入索引                               | 聚合仅纳入 `visibility='public'` 的题目 + 回归测试                                      |
| 4 | F-06                         | 单用户可打满共享 `problem/day` 桶冻结他人 LLM 题                               | 新增 `user_problem` 组合配额维度（day/month）                                           |
| 5 | F-10                         | 无 XFF 时全部落到 `ip:unknown` 共享桶                                          | `ipRatePrefix()`：缺失 IP 时按 submission 隔离                                          |

## 二、Core Perf 证据链（全部实测）

```
# 1) 中文不切词，FTS 不命中
to_tsvector('simple','题目 1：测试数据') = '测试数据':3
websearch_to_tsquery('simple','测试')   = '测试'
@@ 匹配                                  = false

# 2) 2 字 < 3，pg_trgm 无法索引 → Seq Scan 10 万行
# 3) 高计划代价触发 JIT（EXPLAIN ANALYZE, VERBOSE）
JIT: Functions: 46  Timing: ... Total 237.931 ms
Execution Time: 309.330 ms

# 4) 关闭 JIT 后
SET jit = off → Execution Time: 56.813 ms（完整谓词）
端到端 searchFlat：277ms → 57ms
SHOW jit = off（修复后，连接级生效，无需 DB 级设置）
```

结论：这是**可消除的纯编译开销**，非放宽阈值（设计文档性能预算：GIN tsvector <
50ms、trgm < 200ms，针对索引路径；本查询为退化路径）。

## 三、验证结果

| 验证                              | 命令                                                                                 | 结果                                             |
| --------------------------------- | ------------------------------------------------------------------------------------ | ------------------------------------------------ |
| Root Gates（本地等价 CI）         | `deno run -A scripts/check-file-size.ts`                                             | ✅ 通过（`dual/mod.rs=1843`）                    |
| 门禁自测                          | `deno test -A scripts/check-file-size_test.ts`                                       | ✅ 7 passed                                      |
| Judge 单测                        | `cargo nextest run --all-targets`                                                    | ✅ 316 passed / 44 skipped                       |
| Judge fmt/clippy                  | `cargo fmt --check && cargo clippy --all-targets -- -D warnings`                     | ✅ 零警告                                        |
| **Core Perf（关键）**             | `NOJ_RUN_PERF=1 deno test -A tests/00_migrate_test.ts src/domains/search/tests/perf` | ✅ **1 passed**，搜索 **65ms**（原 517ms/604ms） |
| 网关单测                          | `deno test -A tests/limits_test.ts tests/config_registry_test.ts`                    | ✅ 11 passed                                     |
| 连接参数单测                      | `deno test -A tests/shared/db/connection-options.test.ts`                            | ✅ 4 passed                                      |
| 网关 check                        | `deno fmt --check && deno lint && deno check src/mod.ts`                             | ✅                                               |
| 配置登记                          | `deno task check:config-usage`（noj-core）                                           | ✅ 118 core + 13 网关键均有读取点                |
| Agent Note 格式                   | `deno run -A scripts/verify-agent-note-format.ts`                                    | ✅ 176 篇                                        |
| **仓库级门禁（等价 Root Gates）** | `deno run -A scripts/check-ci.ts`                                                    | ✅ **exit=0，202 passed / 0 failed**             |
| 搜索域测试                        | `deno task test:domain search`                                                       | ✅ 30 passed / 1 ignored                         |
| noj-core 全量（PGlite）           | `deno task test`                                                                     | ✅ 1362 passed / 0 failed                        |
| 网关全量                          | `deno task test`（noj-llm-gateway）                                                  | ✅ 75 passed / 1 ignored                         |
| noj-core 分片（TEST_SCHEMA）      | `deno task test:parallel`                                                            | ✅ exit=0（unit 317 / db 1075，两分片均通过）    |

> **环境陷阱记录**：本地手工跑 identity 测试时若传入
> `RATE_LIMIT_ENABLED=false`， `loginThrottle: 失败累加，10 次后锁定`
> 会失败（`recordLoginFailure` 在限流关闭时 为 no-op）。已在干净 HEAD worktree
> 复现，**与本次改动无关**；按 CI 环境 （不设该变量）运行即通过。分片测试须用
> `deno task test:parallel` 的默认环境。

## 四、改动文件

参见同批次提交 `git status --short` 与 Agent Note
`.agents/notes/implemented/bug-fix/2026-09-23-ci-red-gate-and-gateway-fixes.md`。
