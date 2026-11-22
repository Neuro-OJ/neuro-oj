# Agent Note: #726 阶段 4：旧 runtime 模块迁入 shared 底座

Status: implemented

## Problem

`noj-core/src/modules/runtime/` 只剩约 1900 行：PostgreSQL 后台任务（合同、
仓库、重试策略、worker、观测 provider）、SSE 事件事务写入合同、系统身份构造器，
外加一个为 `features/knowledge` 中转的掌握度任务投递。它不承载业务，却以旧模块
身份占着 `module-boundaries.json` 的模块清单、测试映射、E2E 映射与两张表的归属。
`core-feature-slices/design.md` 第 5 节已写明 `runtime/tasks` 等应迁入底座
`shared/`。

## Decision

- 后台任务 → `src/shared/tasks/`（`contracts`、`repository`、`retry-policy`、
  `worker`、`observability`），测试 → `tests/shared/tasks/`，由
  `deno task test:shared` 执行。
- SSE 事务写入合同 → `src/shared/sse/sse-event-tx.ts`；只保留有调用方的
  `recordSseEventTx`，删除无调用方的 `recordSseEventsTx`、
  `replayRuntimeSseEvents`、`cleanupRuntimeSseEvents`（读取与清理侧本就由
  `shared/sse/sse-events.ts` 负责）。
- `createSystemActor` → `src/shared/access/system-actors.ts`；「HTTP 不得导入
  system actor 工厂」门禁改指向新路径。
- 掌握度任务投递归生产方：移到
  `modules/evaluations/services/versioning/knowledge-mastery-task.ts`，经
  evaluations 门面导出给 `features/knowledge`。
- 不保留 `runtime/index.ts` 门面：调用方直接导入 shared 内的具体文件，与其他
  底座用法一致。
- `module-boundaries.json` 删除 runtime 的全部登记；`background_tasks`、
  `sse_events` 归属改为 `shared`，边界脚本允许 `shared` 作为表归属方。
- 观测 provider 名 `runtime.background_tasks` 与日志分类不改，避免影响面板与告警。

## Alternatives considered

- **迁成 `features/runtime`**：它没有路由、没有业务语义，是所有功能共用的基础
  设施；做成功能会让其他功能都依赖一个功能。
- **掌握度投递放进 `features/knowledge`**：旧模块 evaluations 就得反向导入功能
  代码，违背「旧模块不依赖功能」的约定。
- **保留 `shared/tasks/index.ts` 聚合出口**：底座其他目录都直接按文件导入，
  多一层聚合只是新的登记点。

## Consequences

- 纯内部重构：API、表结构、任务类型与观测名不变，CHANGELOG 不记。
- `test:domain runtime` 不再存在；相关测试随 `test:shared` 运行。
- `shared/sse/` 下仍有两个 `recordSseEventTx`（严格事务版与宽松 Executor 版），
  合并留待后续单独处理。
