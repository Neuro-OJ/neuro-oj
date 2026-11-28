# dev-docs — 工程文档与过程记录

`dev-docs/` 放**维护者向**的工程文档：规范、评审、审计、验收与改造记录。
面向用户的文档在 `noj-docs/`（文档站）；AI 指令在仓库根与各模块的 `AGENTS.md`。

## 目录

| 目录                                     | 内容                                                | 状态              |
| ---------------------------------------- | --------------------------------------------------- | ----------------- |
| [`agents/`](agents/)                     | AI 指令的下沉细节：模块地图、流程、测试矩阵、规范   | 活文档            |
| [`engineering/`](engineering/README.md)  | 工程规范：架构、边界、安全、可观测性、WASM、测试    | 活文档，见其 README |
| [`design/`](design/)                     | 设计 token 与 UI 视觉契约                           | 活文档，代码与 CI 引用 |
| [`product/`](product/)                   | 进行中的产品设计与路线图：`DESIGN.md` / `PRODUCT.md` / `ROADMAP.md` | 活文档            |
| [`refactor/`](refactor/)                 | 进行中的设计：core 功能切片重构提案（proposal/design/tasks） | 活文档            |
| [`acceptance/`](acceptance/)             | 时点验收记录（含 PR body 存档）                     | 只读快照          |
| [`postmortem/`](postmortem/)             | 事故复盘                                            | 只读快照          |

## 约定

1. **只读快照不回溯修改**。被代码推翻时，在文首加「修订指针」指向最新结论，正文保持原样。
2. **新文档先定归属**：规范进 `engineering/` 并在其 README 登记；设计契约进 `design/`；
   一次性过程记录按 `yyyy-mm-dd-<主题>.md` 命名，进对应的快照目录。
3. **不要把计划当规范**。现行规则直接写进 `engineering/`，变更背景与取舍记在 PR 描述或提交信息中（早期历史归档、审计快照与 Agent Notes 保存在 git 历史中）。
