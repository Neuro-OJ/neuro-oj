## Purpose

定义 CI 管道效率优化规范：job 合并去重、按模块路径过滤、noj-core 测试
目录分片、TEST_SCHEMA 并行隔离与 e2e.yml 双 job 并行，确保在保持质量
门禁完整性的前提下显著缩短 PR / 推送的 CI 耗时。

## Requirements

### Requirement: 按模块路径过滤 PR job（dorny/paths-filter）

CI SHALL 在 `ci.yml` 顶部提供 `changes` job（`dorny/paths-filter@v3`，
checkout `fetch-depth: 0`），输出 `core` / `ui` / `judge` 三个布尔 flag，
各模块 job SHALL 使用条件
`github.event_name != 'pull_request' || needs.changes.outputs.<module> == 'true'`
——即 PR 只跑改动涉及的模块 job，push main 与 `workflow_dispatch` 全量执行。

路径映射：`noj-core/**`、`docker-compose.e2e.yml`、`env.e2e.template`、
`.github/workflows/ci.yml` → core；`noj-ui/**`、`ci.yml` → ui；
`noj-judge/**`、`docker-compose.e2e.yml`、`env.e2e.template`、`ci.yml` → judge。
`ci.yml` 自身改动视为三模块皆变更。

#### Scenario: 仅改 noj-ui 的 PR

- **WHEN** PR 只修改 `noj-ui/**` 下文件
- **THEN** `ui-check` 执行，`core-*` / `judge-*` job 全部跳过

#### Scenario: 仅改文档的 PR

- **WHEN** PR 只修改 `**/*.md`（无代码变更）
- **THEN** `changes` 输出全部 false，所有模块 job 跳过

### Requirement: Rust job 合并为 judge-check 单 job

`judge-fmt` / `judge-clippy` / `judge-test` SHALL 合并为单个 `judge-check`
job，按顺序执行 `cargo fmt --all --check` → `cargo clippy --all-targets --
-D warnings` → `cargo nextest run --all-targets`，共享同一 `target/` 目录
（只编译一次）；cargo cache key SHALL 为单一 `cargo-${{ hashFiles('Cargo.lock') }}`。

单元测试 SHALL 使用 cargo-nextest（`taiki-e/install-action@v2` 安装）；
`judge-check` 与 `judge-e2e` SHALL 启用 `mozilla/sccache-action@v0.0.7`
（job 级 `permissions: actions: write`，fork PR 自动降级只读，写缓存失败
仅警告不影响正确性）。

#### Scenario: judge-check 顺序执行

- **WHEN** CI 运行 `judge-check`
- **THEN** 依次执行 fmt → clippy（`-D warnings`）→ nextest
- **THEN** 任一失败即 job 失败

### Requirement: noj-core 测试目录分片（unit / db / perf）

`core-test` SHALL 拆分为三个 job：

| Job | 目录集合 | 服务 |
|-----|---------|------|
| `core-test-unit` | `tests/lib tests/middleware tests/types tests/data tests/app.test.ts` | Redis（PGlite 内存库，无 PostgreSQL） |
| `core-test-db` | `tests/services tests/routes tests/mq tests/db tests/00_migrate_test.ts tests/seed_bootstrap_admin_test.ts` | PostgreSQL + Redis |
| `core-perf` | `tests/perf`（`NOJ_RUN_PERF=1`） | PostgreSQL + Redis |

`core-perf` SHALL 仅在 main push 与 `workflow_dispatch` 执行
（`if: github.event_name != 'pull_request' && ...`），PR 一律跳过。
`tests/perf/search_bench.test.ts` SHALL 默认忽略（`NOJ_RUN_PERF != 1` 时
`ignore: true`），避免每次 PR seed 100k 行。

#### Scenario: PR 上 perf 跳过

- **WHEN** PR 触发 ci.yml
- **THEN** `core-perf` job 跳过，`core-test-unit` 与 `core-test-db` 并行执行

### Requirement: 本地并行测试（TEST_SCHEMA 分片）

noj-core SHALL 提供 `deno task test:parallel`（`scripts/test-parallel.ts`）：
把测试按目录分为 `unit` 与 `db` 两组，每组通过 `TEST_SCHEMA` 环境变量
独占一个 PG schema（`test_unit` / `test_db`），进程级并行。

- `src/db/connection.ts` SHALL 支持 `TEST_SCHEMA`：通过 postgres.js 的
  `connection: { options: '-csearch_path=<schema>,public' }`（libpq startup
  参数）使连接池内所有连接（含 migrator）落在目标 schema；非法标识符
  （非 `[a-zA-Z_][a-zA-Z0-9_]*`）SHALL 拒绝。
- `src/db/migrate.ts` SHALL 在 `TEST_SCHEMA` 存在时把 `migrationsSchema`
  指向同 schema（否则各分片共享 `drizzle` 迁移记录，导致"已迁移"误判跳过）。
- 迁移 SQL SHALL NOT 包含 schema 前缀（历史文件 0010/0027/0029 曾含
  drizzle-kit 生成的 `REFERENCES "public"."xxx"` 硬编码，已修复——分片下
  FK 会错指 public schema 导致测试失败）。

#### Scenario: 本地并行全绿

- **WHEN** 开发者执行 `deno task test:parallel`（本地 PG 可达）
- **THEN** unit 与 db 两组并行执行，各 schema 独立迁移/TRUNCATE，无死锁
- **THEN** 两组全部成功时任务退出 0，任一失败退出 1

### Requirement: e2e.yml 双 job 并行

`e2e.yml` SHALL 拆分为两个并行 job：

- `e2e`：构建支持包与评测镜像、启动完整评测栈、noj-tests 23 个测试文件
  分 3 组并行（每组 `deno test -A <files...>`，`run_group` + `wait` 严格
  检查退出码）。
- `judge-sandbox`：只依赖 Docker daemon + Redis service（评测镜像由测试内
  `ensure_test_image` 自建），6 个沙箱 binary 分 2 组并行
  （组内 `--test-threads=1` 串行，`serial_test` 保证 binary 内串行）。

`e2e.yml` 的 `paths-ignore` SHALL 包含：`docs/**`、`noj-docs/**`、
`**/*.md`、`openspec/**`、`.opencode/**`、`.claude/**`、`noj-ui/**`、
`docker-compose.yml`、`LICENSE`、`scripts/dev/**`、`scripts/db/**`、
`.github/dependabot.yml`、`.github/actionlint.yaml`、
`.github/workflows/ci.yml`。

#### Scenario: noj-tests 3 组并行

- **WHEN** `e2e` job 运行 noj-tests
- **THEN** 23 个文件按字母序均分为 3 组并行执行（组间独立进程）
- **THEN** admin 改密竞态由 `helper.ts` `loginAndChangePassword` 并发兜底
  （改密流程包在最多 3 轮重试内：任何一步因并发竞态失败即重试整轮，
  下轮先用 newPassword 登录收敛）
