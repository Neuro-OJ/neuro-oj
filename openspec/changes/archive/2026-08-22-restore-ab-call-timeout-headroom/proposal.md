## Why

将 P1001 单次调用时限降至 1 秒后，CI 中正常的 A+B 解答会因容器调度和 IPC 开销被误判超时。总时限已独立扩大，单次调用需要恢复足够余量。

## What Changes

- 将 P1001 单次调用时限恢复为 5 秒。
- 保持 30 秒的评测器总时限与调用超时透传逻辑。

## Capabilities

### New Capabilities

无。

### Modified Capabilities

无。仅调整示例支持包的内部运行参数。

## Impact

- `noj-core/data/problems-src/1003/problem.json`
