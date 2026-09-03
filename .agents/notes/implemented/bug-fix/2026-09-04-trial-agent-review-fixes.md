# Agent Note: 法庭推理模板代码评审修复

Status: implemented

## Problem

代码评审发现两组问题：

1. `template.py` 与 `reference_agent/main_sdk.py` 中的 `llm_complete` 使用
   `call_capability("llm_complete", messages, **params)`，但
   `noj_solution_sdk.call_capability` 只接受位置参数，不接受 `**kwargs`；
   一旦选手传入 `temperature` 等参数，会在 Solution 侧直接 TypeError。
   同时 `sdk_evaluate.py` 的 `cap_llm_complete(messages, **params)` 也只能
   接收位置参数，无法从 RPC 收到 kwargs。
2. `manor_001.py` 扩展后存在两处自洽性问题：
   - `ev7` 写“22:47–23:05 有 4 分钟空白”，区间长度与“4 分钟”矛盾；
   - 第 4 轮 D 的“22:45 开车出门”与标准答案“22:50 仍在车库”在证据
     `ev8` 中没有支撑，且原 `ev8` 明确写 D 22:45 外出，与答案矛盾。

## Decision

- `llm_complete` 的额外参数统一改为单个 JSON dict 作为第二位置参数：
  solution 侧 `def llm_complete(messages, params=None)`，
  evaluator 侧 `def cap_llm_complete(messages, params=None)`。
- `ev7` 时间区间改为“22:47–22:51”。
- `ev8` 改为“车库门 22:45 有开启记录，但 22:50 监控仍在车库，车辆实际
  23:05 才驶出”，使第 4 轮答案 `o21` 可由证据推出。
- 第 1 轮发言补上 `22:40` 时间，让 `o4`（艾玛说 A 当时还在餐厅）与 `ev5`
  对齐。
- 同步更新 `README.md` 与设计 spec 中的 `llm_complete` 参数说明。

## Alternatives considered

- 继续保留 `**params` 并在 solution SDK 侧扩展 kwargs：需要修改底层 RPC
  协议，影响所有 capability，成本高且超出本次模板修复范围。
- 只修改模板不修改 `sdk_evaluate.py`：会造成 solution 与 evaluator 参数
  契约不一致，模板仍然无法工作。
- 不改剧本证据直接保留矛盾：会破坏“唯一可解”和“可从证据推出答案”的题目质量。

## Consequences

选手模板现在与真实 RPC 协议一致，传入 LLM 参数时不会在 solution 侧崩溃；
剧本证据时间线可支撑第 1、4 轮标准答案。全量 15 个离线测试通过，
`py_compile` 与 `build_bundle.sh` 均通过，生成包内 `template.py`/`evaluate.py`
已更新。
