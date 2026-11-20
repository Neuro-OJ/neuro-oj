# Agent Note: 题单迁入 src/features/trainings 作为功能切片样例

Status: implemented

## Problem

core 重构阶段 3 需要用一个真实功能验证「一个功能一个目录」结构。题单原先散在
`modules/problems` 的
routes、services/workspace（三个文件）、types、cross-module 合同，以及
`application/problems.ts` 的三个命令包装与 `create-app.ts` 的手工挂载中；另有
`services/trainings.ts`（`listUserTrainings`）与
`types/trainings.ts`（私有/隐链/公开可见性）在生产代码中已无调用方。

## Decision

- 迁入
  `src/features/trainings/`：`routes.ts`、`service.ts`、`access.ts`、`copy.ts`、`routes.test.ts`、`index.ts`（`defineFeature` +
  唯一对外出口）与 `README.md`，并在 `src/features.ts` 登记。
- 路由直接调用本功能服务，删除 `application`
  中的题单命令包装与导出；删除合同转出文件与两处死代码。
- 题单所需的旧模块能力经模块出口获取：`access/index.ts` 新增导出鉴权中间件与
  `loadDomainProblemProtection`，`problems/index.ts`
  新增导出题目复制函数并移除题单导出；教学作业改为从
  `features/trainings/index.ts` 引用。
- 题单路由的 no-store 中间件从 `/domains/:slug/*`
  收窄为本功能路径：功能路由挂在清单末尾，过宽通配会波及后续路由。
- 路由发现（`gen-route-catalog.ts`，供写入限流门禁使用）原先只扫描 `/routes/`
  目录，会让功能内 `routes.ts` 静默逃过限流检查；改为同时扫描
  `src/features/**/routes.ts` 并补测试。
- 表定义保留在 `src/shared/db/schema/`：被作业等表外键引用，且迁移统一生成。

## Alternatives considered

- 表定义随功能迁入 `features/trainings/schema.ts`：需要
  `shared/db/schema/index.ts` 反向引用功能，违反「底座不依赖功能」规则，放弃。
- 为题单新增 cross-module 合同文件：与精简目标相反，改为在旧模块 `index.ts`
  补导出（迁移期规则允许）。

## Consequences

- 路由处理函数集合迁移前后完全一致；唯一变化是题单 no-store
  中间件路径收窄（各路由响应头不变，题单与资源管理路由各自设置 no-store）。
- 新增功能（含表、路由、后台任务、测试）需手动改 6 个文件：功能目录 4 个 +
  `features.ts` + schema；写路由不使用限流中间件时仍需在限流豁免名单登记。
- 移动测试文件需同步 `test-duration-baseline.json` 路径。
- 门禁、`deno task check`、trainings/education/problems/contests
  域测试与共享测试全部通过。
