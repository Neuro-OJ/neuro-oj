## Why

P1001 使用 Solution SDK 的 `solve(input_str)` 函数协议，但 API E2E 仍提交读取标准输入的旧样例。正常解没有输入可读，因而被误判超时，连带使竞赛、重测和评测管道失败。

## What Changes

- 将 P1001 的 API E2E 代码样例统一为 `solve(input_str)` 协议。
- 让 P1001 评测器将用户运行或语法异常明确报告为 `RuntimeError`。

## Capabilities

### New Capabilities

无。

### Modified Capabilities

无。仅修复示例支持包与测试夹具的内部契约。

## Impact

- `noj-tests/e2e/helper.ts`
- `noj-core/data/problems-src/1003/evaluate.py`
