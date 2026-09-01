# Agent Note: 完成移除 Accepted 状态残留

Status: implemented

## Problem

#353（类 Kaggle artifact 提交评测）已决策全局移除 AC/WA 状态，提交状态只保留
`pending / judging / finished / error`，分数是唯一结果。但该变更只落地了 judge
映射、`noj-core/CLAUDE.md`、`noj-judge/AGENTS.md` 和部分服务层，导致以下残留：

- `noj-docs` 仍把 `Accepted` 当作最终结果状态；
- `noj-judge/CLAUDE.md` 的 JudgeResult 示例仍输出 `status: "Accepted"`；
- evaluator SDK `result.py` 仍输出顶层 `status`；
- 样例/内联 `evaluate.py` 仍输出顶层 `status`；
- `rankings.ts` 与 `user_rankings` 物化视图仍过滤 `er.status = 'Accepted'`，
  在新协议下永远匹配不到，导致榜单/通过数/通过率失效；
- UI 最终结果状态映射仍保留 AC/WA 文案；
- 大量测试 fixture 仍使用 `Accepted` 作为最终结果状态。

## Decision

按以下口径完成全仓清理：

- 最终结果状态只保留 `finished`（已评测 + 分数）与 `error`（出错）。
- `details.cases` 中的用例级 `Accepted / WrongAnswer / RuntimeError / TimeLimitExceeded`
  保留，作为参考信息，不是提交最终判定。
- `rankings.ts` 与 `user_rankings` 物化视图改用
  `er.status = 'finished' AND er.score > 0` 作为“通过”判定。
- evaluator SDK 结果 JSON 不再输出 `status`；`runtime_error()` / `system_error()`
  改为直接抛异常，由 judge 统一映射为 `error`。
- 不重命名 `accepted` / `requires_accepted` / `first_accepted` 等 API/DB/事件标识，
  避免 breaking API 变更；仅清理状态语义与文档措辞。

## Alternatives considered

- 保留 `Accepted` 作为兼容别名：否决。与 #353 的“全局移除 AC/WA 状态”决策冲突，
  且会让新协议继续产生认知漂移。
- 只修 `rankings.ts` 不清理文档/SDK/UI：否决。残留会持续误导出题人与做题人，
  且 SDK 继续输出 `status` 会让新协议无法真正收敛。
- 同步重命名 `accepted` 系列 API/字段：暂缓。属于独立 breaking 重构，需要
  API 兼容层与迁移，不应混入本次状态清理。

## Consequences

- `user_rankings` 物化视图已通过新增迁移重建（`0059_remove_accepted_status.sql`），
  存量部署执行迁移后榜单恢复正确。
- evaluator SDK 的 `runtime_error()` / `system_error()` 行为已变化：不再写入结果
  JSON，而是抛异常；依赖旧行为的评测脚本已改为直接 `raise` 或非零退出。
- 前端最终结果状态只展示 `finished` / `error` + 分数；用例级状态仍可展示。
- 测试 fixture 已统一改为 `finished` / `error`；保留少量 legacy 输入测试用于验证
  judge 对旧 `status` 的兼容映射。
