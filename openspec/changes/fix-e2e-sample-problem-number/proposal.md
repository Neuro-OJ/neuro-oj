## Why

A+B 示例题的展示题号已统一为 P1001，但 E2E 测试仍请求
P1003，导致题目模板、算法标签和题单流程在 CI 中失败。

## What Changes

- 将 E2E 测试中的 A+B 示例题引用从 P1003 更新为 P1001。
- 移除对已不存在的旧 P1001 模板来源的重复断言。

## Capabilities

### New Capabilities

- 无。

### Modified Capabilities

- 无（仅更新测试基准数据的已知题号）。

## Impact

- `noj-tests/e2e/01_tags.test.ts`
- `noj-tests/e2e/17_problem_template.test.ts`
- `noj-tests/e2e/trainings.test.ts`
