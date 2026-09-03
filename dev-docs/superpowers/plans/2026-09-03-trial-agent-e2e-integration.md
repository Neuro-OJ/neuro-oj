# 法庭推理题 NOJ 端到端集成计划

> **给 agentic worker:** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实施本计划。步骤使用复选框（`- [ ]`）语法跟踪。

**Goal:** 把 P2 的离线法庭推理模板接入 NOJ 真实双容器评测：evaluator 注册 `get_evidence/get_trial_state/submit_rebuttal/final_verdict/llm_complete` capabilities，solution 参考 Agent 通过 `call_capability` 完成审判；配置题目包与运行参数，跑通一次真实评测并验证预算/超限。

**Architecture:** 复用现有 `noj_evaluator_sdk.SolutionRunner` + `register_capability` + `noj_solution_sdk.call_capability`。evaluator 的 `evaluate.py` 持有 `TrialRunner` 状态机，把方法绑定到 capability handler；Agent 侧 `main.py` 定义 `solve_agent(initial_context)`，内部用 `call_capability` 交互。LLM 通过 evaluator 侧 `llm.complete`（普通 capability）走 gateway，因此 solution 容器仍无网、无 `NOJ_LLM_*`。

**Tech Stack:** Python 3.12（双容器 SDK）、Rust judge（已有 capability 转发）、Deno core（eval_token/LLM 配置）、Docker Compose。

**Spec:** `dev-docs/superpowers/specs/2026-09-03-snowy-manor-trial-agent-design.md`

## 全局约束

- 不新增 NOJ 核心评测协议；复用 `call_capability` 普通 capability 转发；
- 真实 LLM 调用只在 evaluator 侧发生；
- 题目必须 P 型 + `llm.provider_id/model` + evaluator 联网；
- 竞赛禁用 BYOK；`llm_complete` 不是 `request_user_llm_completion`；
- `eval_token.max_calls/max_tokens` 通过部署环境 `NOJ_LLM_MAX_CALLS/NOJ_LLM_MAX_TOKENS` 设置（P3 不扩展 core 题目级字段；若需题目级可另立计划）；
- 提交信息/Agent Note/GPG 同 AGENTS.md。

---

### Task 1: 编写真实 evaluator 集成入口 sdk_evaluate.py

**Files:**
- Create: `noj-judge/sdk/templates/trial-agent/sdk_evaluate.py`

**Interfaces:**
- Consumes:
  - `scenario_runner.TrialRunner`
  - `scenarios.list_scenarios()` / `scenarios.manor_001.Manor001`
  - `noj_evaluator_sdk.SolutionRunner`
  - `noj_evaluator_sdk.register_capability`
- Produces: 运行时可作为支持包 `evaluate.py` 使用的评测入口（若部署时把该文件改名为 `evaluate.py`）

- [ ] **Step 1: 写文件**

Create `sdk_evaluate.py`:

```python
"""NOJ 双容器评测入口：把 TrialRunner 暴露为 capabilities。

部署时将此文件作为支持包根目录 evaluate.py（或由 evaluate.py import）。
"""
from __future__ import annotations

import json
import os
import random
import sys
from typing import Any

# 开发/测试时允许直接从模板目录运行；NOJ 支持包内通常同目录存在
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from noj_evaluator_sdk import SolutionRunner, register_capability, result
from scenario_runner import TrialRunner
from scenarios import list_scenarios
from trial_types import Scenario


def _pick_scenario(seed: str) -> Scenario:
    classes = list_scenarios()
    if not classes:
        raise RuntimeError("scenarios 目录未发现任何剧本")
    return random.Random(seed).choice(classes)()


def _load_runner() -> TrialRunner:
    # 种子 = submission_id + rejudge_seq（spec §5.1）。SDK 环境暂未直接暴露两者，
    # 先读 NOJ_SUBMISSION_ID / NOJ_REJUDGE_SEQ；缺省回退 fixed default（P0 限制）。
    seed = f"{os.environ.get('NOJ_SUBMISSION_ID', 'default')}:{os.environ.get('NOJ_REJUDGE_SEQ', '0')}"
    scenario = _pick_scenario(seed)
    max_evidence = max(1, int(len(scenario.evidence) * 2 / 3))
    return TrialRunner(
        scenario,
        max_evidence_queries=max_evidence,
        max_wrong_rebuttals=int(os.environ.get("NOJ_TRIAL_MAX_WRONG", "3")),
        max_llm_calls=int(os.environ.get("NOJ_TRIAL_MAX_LLM", "30")),
        max_llm_tokens=int(os.environ.get("NOJ_TRIAL_MAX_TOKENS", "20000")),
        seed=seed,
    )


def main() -> None:
    runner = _load_runner()
    solution = SolutionRunner()

    # capability: 获取证据详情
    def cap_get_evidence(evidence_id: str) -> dict[str, Any] | None:
        return runner.get_evidence(evidence_id)

    # capability: 获取当前审判状态
    def cap_get_trial_state() -> dict[str, Any]:
        return runner.get_trial_state()

    # capability: 提交反驳
    def cap_submit_rebuttal(highlight_id: str, option_id: str) -> dict[str, Any]:
        return runner.submit_rebuttal(highlight_id, option_id)

    # capability: 最终裁决
    def cap_final_verdict(
        person_id: str,
        evidence_ids: list[str],
        reasoning: str,
    ) -> dict[str, Any]:
        return runner.final_verdict(person_id, evidence_ids, reasoning)

    # capability: LLM 调用（evaluator 侧出站，不走 solution 网络）
    def cap_llm_complete(messages: list[dict[str, str]], **params: Any) -> dict[str, Any]:
        from noj_evaluator_sdk import llm
        # Agent 本地次数预检：达到 30 次不再转发 gateway，保护 judge 保留额度
        if runner.used_llm_calls >= runner._max_llm_calls:
            runner._is_failed = True
            raise RuntimeError("out_of_usage")
        try:
            resp = llm.complete(messages=messages, **params)
        except Exception as exc:
            raise exc
        # 用上游实际 billed token 累计到 Agent 本地额度（20k）
        usage = resp.get("usage") or {}
        cached = (usage.get("prompt_tokens_details") or {}).get("cached_tokens", 0)
        billed = max(0, usage.get("prompt_tokens", 0) - cached) + usage.get(
            "completion_tokens", 0,
        )
        runner.llm_called(billed_tokens=billed)
        if runner.is_failed:
            raise RuntimeError("out_of_usage")
        return resp

    register_capability("get_evidence", cap_get_evidence)
    register_capability("get_trial_state", cap_get_trial_state)
    register_capability("submit_rebuttal", cap_submit_rebuttal)
    register_capability("final_verdict", cap_final_verdict)
    # llm_complete 可能等待上游较久，capability 超时按 spec §6.1 给 120s
    register_capability("llm_complete", cap_llm_complete, timeout_ms=120_000)

    initial_context = runner.initial_context()
    # 约定选手入口 solve_agent(initial_context)
    solution.call("solve_agent", initial_context, timeout_ms=os.environ.get(
        "NOJ_TRIAL_SOLVE_TIMEOUT_MS", "240000",
    ))

    # LLM-as-judge 理由评分：同一评测预算内执行；失败给 0
    reason_score = 0
    if runner._final is not None and not runner.is_failed:
        from llm_judge import build_judge_messages, parse_judge_response
        from noj_evaluator_sdk import llm
        try:
            resp = llm.complete(
                messages=build_judge_messages(runner._scenario, runner._final),
                temperature=0,
            )
            content = resp["choices"][0]["message"]["content"]
            reason_score = parse_judge_response(content)
        except Exception:
            reason_score = 0

    breakdown = runner.scoring(reason_score=reason_score)
    # result.accept 内部 ×100：spec 内部分数 0..1000，传给 SDK 需换算成 0..100
    sdk_score = breakdown["score"] / 10
    details = {
        "scenario_id": runner._scenario.id,
        "cases": [{
            "case_id": runner._scenario.id,
            "status": "Accepted" if not runner.is_failed and runner._final is not None else "WrongAnswer",
            "score": sdk_score,
            "reason_score": reason_score,
        }],
    }
    if runner.is_failed:
        result.wrong_answer(score=0, details=details)
    else:
        result.accept(score=sdk_score, details=details)


if __name__ == "__main__":
    main()
```

> 说明：该文件是集成骨架，真实部署时建议把 `scenario_runner.py`、`trial_types.py`、`scenarios/`、`llm_judge.py` 一并放入支持包。`NOJ_SUBMISSION_ID` 环境变量当前 judge 不注入时，可先固定 seed；P3 后续如需要可在 noj-judge 注入。

- [ ] **Step 2: 运行 Python 语法检查**

Run:
```bash
cd /home/xyber-nova/Github/neuro-oj/noj-judge/sdk/templates/trial-agent && \
PYTHONPATH=. python3 -m py_compile sdk_evaluate.py
```
Expected: exit 0（生成 `__pycache__` 可忽略）

- [ ] **Step 3: 提交**

Commit: `feat(judge): 法庭推理模板真实 SDK 评测入口骨架`

---

### Task 2: 编写参考 Agent（solution 侧）

**Files:**
- Create: `noj-judge/sdk/templates/trial-agent/reference_agent/main_sdk.py`

**Interfaces:**
- Consumes: `noj_solution_sdk.call_capability`
- Produces: `solve_agent(initial_context)`，内部通过 `call_capability` 交互

- [ ] **Step 1: 写文件**

Create `reference_agent/main_sdk.py`:

```python
"""参考 Agent（Solution 侧，NOJ 真实运行版）。

用户在 NOJ 提交时将此文件内容作为 main.py。
"""
from __future__ import annotations

from typing import Any

from noj_solution_sdk import call_capability


def _get_evidence(evidence_id: str) -> Any:
    return call_capability("get_evidence", evidence_id)


def _state() -> dict:
    return call_capability("get_trial_state")


def _rebut(highlight_id: str, option_id: str) -> dict:
    return call_capability("submit_rebuttal", highlight_id, option_id)


def _verdict(person_id: str, evidence_ids: list[str], reasoning: str) -> dict:
    return call_capability("final_verdict", person_id, evidence_ids, reasoning)


def _llm(messages: list[dict[str, str]], **params: Any) -> dict:
    return call_capability("llm_complete", messages, **params)


def solve_agent(ctx: dict[str, Any]) -> None:
    # 示例 Agent：直接查关键证据并推进（正式题目应由 LLM 推理）。
    # 注意：此参考实现不调用 _llm，避免示例评测消耗 token。
    for eid in ("ev2", "ev3", "ev4"):
        _get_evidence(eid)

    answers = [(1, "s2", "o4"), (2, "s3", "o6"), (3, "s4", "o9")]
    for _round, hid, oid in answers:
        res = _rebut(hid, oid)
        if res.get("failed") or res.get("finished"):
            break

    _verdict("B", ["ev2", "ev3", "ev4"], "B 威胁 A，是主谋")
```

- [ ] **Step 2: 运行语法检查**

Run:
```bash
cd /home/xyber-nova/Github/neuro-oj/noj-judge/sdk/templates/trial-agent && \
PYTHONPATH=. python3 -m py_compile reference_agent/main_sdk.py
```
Expected: exit 0

- [ ] **Step 3: 提交**

Commit: `feat(judge): 法庭推理参考 Agent（Solution SDK 版）`

---

### Task 3: 生成统一题目包脚本

**Files:**
- Create: `noj-judge/sdk/templates/trial-agent/build_bundle.sh`
- Create: `noj-judge/sdk/templates/trial-agent/problem.json`
- Create: `noj-judge/sdk/templates/trial-agent/statement.md`

**Interfaces:**
- Produces: `dist/trial-agent-bundle.zip`，zip 根含 `problem.json`、`statement.md`、`evaluate.py`、`scenario_runner.py`、`trial_types.py`、`llm_judge.py`、`scenarios/`

- [ ] **Step 1: 写 problem.json**

Create `problem.json`:

```json
{
  "format_version": 1,
  "type": "P",
  "title": "[法庭推理] 雪夜庄园的魔女审判（示例）",
  "difficulty": "medium",
  "llm": {
    "provider_id": "REPLACE_WITH_PROVIDER_UUID",
    "model": "REPLACE_WITH_MODEL"
  },
  "runtime_config": {
    "evaluator": {
      "image": "noj-evaluator-python",
      "network": { "enabled": true },
      "time_limit_ms": 300000,
      "memory_limit_mb": 512
    },
    "solution": {
      "image": "noj-solution-python",
      "call_timeout_ms": 240000,
      "memory_limit_mb": 512
    }
  },
  "template": "template.py"
}
```

> `provider_id`/`model` 由出题人在上传前替换。`time_limit_ms=300000` 对应 5 分钟 wall-clock；`call_timeout_ms=240000` 允许 `solve_agent` 在 4 分钟内自主返回。

- [ ] **Step 2: 写 statement.md**

Create `statement.md`:

````markdown
# 雪夜庄园的魔女审判（示例）

你被困在暴风雪山庄。你需要实现 `solve_agent(initial_context)`，
通过平台提供的 capability 查询证据、选择唯一正确反驳，并在最后给出主谋与证据链。

## 规则

- 证据以清单形式出现在 `initial_context`；完整内容用 `get_evidence` 查询。
- 每轮用 `submit_rebuttal(highlight_id, option_id)` 选择反驳；选错可重试但有限。
- 全部轮次后调用 `final_verdict(person_id, evidence_ids, reasoning)`。
- 预算：LLM 调用/证据查询/反驳错误都有上限，超限得 0 分。

## 提交

在 `main.py` 实现：

```python
from noj_solution_sdk import call_capability

def solve_agent(initial_context):
    # 你的 Agent 主循环
    return None
```
````

- [ ] **Step 3: 写 build_bundle.sh**

Create `build_bundle.sh`:

```bash
#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")"
rm -rf dist && mkdir -p dist

# 复制评测相关文件到暂存目录
tmp="dist/bundle"
rm -rf "$tmp" && mkdir -p "$tmp"
cp problem.json statement.md sdk_evaluate.py "$tmp/evaluate.py"
cp scenario_runner.py trial_types.py llm_judge.py "$tmp/"
cp -r scenarios "$tmp/"

# 用户模板
cat > "$tmp/template.py" <<'PY'
from noj_solution_sdk import call_capability

def solve_agent(initial_context):
    # 请选手在此实现 Agent 主循环
    return None
PY

# 打包
(cd "$tmp" && zip -qr ../trial-agent-bundle.zip .)
rm -rf "$tmp"
echo "生成 dist/trial-agent-bundle.zip"
```

> 注：该脚本使用 `zip`；确保系统有 zip。打包后上传到管理后台“统一题目包”。

- [ ] **Step 4: 运行脚本生成包**

Run:
```bash
cd /home/xyber-nova/Github/neuro-oj/noj-judge/sdk/templates/trial-agent && \
chmod +x build_bundle.sh && ./build_bundle.sh
```
Expected: 生成 `dist/trial-agent-bundle.zip`，`unzip -l` 能看到 `evaluate.py`、`scenarios/manor_001.py` 等。

- [ ] **Step 5: 提交**

Commit: `feat(judge): 法庭推理题统一题目包构建脚本`

---

### Task 4: 部署/运行参数与端到端手工验证文档

**Files:**
- Create: `noj-judge/sdk/templates/trial-agent/README.e2e.md`

**Interfaces:**
- Produces: 供运营/开发者执行真实评测的 step-by-step 说明

- [ ] **Step 1: 写 E2E 文档**

Create `README.e2e.md`:

```markdown
# 端到端验证

前置：P1（billed token/out_of_usage）已合入并部署 llm-gateway；P2 模板已生成。

## 环境变量

在 noj-core / llm-gateway / judge 所在部署环境中设置：

- `NOJ_LLM_MAX_CALLS=31`（Agent 30 + judge 1）
- `NOJ_LLM_MAX_TOKENS=22000`（Agent 20k + judge 2k）
- `JUDGE_ALLOW_EVALUATOR_NETWORK=true`
- `JUDGE_EVALUATOR_NETWORK=noj-net`
- `NOJ_TRIAL_MAX_LLM=30`（Agent 本地 LLM 轮次上限）
- `NOJ_TRIAL_MAX_TOKENS=20000`（Agent 本地 billed token 上限）
- `NOJ_TRIAL_MAX_WRONG=3`（反驳错误上限）
- `NOJ_TRIAL_SOLVE_TIMEOUT_MS=240000`
- `NOJ_SUBMISSION_ID` / `NOJ_REJUDGE_SEQ`（可选；当前 judge 不注入时，sdk_evaluate 回退固定 default）

> `NOJ_TRIAL_*` / `NOJ_SUBMISSION_ID` / `NOJ_REJUDGE_SEQ` 目前 judge 不会自动注入 evaluator 容器；若未注入，`sdk_evaluate.py` 使用代码内默认值（30/20000/3/240000/default）。若需要这些环境变量真正生效，需在后续 noj-judge 的 evaluator 环境注入任务中增加白名单转发。

## 步骤

1. 在管理后台创建 P 型题目，开启 Evaluator 联网，配置 LLM Provider。
2. 上传 `dist/trial-agent-bundle.zip`。
3. 以参考 Agent 内容提交 `main.py`。
4. 等待评测，确认状态 finished 且分数 > 0。
5. 故意提交一个在 `submit_rebuttal` 中穷举所有选项的 Agent，确认因反驳错误超限得 0。
6. 查看 `llm_usage` 表，确认 billed_tokens 列有值，且 judge 调用记录存在。

## 常见失败

- `error`：确认 P 型、evaluator 联网、provider 已启用、镜像白名单存在。
- `CapabilityNotFoundError`：确认 evaluate.py 已注册 capability 且支持包已更新。
- 卡在 Pending：检查 judge worker/Redis。
- LLM 调用报错：检查 `NOJ_LLM_*` 是否注入到 evaluator，而不是 solution。
```

- [ ] **Step 2: 提交**

Commit: `docs(judge): 法庭推理端到端验证说明`

---

### Task 5: 真实 Docker 冒烟（可选，需 NOJ_RUN_E2E=1 与 Docker）

**Files:**
- Modify: `noj-judge/tests/e2e_trial_agent.rs`（新增，若后续投入 CI 前完善）
- 说明：该任务不是 CI 门禁；首次验证可先按 Task 4 手工执行。若要在仓库内固化，再按现有 `e2e_network_capability.rs` 模式补充 Rust E2E。

- [ ] **Step 1: 评估是否补 Rust E2E**

若团队决定纳入自动 E2E，则新建 `tests/e2e_trial_agent.rs`，复用 `common::ensure_test_image` 与 `dual::evaluate_dual` 的真实容器流程，将模板文件作为支持包 zip 注入 evaluator，提交参考 Agent。此任务代码量较大，建议独立 PR，不在本计划强制完成。

- [ ] **Step 2: 提交（仅当 Step 1 有产物）**

Commit: `test(judge): 法庭推理题双容器 E2E`

---

## 已知未覆盖/后续项

- **core 题目级 eval_token 限额**：spec §6.1 提到 noj-core“按题目/评测配置”写入 `max_calls/max_tokens`。本计划 P3 采用部署级 env（`NOJ_LLM_MAX_CALLS=31`/`NOJ_LLM_MAX_TOKENS=22000`）实现，未扩展 `problem.llm` 增加题目级字段；如需题目级覆盖，需另立 core 计划。
- **judge 注入 submission_id/rejudge_seq**：当前 judge 不注入 `NOJ_SUBMISSION_ID`/`NOJ_REJUDGE_SEQ`，P0 使用固定 default seed；如需严格按提交可复现随机，需在 judge 环境注入这两个变量（或从 JudgeTask 传递）。
- **Rust 自动 E2E**：P3 Task 5 标记为可选；spec §5.3 的 capability+llm 死锁验证建议在正式 CI 前补独立 Rust E2E。

## 验证清单

- [ ] `sdk_evaluate.py`、`main_sdk.py`、`build_bundle.sh` 语法/生成通过；
- [ ] 上传题目包后，参考 Agent 评测 finished 且分数 > 0；
- [ ] 穷举 Agent 评测为 0 分；
- [ ] `llm_usage` 记录含 `billed_*` 列；
- [ ] Solution 容器无 `NOJ_LLM_*`，LLM 只由 evaluator 调用。
