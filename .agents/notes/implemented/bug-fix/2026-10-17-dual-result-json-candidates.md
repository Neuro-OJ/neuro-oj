# Agent Note: dual 路径的 `---RESULT---` payload 改为多行候选

Status: implemented

## Problem

dual（函数调用型评测）路径解析 `---RESULT---` 时，只把标记之后的**第一个**非空行
当作 JSON payload（`handle_eval_chunk` 的 `EvaluatorLine::Unknown` 分支与
`drain_eval_tail` 各有一份同构逻辑）。evaluator 若在标记与真正的 JSON 之间打印了
任意非空行——库告警、初始化日志、进度输出——该行会被选中，
`serde_json::from_str` 失败后经 `?` 冒泡，整次评测落成 `platform_error`，合法成绩
被丢弃（Issue #654）。

同一类缺陷在 prediction 路径已修复：`PredictionOutput` 保留标记后的多个候选，
解析时按顺序尝试。dual 路径当时未同步，两侧语义出现分叉。

此外，编排循环的提前退出条件同样是「已捕获任意非空行」，即使候选被保留，
噪声行到达时循环也会先收尾，后续的真 JSON 根本不会被读入。

## Decision

- 新增 `noj-judge/src/dual/payload.rs`，以 `ResultPayload` 取代裸
  `Option<String>` 作为 payload 状态：`seen_marker` 标志 + 标记后的候选行列表。
- 标记后的每个非空行都进入候选（不再只取首行）。候选数量上限
  `MAX_RESULT_CANDIDATES = 8`；单条候选经既有 `append_capped` 截断，沿用
  `MAX_OUTPUT_BYTES`（1 MiB）硬上限，超长行不会无界累积。
- 候选只来自标记之后。标记之前的诊断 JSON 若被当成结果，会因缺 `score` 被判为
  非法评分（platform_error），反而丢掉后面的合法成绩。
- `ResultPayload::has_usable()`（可解析为 JSON 且含 `score`）取代「存在任意非空行」
  作为阶段 1 / 阶段 2 的提前退出条件，与 prediction 路径的
  `has_usable_payload()` 同口径。
- `payload::resolve_payload()` 按出现顺序遍历候选，返回第一个「合法 JSON 且含
  `score`」的行。合法 JSON 但缺 `score` 的候选被跳过并继续尝试后续候选；只有全部
  候选都不可用时才报错，错误信息带已尝试的候选数量、最后一个解析错误与首个候选的
  截断片段（120 字符）。
- 候选里没有任何带 `score` 的 JSON、但存在合法 JSON 时，仍交给
  `build_judge_result`，沿用 defect #29 的非法评分口径（platform_error，不覆盖
  已有正式成绩）。
- 后出现的 `---RESULT---` 标记重置候选，保持「以最后一段标记后的行为准」的既有
  语义。

## Alternatives considered

- 只在解析失败时把错误降级为 `system_error`：噪声行仍占位，真结果依旧读不到，
  只是把失败文案换掉，不解决丢分。
- 保留单行 payload，靠「向后多看几行」的启发式（如跳过以 `warning` 开头的行）：
  依赖噪声的具体文本，任何未预料的输出格式都会再次失效。
- 把标记后的全部行拼成一段再解析：JSON 只占一行，拼接会引入非法 JSON；且需要
  无界缓冲，违背 1 MiB 输出上限的防护意图。
- 复用 prediction 的 `PredictionOutput`：两者状态机不同（dual 还要转发协议帧、
  跟踪调用级超时），强行共用会把 prediction 的 stdout 全文累积语义带进 dual 编排
  循环。

## Consequences

- 「标记 → 噪声 → 真 JSON」不再丢分；与 prediction 路径的行为一致。
- 标记之后若先出现一行合法 JSON 但没有 `score`（调试输出），dual 不再立即以
  非法评分收尾，而是继续读到 EOF / 总超时，再按全部候选判定。这是有意的取舍：
  多等一段时间的代价远低于丢掉合法成绩。
- 候选最多 8 条、单条最多 1 MiB，最坏情况多占 8 MiB 内存，仍受
  `MAX_OUTPUT_BYTES` 的单条上限约束。
- `ResultPayload` 通过 `noj_judge::dual::ResultPayload` 暴露，供
  `tests/` 下的 E2E harness（`mod_test_helpers::handle_eval_chunk_probe`）驱动；
  `primary()` 仅测试断言使用。
- 新增逻辑放在 `dual/payload.rs` 而不是 `dual/mod.rs`，避免触发单文件规模棘轮
  （`scripts/check-file-size.ts`，阈值 1200 行）。
