# Agent Note: 法庭推理题 NOJ 端到端集成（P3）

Status: implemented

## Problem

P2 的法庭推理支持包只能在 `evaluate_offline.py` 里通过本地函数直接驱动
`solve_agent`，尚未接入 NOJ 真实双容器评测。需要让 evaluator 通过
`noj_evaluator_sdk` 注册 capabilities，让 solution 里的参考 Agent 通过
`noj_solution_sdk.call_capability` 与状态机交互，并生成可上传的统一题目包与
E2E 操作文档。

## Decision

- 在独立题目仓库 `noj-problems/trial-snowy-manor/`（P3 时位于主仓库
  `problems/trial-snowy-manor/`，2026-09-05 迁移至独立仓库）下新增
  `sdk_evaluate.py`：作为真实评测入口，内部持有 `TrialRunner`，注册
  `get_evidence/get_trial_state/submit_rebuttal/final_verdict/llm_complete`
  五个 capability。
- `llm_complete` 由 evaluator 侧调用 `noj_evaluator_sdk.llm.complete` 走
  gateway，solution 容器保持无网、无 `NOJ_LLM_*`；本地 LLM 次数/token 超限时
  以 `RuntimeError("out_of_usage")` 拒绝后续转发。
- 新增 `reference_agent/main_sdk.py`：SDK 版参考 Agent，通过
  `call_capability` 查询证据、反驳、最终裁决；示例实现不调用 LLM，避免评测消耗
  token。
- 新增 `problem.json`、`statement.md`、`build_bundle.sh`：构建统一题目包
  `dist/trial-agent-bundle.zip`，zip 根包含 `problem.json`/`statement.md`/
  `evaluate.py`/`scenario_runner.py`/`trial_types.py`/`llm_judge.py`/
  `scenarios/`/`template.py`。
- 新增 `README.e2e.md`：记录 P 型题、evaluator 联网、LLM provider、环境变量
  （`NOJ_LLM_MAX_CALLS=31`、`NOJ_LLM_MAX_TOKENS=22000` 等）以及手工 E2E 步骤。
- 分数换算沿用 spec：内部分数 0–1000，SDK `result.accept(score)` 内部 ×100，
  故传给 SDK 的分数为 `breakdown["score"] / 10`。

## Alternatives considered

- 把 SDK 集成文件放到 `noj-judge/sdk/templates/trial-agent/`：P2 已确认把整个
  题目包放在独立题目仓库 `noj-problems/trial-snowy-manor/`（当时位于主仓库
  `problems/trial-snowy-manor/`），P3 继续沿用，避免同一题目包跨目录分裂。
- 让 solution 直接访问 LLM：需要给 solution 注入网关地址/token，违反“solution
  无网、无 LLM 环境变量”的安全边界；因此 `llm_complete` 由 evaluator 侧转发。
- 使用题目级 eval_token 限额字段：当前 core/plan 未扩展题目级字段，P3 采用部署
  级 `NOJ_LLM_MAX_CALLS/NOJ_LLM_MAX_TOKENS`，保持 P1 的 gateway 语义不变。

## Consequences

- 可通过 `./build_bundle.sh` 生成统一题目包，并在管理后台上传为 P 型题支持包。
- `sdk_evaluate.py` 与 `reference_agent/main_sdk.py` 已通过 `py_compile`；
  P2 的 14 个离线单测仍全部通过。
- 已知未覆盖：judge 尚未注入 `NOJ_SUBMISSION_ID/NOJ_REJUDGE_SEQ`，P0 使用固定
  `default` seed；`NOJ_TRIAL_*` 环境变量需后续在 judge evaluator 环境注入白名单
  才能真正按提交配置；Rust 自动 E2E 仍为可选后续项。
