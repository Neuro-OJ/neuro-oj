# Agent Note: evaluation-gate 取消用例的未处理拒绝竞态

Status: implemented

## Problem

`noj-tests/tests/unit/evaluation-gate.test.ts` 约 1/5 概率失败（CI Root Gates
同样复现），报 `EvaluationGateError: gate 已被取消：unit-cancel-<uuid>` 且 "This
error was not caught from a test"，导致整个模块的用例全部判失败。

「DELETE 取消等待者并清理」用例先发起 `waitForEvaluationGate`（长轮询），再
`await deleteEvaluationGate(...)`，之后才 `assertRejects(() => waiting)`。
协调服务处理 DELETE 时会先唤醒等待者，等待请求的响应可能早于 DELETE 响应到达；
此时 `waiting` 已 reject 却还没有处理器，Deno 在事件循环下一轮即判定为未处理
拒绝。被测实现（`noj-tests/fixtures/evaluation-gate.ts`）行为正确，竞态只在测试。

## Decision

在发出 DELETE 之前先调用 `assertRejects(() => waiting, EvaluationGateError)`
取得断言 promise（同步挂上拒绝处理），DELETE 返回后再 `await` 它并检查
`kind === "cancelled"`。断言语义不变，只调整处理器挂载时机。

## Alternatives considered

- `sanitizeOps: false` / 忽略用例 / 对 `waiting` 加空 `catch`：会掩盖真实失败，
  不采用。
- 修改协调服务让 DELETE 先响应再唤醒等待者：属于掩盖测试时序假设，且真实
  评测链路本就允许任意顺序。

## Consequences

- 修复后本地连续 50 次运行全部通过。
- 写此类「先发起、后触发取消」的测试时，须在触发取消前对被取消的 promise
  挂好断言或处理器。
