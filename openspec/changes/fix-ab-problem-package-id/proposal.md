## Why

A+B 示例题已改为题号 1001，但其支持包内 manifest 仍声明 1003，导致题目元数据与评测包不一致并触发支持包错误。

## What Changes

- 将 A+B 样例题支持包的 manifest 题号和标题同步为 1001。
- 重建并重新导入本地样例支持包，替换数据库中的旧包引用。

## Capabilities

### New Capabilities

- 无。

### Modified Capabilities

- 无；这是既有样例题数据的一致性修复，不改变系统行为约定。

## Impact

- 影响 `noj-core/data/problems-src/1003/` 的样例题元数据和本地开发数据库中的 A+B 支持包。
