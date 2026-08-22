## Why

P1004「星港舱门报码归一化」不再需要作为开发示例题。继续保留会让新初始化的题库出现不需要的题目，并让端到端测试依赖过时的星港提交格式。

## What Changes

- 删除 P1004 的题目源和本地支持包。
- 将端到端测试的固定示例题描述及提交代码切换为 P1001「A+B Problem」。
- 保留 P1001 为唯一开发示例题。

## Capabilities

### New Capabilities

无。

### Modified Capabilities

无。本次只调整开发样例和测试夹具，不改变产品行为契约。

## Impact

影响 `noj-core/data/problems-src/1001/`、本地构建产物和 `noj-tests/e2e/`
的测试夹具。
