## Why

导入包 E2E 使用仅打印结果的 Evaluator，未参与双容器调用协议。在并发 E2E 中该短生命周期脚本会导致评测机未观察到最终结果标记，产生不稳定的 SystemError。

## What Changes

- 将导入包 Evaluator 改为通过 `SolutionRunner` 调用用户的 `solve` 函数。
- 将闭环提交改为符合该函数协议的 A+B 解答。

## Capabilities

### New Capabilities

无。

### Modified Capabilities

无。仅增强 E2E 测试夹具。

## Impact

- `noj-tests/e2e/24_import_bundle.test.ts`
