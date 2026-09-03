# Agent Note: 法庭推理 Agent 题支持包模板（P2）

Status: implemented

## Problem

NOJ 需要支持更多 AI 类题目评测。针对“侦探类 Agent 题目（暴风雪山庄）”采用
OI 赛制设计，并确定以纯模拟/结构化接口为核心。P2 需要在真实双容器评测（P3）之前，
沉淀一套可离线运行的法庭推理题支持包：包含剧本类型、审判状态机、示例剧本、
参考 Agent 与 LLM-as-judge 适配层，以便验证玩法与可判性。

## Decision

- 整个支持包放在独立题目仓库 `noj-problems/trial-snowy-manor/`（P2 时先建于
  主仓库顶层 `problems/trial-snowy-manor/`，2026-09-05 迁移至独立仓库），而非原
  计划中的 `noj-judge/sdk/templates/trial-agent/`，避免把题目包混入 judge 模块
  SDK。
- 使用纯 Python + stdlib `unittest`，不引入第三方依赖；模块不依赖 NOJ SDK，
  可离线单测。
- `trial_types.py` 定义 `Scenario` 抽象基类及
  `Option/Highlight/Round/RoundAnswer` frozen dataclass。
- `scenario_runner.py` 实现 `TrialRunner` 状态机：维护轮次、证据查询次数、
  反驳错误次数、LLM 调用/ billed token 预算，并暴露与 capabilities 同语义的
  普通方法（`get_trial_state/get_evidence/submit_rebuttal/final_verdict/llm_called`）。
- 评分规则按 spec：正确反驳每轮 100 分、主谋 200 分、关键证据引用 200 分、
  理由 50 分、效率 50 分，总分 1000；失败直接 0 分。
- `scenarios/manor_001.py` 提供原创 3 轮 P0 示例剧本（不使用原作 IP）。
- `evaluate_offline.py` 提供 `run_offline_evaluation`，直接驱动用户提供的
  `solve_agent(ctx, api)`；`reference_agent/main.py` 提供参考 Agent。
- `llm_judge.py` 提供 `build_judge_messages` 与 `parse_judge_response`，
  用于 LLM-as-judge 给最终理由打 0–50 分。
- README 说明目录结构、测试命令与接 NOJ 双容器的方式。

## Alternatives considered

- 继续放在 `noj-judge/sdk/templates/trial-agent/`：与 judge 模块耦合更紧，
  但题目包与评测 SDK 生命周期不同，且原目录在仓库中尚不存在，需要额外迁移成本。
- 先实现完整双容器协议再验证玩法：成本高、调试难，无法在 P2 快速验证规则与
  可判性，故先做离线入口，P3 再接 evaluator SDK。
- 直接调用真实 LLM 验证理由评分：P2 目标是规则与状态机，先通过注入 `judge_fn`
  和 stub 保证离线可复现，真实 LLM 留到 P3。

## Consequences

- 现在可以用 `PYTHONPATH=. python3 -m unittest discover -s tests -v`
  在 `noj-problems/trial-snowy-manor/` 下跑通全部测试（迁移后当前为 19 个）。
- 参考 Agent 在示例剧本上可离线得分 ≥750，穷举/超限用例会被状态机判 0。
- 同一目录是 P3 SDK E2E 集成的基础：届时把 `evaluate_offline.py` 的 `Api`
  替换为 evaluator capabilities，`reference_agent/main.py` 作为用户 `main.py`
  模板。
- 当前 LLM 调用次数/ token 预算仍通过 `TrialRunner` 参数传递，真实评测时需由
  外部环境或 eval_token 限制接入；`NOJ_SUBMISSION_ID` 等环境变量注入留待 P3。
