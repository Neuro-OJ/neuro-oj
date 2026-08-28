# Agent Note: 类型安全基础（assertNever + 终态判定）

Status: implemented

## Problem

提交状态是 string union，但缺少穷尽检查；新增状态时 switch 可能静默漏分支，且没有统一的不可达分支处理。

## Decision

在 `noj-core/src/types/index.ts` 新增：

- `assertNever(value: never): never`：closed union 的 default 分支辅助，新增状态时编译期报错。
- `isTerminalSubmissionStatus(status: SubmissionStatus): boolean`：用 switch + assertNever 穷尽判断终态。

新增 `noj-core/tests/types_safety_test.ts` 覆盖终态判定与 assertNever 抛错行为。

## Alternatives considered

- 一次性完成所有 JudgeTask/JudgeResult 的 tagged union 与 Branded ID 改造：改动面过大，不适合单独提交。
- 不添加辅助函数：状态分支继续靠人工保证。

## Consequences

- 提交状态分支获得编译期穷尽检查基础。
- 后续可将 `isTerminalSubmissionStatus` 替换散落的 `status === "finished" || status === "error"` 判断。
- JudgeTask/JudgeResult tagged union 与 Branded ID 留待后续架构里程碑继续。
