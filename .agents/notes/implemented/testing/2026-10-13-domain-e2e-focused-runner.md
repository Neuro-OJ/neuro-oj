# Agent Note: 标准 E2E 域入口支持聚焦回归

Status: implemented

## Problem

跨模块 E2E
同时升级多个既有契约时，标准入口只接受一个域参数。验证一条新增链路也必须运行整组旧夹具，降低缺陷反馈速度。

## Decision

`deno task test:domain <domain>` 保留固定环境和对应目录，并把其后可选参数传给
`deno test`。例如 `--filter=workspace-teaching`
可以聚焦新场景，不必手拼环境与测试命令。

core
同样支持可选测试参数；迁移与管理员种子仍完整执行，过滤只应用于业务模块测试。PGlite
模板同步和 preload 事务隔离保持标准入口原有流程。

## Alternatives considered

- 直接调用 `deno test`：容易漏统一环境，与项目测试要求不一致。
- 为每个具体文件增加任务：重复配置，新增场景还要不断修改入口。

## Consequences

既有单域调用行为不变，缺少或非法域仍由标准入口拒绝。Shell 语法检查和实际 catalog
模板过滤回归通过。过滤结果明确报告被过滤的测试，不能当作整组测试通过。
