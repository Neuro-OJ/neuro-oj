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
| [`audit/`](audit/)                       | 时点审计，按日期建目录                              | 只读快照          |
| [`reviews/`](reviews/)                   | 时点评审与验证记录                                  | 只读快照          |
| [`acceptance/`](acceptance/)             | 时点验收记录（含 PR body 存档）                     | 只读快照          |
| [`unattended/`](unattended/)             | 无人值守改造的过程记录与证据                        | 只读快照          |
| [`postmortem/`](postmortem/)             | 事故复盘                                            | 只读快照          |
| [`archive/`](archive/)                   | 历史存档：`superpowers/`（plans 69、specs 42、reviews、reports） | 归档，勿新增      |

## 约定

1. **只读快照不回溯修改**。被代码推翻时，在文首加「修订指针」指向最新结论，正文保持原样。
2. **新文档先定归属**：规范进 `engineering/` 并在其 README 登记；设计契约进 `design/`；
   一次性过程记录按 `yyyy-mm-dd-<主题>.md` 命名，进对应的快照目录。
3. **不要把计划当规范**。`archive/superpowers/plans/` 是历史存档；已实现的结论写进
   `.agents/notes/implemented/`，现行规则写进 `engineering/`。
4. 决策记录（为什么这么做）在 `.agents/notes/implemented/`，不在这里重复一遍。
