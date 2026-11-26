# Agent Note: 架构收敛（Phase 2.6）、跨端 API 契约共享、门禁加固与评测编译器复用

Status: implemented

## Problem

1. `noj-core` 的 `system-settings`、`audit-log` 与 `actor` 仍驻留在 `modules/platform` / `modules/access`，其中 `system-settings.ts` 直接反向依赖 `education/contracts/module-facts.ts` 和 `access/contracts/actor.ts`，阻塞核心切片重构 Phase 2.6；且 `noj-core/scripts/check-config-usage.ts` 仍残留旧路径 `/domains/system/services/system-settings.ts`。
2. `noj-core` 与 `noj-ui` 对已迁入 `features/` 的接口（签到、标签、题单、BYOK、AI 评测反馈）各自手写 DTO，存在长期类型漂移。
3. 工程门禁与跨端脚本存在盲区：`deploy/install.sh` 在 macOS Bash 3.2 `set -u` 下因中文括号紧邻 `$VERSION` 报 `unbound variable`；`scripts/check-write-rate-limits.ts` 因 `rate-limit-env` 路径含 `rate-limit` 字串而误放行 `admin/routes/system.ts`；`noj-tests/e2e/` 在已有 `e2eTest` 跳过封装的情况下仍保留 207 条冗余 `if (!isE2E) return;`，将静默跳过清单抬高到 333 处。
4. `noj-judge` 的本地 Docker `testlib` checker 在每个测试点内重复执行 `g++` 编译；非 Linux 平台 `wasm_compile.rs` 因不可达分支触发 `clippy` 失败；`noj-ui` 存在 `DomainContestRankingRow` 重复自动导入与 `contest-types.ts` 的 `~/` 路径在 `deno check` 下报错的问题。

## Decision

1. **底座下沉（Phase 2.6）**：将 `actor` 迁入 `noj-core/src/shared/access/actor.ts`，`audit-log` 与类型迁入 `noj-core/src/shared/audit/`，`system-settings` 迁入 `noj-core/src/shared/config/system-settings.ts`，通过 `registerSettingChangeHook` 解耦 `instance_allowed_modules` 到 `modules/education/index.ts`，旧路径保留具名兼容重导出，并迁移 `features/`、`http/create-app.ts`、`application/create-system.ts` 的直接导入。
2. **前后端契约单源同步**：建立纯类型事实源 `noj-core/src/shared/api-contracts/features.ts` 与生成器 `scripts/gen-api-contracts.ts`（含 `--check` 门禁与单测），自动同步到 `noj-ui/utils/generated/api-contracts.ts`，保持各模块 Docker / `deno compile` / `tsc` 构建独立性的同时消除手写漂移。
3. **门禁与测试基线清理**：修复 `deploy/install.sh` 的 `${VERSION}` / `${DIR}` 变量边界写法；收紧 `scripts/check-write-rate-limits.ts` 排除 `rate-limit-env` 假阳性并登记 `admin/routes/system.ts`；清理 `noj-tests/e2e/` 中 `e2eTest` 体内的 207 处冗余 `if (!isE2E) return;`，将静默跳过基线从 333 降至 126。
4. **评测与前端工程优化**：抽取 `noj-judge/src/oi/runner.rs` 的 `compile_in_container` / `compile_native_checker`，将 `testlib` checker 编译收敛为每份提交一次；用 `#[cfg(target_os = "linux")]` 隔离 `wasm_compile.rs` 平台实现；消除 `noj-ui` `DomainContestRankingRow` 重复导出与 `contest-types.ts` `TS2307` 错误。

## Alternatives considered

- **通过跨包相对路径直接 `import ../noj-core/...` 共享类型**：会破坏 `noj-core/Dockerfile` 与 `noj-ui/Dockerfile` 仅拷贝本模块目录的独立构建语义，且会将 Deno `.ts` 说明符带入 `vue-tsc`，故采用仓库既有的“纯类型事实源 + 生成器 `--check` 门禁”模式。
- **在 `shared/config/system-settings.ts` 中直接保留对 `education` 的硬编码调用**：会触发 `shared-business-dependency` 边界违规并保留循环依赖隐患，故采用显式 `registerSettingChangeHook` 机制由业务模块在模块加载时注册。

## Consequences

- `noj-core` 底座下沉打通：`actor`、`audit-log` 与 `system-settings` 均已落入 `shared/`，消除了 `platform` 对 `access` / `education` 的反向依赖，`features/` 切片可直接消费底座能力。
- 前后端契约由单一事实源 `noj-core/src/shared/api-contracts/features.ts` 驱动，并通过 `scripts/gen-api-contracts.ts --check` 纳入仓库门禁，防止手写 DTO 漂移。
- 仓库静态门禁与 E2E 跳过基线更真实：`install.sh` 兼容 macOS Bash 3.2，`check-write-rate-limits.ts` 不再被 `rate-limit-env` 误放行，静默跳过基线由 333 处降至 126 处。
- `noj-judge` 的本地 `testlib` checker 每份提交仅编译一次，且非 Linux 平台通过 `clippy -D warnings`；`noj-ui` 消除了重复自动导入告警与 `deno check` 路径错误。
