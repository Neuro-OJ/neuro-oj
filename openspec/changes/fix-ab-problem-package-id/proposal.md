## Why

A+B 示例题的 manifest、题面和数据库题号已经是 1001，但源目录和构建产物仍使用 1003，容易造成题目源、支持包与文档不一致。

## What Changes

- 将 A+B 样例题支持包的 manifest 题号和标题同步为 1001。
- 将 A+B 样例题源目录和构建产物统一改为 1001。
- 更新当前项目文档中的 A+B 路径和题号引用。
- 重建并重新导入本地样例支持包，替换数据库中的旧包引用。

## Capabilities

### New Capabilities

- 无。

### Modified Capabilities

- 无；这是既有样例题数据的一致性修复，不改变系统行为约定。

## Impact

- 影响 `noj-core/data/problems-src/1001/` 的样例题源文件、构建产物和本地开发数据库中的 A+B 支持包。
