## Why

P1001 的单次用户函数调用时限和评测器总时限都设为 5 秒。评测器需要依次运行 20 个测试点，正常启动或异常代码都会耗尽总时限，最终被错误标记为 `SystemError`，导致端到端评测不稳定。

## What Changes

- 将 P1001 评测器总时限调整为能覆盖全部测试点和容器启动开销的值。
- 保留较短的单次用户函数调用时限。
- 评测脚本不再吞掉单次调用超时，使评测机能将其正确映射为超时结果。

## Capabilities

### New Capabilities

无。

### Modified Capabilities

无。本变更仅修复示例支持包的内部评测参数与异常处理，不改变对外 API 或题目功能规格。

## Impact

- `noj-core/data/problems-src/1003/problem.json`
- `noj-core/data/problems-src/1003/evaluate.py`
- P1001 支持包构建与全链路评测
