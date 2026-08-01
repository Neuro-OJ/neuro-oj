# 实施任务

## Phase 1 — CI 低风险重组

- [x] 删除 `core-fmt` / `core-lint`（`core-quick-check` 已含 fmt+lint+typecheck）
- [x] 合并 `judge-fmt` / `judge-clippy` / `judge-test` 为 `judge-check` 单 job
- [x] 新增 `changes` job（`dorny/paths-filter@v3`，fetch-depth: 0），
      各 job 条件 `github.event_name != 'pull_request' || needs.changes.outputs.X`
- [x] e2e.yml `paths-ignore` 扩充（noj-ui、.claude、ci.yml、本地脚本等）

## Phase 2 — Rust 编译加速

- [x] `judge-check` / `judge-e2e` 引入 `mozilla/sccache-action`（
      `permissions: actions: write`，fork PR 自动降级只读）
- [x] `taiki-e/install-action` 安装 cargo-nextest，`cargo nextest run --all-targets`
      （已验证无 doctest，覆盖等价；本地 224 测试全过）
- [x] 沙箱 E2E 6 个 binary 分 2 组并行（run_group + wait 严格检查退出码）

## Phase 3 — noj-core 测试并行化

- [x] `connection.ts` 支持 `TEST_SCHEMA`（libpq `-csearch_path=<schema>,public`
      startup 参数，池内所有连接生效）
- [x] `migrate.ts`：TEST_SCHEMA 下 `migrationsSchema` 指向同 schema
      （避免共享 drizzle 迁移记录导致"已迁移"误判跳过）
- [x] `scripts/test-parallel.ts` + `deno task test:parallel`（unit/db 两组，
      并行 spawn + 退出码汇总）
- [x] `search_bench.test.ts` 加 `NOJ_RUN_PERF=1` guard
- [x] ci.yml `core-test` 拆为 `core-test-unit`（PGlite+Redis）/
      `core-test-db`（PG+Redis）/ `core-perf`（仅 main+manual）
- [x] **修复迁移 FK public 前缀**：0010/0027/0029 的
      `REFERENCES "public"."xxx"` → `REFERENCES "xxx"`（分片下 FK 错指
      public 的根因；public 模式行为不变）
- [x] 验证：`deno task test:parallel` 全绿（db 497 + unit，2m23s 并行）

## Phase 4 — E2E 并行化

- [x] `helper.ts` `loginAndChangePassword` 并发兜底（改密失败重试新密码登录）
- [x] e2e.yml 拆为 `e2e`（noj-tests 23 文件 3 组并行）与 `judge-sandbox`
      （独立 job：Docker + Redis service + sccache，6 binary 2 组并行）
- [x] actionlint 全 workflow 零报错

## Phase 5 — 收尾

- [x] 文档：AGENTS.md §12/§13、noj-core/CLAUDE.md、noj-judge/AGENTS.md
- [x] 回归：`deno task test`（PGlite 串行）607 passed；`deno task test:parallel`
      全绿；fmt/lint 通过
- [x] 推送 PR（GPG 签名）后观察 CI 实际耗时对比（PR #183：12/12 checks
      全绿；Full Pipeline 2m17s、Judge E2E 1m28s、Judge Sandbox 2m30s、
      Core Test-DB 2m14s，对比优化前串行 ~15min）
