## Context

统一题目包以根级 `problem.json` 的 `(type, number)` 作为幂等导入键。当前 A+B 示例题数据库记录和 manifest 都是 P1001，但源目录与构建产物仍保留 1003 命名。

## Goals / Non-Goals

**Goals:**

- 让样例题 manifest、题面标题和数据库题号一致。
- 让 A+B 源目录、构建产物和当前文档统一使用 1001。
- 通过标准 CLI 重建和导入替换旧支持包。

**Non-Goals:**

- 不修改题目评测逻辑、测试数据或评测机协议。

## Decisions

- 将源码目录从 `1003` 重命名为 `1001`，使现有构建脚本按目录名生成的包名与 manifest.number 一致。
- 使用现有 `problems build` 和 `problems import` CLI 重建并更新本地存储，避免手动修改数据库支持包地址。

## Risks / Trade-offs

- [旧构建产物仍被导入] → 仅重新构建并导入该样例包，随后检查支持包内 manifest 与数据库记录。
