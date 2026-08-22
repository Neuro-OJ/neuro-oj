## Context

统一题目包以根级 `problem.json` 的 `(type, number)` 作为幂等导入键。当前 A+B 示例题数据库记录为 P1001，而构建产物保留了 P1003 的 manifest。

## Goals / Non-Goals

**Goals:**

- 让样例题 manifest、题面标题和数据库题号一致。
- 通过标准 CLI 重建和导入替换旧支持包。

**Non-Goals:**

- 不修改题目评测逻辑、测试数据或评测机协议。

## Decisions

- 保留源码目录 `1003` 作为内部样例路径，仅修正导入时生效的 manifest 与题面标题；这避免不必要的目录迁移，同时保证生成包和数据库键一致。
- 使用现有 `problems build` 和 `problems import` CLI 重建并更新本地存储，避免手动修改数据库支持包地址。

## Risks / Trade-offs

- [旧构建产物仍被导入] → 仅重新构建并导入该样例包，随后检查支持包内 manifest 与数据库记录。
