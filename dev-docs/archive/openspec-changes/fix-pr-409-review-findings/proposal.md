## Why

PR #409 的部分错误处理与 E2E 断言仍存在缺口：管理端部分 gateway 转发失败会伪装成 500，空排名可能被测试误判为通过，且运行期错误测试没有强制验证 `error` 状态。现在修复这些缺口，才能让 PR 的目标行为真正受到保护。

## What Changes

- 为所有管理端 LLM gateway 转发路由统一映射可预期的 gateway 错误。
- 让 P1001 运行期错误稳定产生 judge `error` 结果，并用严格 E2E 断言覆盖该行为。
- 让竞赛排名 E2E 在排名为空时失败，而不是因可选链表达式误通过。
- 增加对应的路由/行为测试与 Agent Note。

## Capabilities

### New Capabilities

- `review-fixes/gateway-and-e2e`: 管理端 gateway 错误、评测错误状态及 E2E 断言契约。

### Modified Capabilities

无。

## Impact

- `noj-core/src/domains/gateway/routes/admin-llm.ts` 及其测试。
- `noj-core/data/problems-src/1001/evaluate.py`、`noj-tests/e2e/06_pipeline.test.ts`、`noj-tests/e2e/22_contest_lifecycle.test.ts`。
- 新增 `.agents/notes/implemented/bug-fix/` 决策记录；不改变公共成功响应格式。
