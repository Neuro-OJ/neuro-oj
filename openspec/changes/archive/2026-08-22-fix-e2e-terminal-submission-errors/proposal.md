## Why

P1001 A+B 的评测总时限短于 CI
中双容器的固定启动开销，导致正常或预期失败的评测被记为 `SystemError`。E2E
轮询又没有把 `error` 当作终态，使每个失败提交额外等待 90 秒。

## What Changes

- 将 P1001 评测器总时限提高至适合双容器运行的 5 秒。
- 让 E2E 提交轮询在 `error` 状态立即抛出包含评测结果的错误。

## Capabilities

### New Capabilities

无。

### Modified Capabilities

无。本次仅修复示例题运行配置和测试基础设施的终态识别。

## Impact

影响 P1001 的题目清单和 `noj-tests/e2e/helper.ts`，减少 CI 的错误等待时间。
