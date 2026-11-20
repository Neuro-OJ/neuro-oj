# Agent Note: 双容器评测耗时改为统计 Solution 忙碌时长

Status: implemented

## Problem

双容器（AI 题）评测结果解析固定返回
`time_ms: None`，编排器随后用`started.elapsed()` 兜底。`started`
在创建两个容器之前取值，读取则在`dual.destroy()`
之后，因此展示给做题人的耗时包含容器创建与销毁、文件注入、Python
启动、`evaluate.py` 自身计算以及
LLM调用。即使选手代码只跑几毫秒，界面上也显示数秒，并随评测机负载波动；UI
又以与OI 测试点耗时相同的样式展示，含义被混淆。同屏的 `memory_kb` 是
Solution容器峰值，两者口径也不一致。

## Decision

- `InFlightTracker` 增加 Solution 忙碌时长统计：取所有 evaluator →
  solution调用（`WaitingSide::Evaluator`）in-flight
  区间的**并集**，并发调用不重复计时；响应命中或超时摘除时关闭区间。`resolve_response`
  增加 `now` 参数，与其他方法保持「时间由调用方注入」的纯逻辑风格。
- 从未发生调用（启动失败、评测脚本未调用选手代码）时返回 `None`，不展示耗时。
- tracker 改由 `evaluate_dual_with_cpu_limit` 创建并以 `&mut`
  传入`run_dual_loop`，循环结束后读取忙碌时长回填
  `time_ms`；整段墙钟时间只写入`wall_time_ms` 日志字段供排查。
- 同步 `noj-judge/AGENTS.md`、文档站「判定模型」与 `JudgeResult.time_ms` 注释。

## Alternatives considered

- **新增 `wall_time_ms` 结果字段并在 UI 同时展示**：需要数据库迁移、core
  归一与UI 改动，收益仅限排查；墙钟时间写日志即可满足。
- **累加每次调用时长（不取并集）**：并发调用会重复计时，超出真实占用。
- **把总时限中的 LLM 延迟一并扣除**：需要网关回传每个
  eval_token的累计延迟并改动判定逻辑，范围更大，另行处理。

## Consequences

- AI 题提交展示的耗时变小且稳定，只反映选手代码处理调用的时间；solution
  在调用中反向等待 capability 的时间仍计入（属于该次调用占用）。
- 评测脚本两次调用之间的自身耗时（如调用
  LLM）不计入耗时，但仍计入总时限`time_limit_ms`；总超时的判定口径不变。
- prediction 提交没有 Solution 容器，仍沿用墙钟兜底，本次未改。
- 历史提交的 `time_ms` 不回填，新旧口径在历史记录中并存。
