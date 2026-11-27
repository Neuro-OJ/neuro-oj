# Agent Note: 精简并提速 CI / E2E / Security 流水线

Status: implemented

## Problem

实测近期 GitHub Actions 运行（`main` push `45841732370` / `45841732421`、功能 PR `46005962436` / `46005962498` / `46005962577`、纯文档 PR `46007536467`）显示流水线同时存在「关键路径长」与「冗余作业多」两类问题：

1. **总规模过大**：一次全量运行拉起 49 个 job（CI 21 + E2E 23 + Security 5），消耗 ~67 分钟 Runner 机时，墙钟 6–7.5 分钟；连纯文档 PR 也要跑 10 个 job、等待 1.5–2.7 分钟。
2. **CI 关键路径集中在 `core-test-sharded`（6m05s–7m20s）**：单机跑 `--shards 4 --jobs 2` 导致两波串行；且 `changes` 已由 `scripts/select-core-ci.ts` 算出 `core-modules`，但从未传给启动器。
3. **无条件运行与重复测试**：`coverage-check`、`production-cli`、`production-cli-e2e`、`supply-chain`、`entrypoint-smoke`（仅 4 次 `statSync`）、`config-usage-check` 在所有 PR 上无条件执行；`coverage-check` 未配缓存且把 `noj-ui` / `noj-llm-gateway` 单测完整重跑一遍；`paths-filter` 未排除 `*.md`。
4. **WASI 验收 4 分片负优化**：每个分片 `cargo build` 占 ~1m33s、实际执行仅 ~24s，4 个独立 job 重复编译 4 遍浪费 ~7 分钟机时。
5. **E2E 空转与过度拆域**：`judge-sandbox`（4m30s）、`problem-local-test`（1m40s）、`e2e-ui-build`（1m）在 PR 上无路径过滤；6 个标准环境轻量 API 域（如 `admin` 仅 262ms 用例）各自重复 50s 环境启动与 13 遍重复静态脚本校验；`contest_lifecycle.test.ts` 的 90s 竞赛窗口导致测试空等 ~88s。
6. **Security 源码编译工具**：`cargo-audit` 每次 `cargo install` 编译耗时 2m48s，审计本身仅 15s。

## Decision

- **`noj-core` 测试启动器支持分片切片与模块范围**：
  - 在 `noj-core/scripts/test-parallel-args.ts` / `test-parallel-shards.ts` / `test-launcher-args.ts` / `test-launcher.ts` 新增 `--shard-index`（完整规划并审计后仅执行指定分片）与 `--modules`（仅发现指定模块测试根与迁移入口）。
  - `scripts/select-core-ci.ts` 补充输出 `core-run` / `core-shards` / `core-modules-csv`；`ci.yml` 的 `core-test-sharded` 在 `main` push / `core-full` 时用 4 路 matrix 并行执行 4 片（墙钟由 6–7m 降至 ~2.5m），PR 仅改单模块时单机跑受影响模块闭包。
- **精简 `ci.yml` 作业与补齐缓存**：
  - 将 `supply-chain`、`entrypoint-smoke`、`config-usage-check` 并入 `root-gates`。
  - 合并 `production-cli` 与 `production-cli-e2e` 为单一 `production-cli` 作业并接入 `cli` 路径过滤。
  - 将 `noj-ui`（≥60%）与 `noj-llm-gateway`（≥54%）覆盖率阈值门禁直接并入 `ui-check` 与 `gateway-check` 单测步骤，移除重复跑单测的 `coverage-check` job（本地 `scripts/coverage-report.ts` 保留）。
  - 将 `ui-components`（Vitest）并入 `ui-check` 复用 `nuxt typecheck` 上下文，并为 `ui-check` 补上 `~/.cache/ms-playwright` 缓存。
  - 所有代码模块 `paths-filter` 使用 `picomatch` 内联排除模式 `/**/!(*.md)`（避免默认 `some` 语义下独立 `'!...'` 规则扩大匹配），并为 `ci.yml` / `e2e.yml` / `security.yml` 的 `changes` job 显式声明 `pull-requests: read`；WASI 作业改用独立 `wasi` 路径过滤，并将 `judge-wasi-acceptance` 合并为单 job 一次编译 + 4 组并发（`check-oi-wasi-toolchain.sh all`）。
- **精简 `e2e.yml` 与 `e2e-domain` action**：
  - 为 `e2e-ui-build`、`judge-sandbox`、`problem-local-test` 接入 `changes` 过滤（`main` push / 手动 / 发布仍全量）。
  - 将 6 个标准环境轻量 API 域（`identity`/`admin`/`system` 与 `catalog`/`community`/`objective`）合入 2 个并发批次 job（`e2e-api-core` / `e2e-api-content`），支持按 `selected-domains` 仅运行命中域；保留有特殊环境的 `submission` / `contest` / `rate-limit` / `cross-domain` / `browser`。
  - 移除 `.github/actions/e2e-domain/action.yml` 中已在 `root-gates` 执行的 3 项重复静态校验；正常通过时跳过冗余容器日志转储，失败/取消时保持完整采集与上传；缓存命中时跳过 Playwright 安装。
  - 将 `noj-tests/e2e/contest/contest_lifecycle.test.ts` 的 `CONTEST_WINDOW_MS` 由 90s 调整为 25s（覆盖 1–2s 评测仍有 10× 余量），直接缩短 `E2E contest` 关键路径 ~65s。
- **提速 `security.yml`**：
  - `cargo-audit` 改用已固定 SHA 的 `taiki-e/install-action` 安装 `cargo-audit@0.22.2` 预编译二进制（~3m09s → ~25s）；`dependency-review` 仅在依赖文件变更时执行。
- **同步守卫测试**：更新 `scripts/verify-domain-ci.ts`、`scripts/select-core-ci_test.ts`、`noj-judge/scripts/test_ci_wasi.py`、`noj-core/tests/scripts/test-parallel.test.ts` 与 `test-launcher.test.ts`，保持 100% 防漂移校验。

## Alternatives considered

- **在 `core-test-sharded` 单机直接改 `--jobs 4`**：单台 4 vCPU Runner 上 4 个 Deno 进程 + PostgreSQL + 4 个 Redis 容器竞争 CPU/内存，不如 4 路 GHA matrix 稳定且隔离彻底。
- **把 `E2E contest` 拆成 2 个分片**：定位到主要耗时来自 `contest_lifecycle.test.ts` 固定 90s 等待窗口而非用例过多，缩短窗口至 25s 即可在不增加 Runner 成本的前提下立省 65s。
- **保留独立 `coverage-check` 仅加缓存与过滤**：即便缓存命中，仍会重复起 PG/Redis 并把 `noj-ui` 和 `noj-llm-gateway` 单测再跑一遍，直接并入各自模块 job 更简洁且无覆盖损失。

## Consequences

- `ci.yml` 由 21 个 job 精简至 11 个顶层 job（全量 14 个执行实例），`e2e.yml` 由 23 个 job 精简至 ~15 个执行实例，总机时大幅下降。
- 纯文档 PR 仅运行 `root-gates`（~30s），不再触发前端构建、CLI E2E 或覆盖率重跑；`main` push、手动触发与 Release `workflow_call` 仍保持全量覆盖。
- 仓库 ruleset 未绑定写死的 required status check 名称，作业名合并与精简无需同步 GitHub 后台规则。
