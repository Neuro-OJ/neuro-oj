# Agent Note: core 功能切片骨架（defineFeature + 功能清单装配）

Status: implemented

## Problem

core 重构（`openspec/changes/refactor-core-feature-slices`）要求新功能放在
`src/features/<name>/` 一个目录内，加功能只改清单一行。现状是 `create-app.ts`
手工导入约 30 个路由、`create-system.ts` 手工启动后台进程、`TASK_TYPES`
集中登记任务类型，`test:domain` 依赖 `module-boundaries.json`
手工登记，新功能无处落脚。

## Decision

- 新增 `src/shared/feature.ts`：`defineFeature()` 声明路由、后台任务、常驻
  worker 与观测注册；功能名必须为 kebab-case，任务类型必须以 `<name>.`
  为前缀；`collectFeatureTasks()` 在启动期拒绝重复功能、重复任务与内置类型冲突。
- 新增 `src/features.ts` 功能清单；`createApp`（路由挂在旧模块路由之后、admin
  之前，并执行观测注册）、`createBackgroundHandlers`（合并功能任务）与启动流程（登记功能
  worker）遍历清单，与旧装配并存。
- 任务合同新增 `FeatureTaskType` / `AnyTaskType` / `AnyTaskTargetKind`，内置
  `TaskType` 与启动校验保持不变；`background_tasks` 表无类型约束，无需迁移。
- 新增 `scripts/check-feature-boundaries.ts` 门禁：跨功能只经
  `index.ts`、底座不依赖功能、功能不深入旧模块内部（迁移期允许旧模块 `index.ts`
  与 `contracts/`）、功能间无运行时循环。
- `test:domain <name>` 优先解析 `src/features/<name>/`；全量与并行入口扫描
  `src/features`；CI 中 `src/features/**` 与 `src/features.ts` 归为 core 全量。
- 底座沿用 `src/shared/`，取消原计划的 `shared/` → `kernel/` 改名（需改 789
  个文件、2283 行 import，只换名称且让并行分支全部冲突）。

## Alternatives considered

- 改名为 `kernel/`：收益仅为名称，冲突成本过高，放弃。
- 把任务类型整体放宽为字符串：会削弱内置任务的启动期完整性校验，改为内置与功能两类并存。
- 为每个功能新增 CI job：需要持续登记，违背「加功能不登记」目标，改为归入 core
  全量。

## Consequences

- 当前清单为空，行为与路由表不变；全部门禁、`deno task check` 与共享测试（465
  通过）通过。
- 下一步阶段 3：将题单迁入 `src/features/trainings/` 作为首个样例并按「改动 ≤6
  文件」验收。
