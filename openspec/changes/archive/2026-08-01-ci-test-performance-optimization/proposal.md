# CI 与测试运行效率优化

## Why

每次跑测试都太慢：ci.yml 有 8 个 job 且存在冗余（`core-fmt`/`core-lint` 与
`core-quick-check` 重复；`judge-clippy` 与 `judge-test` 各自全量编译同一份
target 且共用 cargo cache key 互相覆盖）；PR 改一个模块会触发全部模块的
job；noj-core 71 个测试文件在单一 `core-test` job 内串行（`deno test
--parallel` 因 PG TRUNCATE 死锁不可用），其中还混着 seed 10 万行的性能
基准；e2e.yml 是单一大 job 全串行（构建栈 → 启动 → 23 个 API E2E → 6 个
沙箱 binary）；Rust 编译无跨 run 缓存。本地同样串行：`deno task test`
全量跑 71 个文件，`cargo test` 每次全量编译。

## What Changes

- **CI job 重组（ci.yml）**：删除冗余 `core-fmt`/`core-lint`；`judge-fmt`/
  `judge-clippy`/`judge-test` 合并为 `judge-check` 单 job（共享 target 编译
  一次，消除 cache key 竞争）；新增 `changes` job（`dorny/paths-filter`）
  按 noj-core/ui/judge 路径过滤 PR 上的 job，push main / 手动触发全量。
- **noj-core 测试分片**：`core-test` 拆为 `core-test-unit`（lib/middleware/
  types/data/app，PGlite 内存库 + Redis）与 `core-test-db`（services/routes/
  mq/db/迁移/种子，真实 PG）两并行 job；`tests/perf`（100k 行基准）加
  `NOJ_RUN_PERF=1` guard，移入 `core-perf` job（仅 main push / 手动触发）。
- **本地并行**：新增 `deno task test:parallel`（`scripts/test-parallel.ts`）
  按目录分 unit/db 两组，通过 `TEST_SCHEMA` 环境变量 + `migrationsSchema`
  隔离到独立 PG schema（`connection.ts` 用 libpq `-csearch_path` startup
  参数），进程级并行无死锁；CI 与本地目录集合保持一致。
- **迁移 SQL 修复**：0010/0027/0029 三个历史迁移含 drizzle-kit 生成的
  `REFERENCES "public"."xxx"` 硬编码前缀——TEST_SCHEMA 分片下 FK 全部错指
  public schema（61 个测试失败的根因）。去掉前缀后按 search_path 解析，
  public 模式行为不变（已应用迁移的库按时间戳跳过，不重放）。
- **Rust 加速**：ci.yml `judge-check`/`judge-e2e` 与 e2e.yml `judge-sandbox`
  引入 `mozilla/sccache-action`（GHA cache backend）；judge 单元测试改用
  `cargo-nextest`（`taiki-e/install-action` 安装，并行跑多个 test binary）；
  6 个沙箱 binary 分 2 组并行（组内 `--test-threads=1` 串行保序）。
- **e2e.yml 拆分**：单一大 job 拆为 `e2e`（构建栈 + noj-tests 23 文件分
  3 组并行）与 `judge-sandbox`（独立 job：只依赖 Docker + Redis，测试内
  `ensure_test_image` 自建镜像，与 API E2E 完全并行）两个 job；`paths-ignore`
  扩充（noj-ui、ci.yml、本地脚本等不涉及评测栈的路径不再触发）。
- **noj-tests 并发兜底**：`helper.ts` 的 `loginAndChangePassword` 加并发
  兜底——change-password 失败（其他分片进程已先改密）时改用 newPassword
  登录重试，消除 3 组并行下的 admin 改密竞态。

## Capabilities

### New Capabilities
- `ci-pipeline-efficiency`: ci.yml job 合并/路径过滤/分片并行/e2e 拆分、
  sccache + nextest、noj-tests 分组并行的行为约束（PR 只跑相关 job、
  沙箱 E2E 2 组并行、API E2E 3 组并行）。

### Modified Capabilities
- `core-testing`: `deno task test:parallel`（TEST_SCHEMA 分片）、
  `NOJ_RUN_PERF` guard、CI 目录分片集合（unit/db）、迁移 SQL 不得带
  schema 前缀的约束。
- `judge-testing`: cargo-nextest 替代 cargo test（无 doctest，覆盖等价）、
  sccache 缓存、沙箱 E2E 分 2 组并行。

## Impact

- **noj-core**：`src/db/connection.ts`（TEST_SCHEMA search_path）、
  `src/db/migrate.ts`（migrationsSchema）、`scripts/test-parallel.ts`（新）、
  `deno.json`（`test:parallel` task）、`tests/perf/search_bench.test.ts`
  （guard）、drizzle 0010/0027/0029（public 前缀修复）。
- **noj-tests**：`e2e/helper.ts`（改密并发兜底）。
- **CI**：`.github/workflows/ci.yml`（9 job：changes + quick-check + smoke +
  test-unit + test-db + perf + ui + judge-check + judge-e2e）、
  `.github/workflows/e2e.yml`（e2e + judge-sandbox 并行）。
- **文档**：AGENTS.md §12/§13、noj-core/CLAUDE.md、noj-judge/AGENTS.md。
- **行为不变项**：public 模式下迁移/测试结果与之前完全一致（已应用迁移
  不重放；FK 目标等价）；`deno task test` 串行 PGlite 保留。
