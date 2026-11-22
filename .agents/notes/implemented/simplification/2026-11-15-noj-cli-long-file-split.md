# Agent Note: 按职责拆分 noj-cli 的超长文件

Status: implemented

## Problem

noj-cli 有几份文件把多个职责塞在一起，长度接近或超过阅读舒适范围：

- `prod/drill/drill.ts`（1117 行，距 1200 行门禁仅一步）：演练编排、隔离栈的 compose
  步骤、报告/指标落盘与失败清理全在一个文件。
- `prod/judge/config.ts`（885 行）：`.env.judge` 配置与安全守卫之外，还包含本机 Redis
  容器的创建逻辑。
- `prod/lifecycle/steps.ts`（777 行）：共享步骤之外，还有 logs 着色契约与 uninstall
  前置/安装目录守卫。
- `prod/cli_test.ts`（1875 行）：通用接线、judge 与 backup 的接线回归混在一起。

另外，drill 模块里残留三处"为保持旧导入点不变"的再导出（`makeIdempotentGlobals`、
`valueOr`、`METRIC_LAST_SUCCESS`/`REPORT_FILE_NAME`）。

## Decision

- `drill.ts` 保留编排与解包/准备（515 行）；compose 步骤（起服务、恢复数据、数据核对、
  业务服务启动）与 `DrillContext` 移到 `drill/stack.ts`；报告与指标落盘、失败清理、
  演练栈拆除移到 `drill/finish.ts`。删除上述再导出，测试改为从原始模块导入。
- `judge/config.ts` 中本机 Redis 的常量、校验与 `createLocalRedis` 移到
  `judge/local-redis.ts`。
- `lifecycle/steps.ts` 的 logs 着色契约移到 `lifecycle/logs-color.ts`，uninstall 前置与
  安装目录守卫移到 `lifecycle/uninstall-guards.ts`；原分节说明转为新模块的头注释。
- `prod/cli_test.ts` 按命令族拆为 `cli_test.ts`（门禁、参数解析、通用接线）、
  `cli_judge_test.ts`、`cli_backup_test.ts`，共享夹具放 `cli_fixtures.ts`；42 个用例
  全部保留。
- 纯搬移：函数体不改，导入方直接改为从新模块导入，不留门面。

## Alternatives considered

- 同时拆 `judge/actions.ts`（775 行）与 `commands/backup.ts`（702 行）：两者各自是一个
  命令族的动作集合，内聚度高，拆开反而要跨文件跳转。
- 同时拆 `drill_test.ts` 等超长测试：属于"测试体量"一批，届时与精简用例一并处理。
- 给新模块保留从旧位置的再导出：门面会让同一符号有两个导入路径，正是本系列在消除的。

## Consequences

- noj-cli 源文件（非测试）最长降到 775 行，drill 不再贴近 1200 行门禁。
- 新增演练步骤放 `drill/stack.ts`，收尾逻辑放 `drill/finish.ts`；uninstall 守卫与 logs
  着色各有独立模块，`steps.ts` 只放 install/start/update 共享步骤。
- 新的 CLI 接线回归按命令族放入对应的 `cli_*_test.ts`。
