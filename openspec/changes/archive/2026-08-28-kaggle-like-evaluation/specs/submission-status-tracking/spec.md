## ADDED Requirements

### Requirement: 评测结果以分数表达

系统 SHALL 不再使用 `Accepted` / `WrongAnswer` 作为评测结果状态。提交状态只保留 `pending / judging / finished / error`，分数是唯一结果。

`evaluationResults.status` SHALL 只使用 `finished` 或 `error`；evaluate.py 结果 JSON SHALL **移除 `status` 字段**，只输出 `score`（×100 整数）与 `details`，judge 端统一映射为 `finished`，异常/超时映射为 `error`。AC/WA 仅作为 `details` 中的参考信息。

前端状态展示 SHALL 显示“已评测 + 分数”，不使用“满分”字样。

#### Scenario: 评测完成返回分数

- **WHEN** 一次评测完成且 evaluate.py 输出 `score: 8000`
- **THEN** 提交状态为 `finished`，`result.score` 为 8000，`result.status` 为 `finished`

#### Scenario: 评测失败返回 error

- **WHEN** 评测脚本执行失败
- **THEN** 提交状态为 `error`，不展示分数

#### Scenario: 前端展示已评测分数

- **WHEN** 用户查看已完成提交
- **THEN** 页面显示“已评测”和分数，不显示 AC/WA 字样
