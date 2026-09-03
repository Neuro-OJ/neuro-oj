# 法庭推理 Agent 题支持包模板（P0 概念验证）实施计划

> **给 agentic worker:** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实施本计划。步骤使用复选框（`- [ ]`）语法跟踪。

**Goal:** 在 `noj-judge/sdk/templates/trial-agent/` 下沉淀一套可离线运行的“法庭推理 Agent 题”支持包模板，包含 Scenario Python class、审判状态机、示例剧本、参考 Agent、LLM-as-judge 适配层与单测，验证 spec 的玩法与可判性。

**Architecture:** 模板拆成纯 Python 模块（不依赖 noj SDK 可单测）+ 一个离线评测入口 `evaluate_offline.py`（直接调用用户提供的 `solve_agent` 函数，不走双容器协议）+ 后期集成用的 `evaluate.py` 骨架（依赖 noj_evaluator_sdk，在 P3 接通）。核心是 `Scenario` 类与 `TrialRunner` 状态机：维护当前轮、证据查询计数、反驳错误计数、最终裁决；公开的 capability 语义以普通方法形式暴露，便于后续映射为 `call_capability`。

**Tech Stack:** Python 3.12 + stdlib `unittest`；不引入第三方依赖。

**Spec:** `dev-docs/superpowers/specs/2026-09-03-snowy-manor-trial-agent-design.md`（§4、§5、§6、§7）

## 全局约束

- Python 代码风格：PEP 8；类型标注尽量完整；中文注释；
- 测试命令：`python3 -m unittest discover -s noj-judge/sdk/templates/trial-agent/tests -v`；
- 模板内不调用真实 LLM 网络（P2 用 `judge_fn` 注入/离线 stub）；
- 模板文件须避免路径穿越与任意文件读取（证据按 id 白名单）；
- 提交：`feat(judge): 中文描述`，GPG 签名；本地优先 `jj`；
- 非平凡变更需 Agent Note。

---

### Task 1: 目录骨架与类型定义

**Files:**
- Create: `noj-judge/sdk/templates/trial-agent/trial_types.py`
- Create: `noj-judge/sdk/templates/trial-agent/scenarios/__init__.py`
- Test: `noj-judge/sdk/templates/trial-agent/tests/__init__.py`

**Interfaces:**
- Produces:
  - `@dataclass Option { id: str; text: str }`
  - `@dataclass Highlight { id: str; text: str; options: list[Option] }`
  - `@dataclass Round { index: int; speaker: str; statement: str; highlights: list[Highlight] }`
  - `@dataclass RoundAnswer { round_index: int; highlight_id: str; option_id: str }`
  - `class Scenario`（抽象基类，方法见下）
  - `scenarios/__init__.py` 导出 `SCENARIO_REGISTRY` / `list_scenarios()`

- [ ] **Step 1: 写类型与基类**

Create `trial_types.py`:

```python
"""法庭推理题核心类型定义。"""
from __future__ import annotations

from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from typing import Any


@dataclass(frozen=True)
class Option:
    id: str
    text: str


@dataclass(frozen=True)
class Highlight:
    id: str
    text: str
    options: list[Option]


@dataclass(frozen=True)
class Round:
    index: int
    speaker: str
    statement: str
    highlights: list[Highlight]


@dataclass(frozen=True)
class RoundAnswer:
    round_index: int
    highlight_id: str
    option_id: str


class Scenario(ABC):
    """每个原创剧本实现一个子类。"""

    id: str
    title: str
    people: list[dict[str, Any]]
    evidence: dict[str, dict[str, Any]]  # id -> 完整证据
    rounds: list[Round]
    round_answers: list[RoundAnswer]
    key_evidence_ids: list[str]
    mastermind_id: str
    reasoning_points: list[str]

    @abstractmethod
    def case_summary(self) -> str:
        """返回给 Agent 的案件摘要。"""

    @abstractmethod
    def initial_context(self) -> dict[str, Any]:
        """返回人物/案件/证据清单（id+summary）。"""
```

- [ ] **Step 2: 创建 scenarios 包与 tests 包**

Create `scenarios/__init__.py`:

```python
"""自动发现 scenarios 目录下的 Scenario 子类。"""
from __future__ import annotations

import importlib
import pkgutil
from typing import Type

from trial_types import Scenario

_SCENARIO_CLASSES: list[Type[Scenario]] = []


def _discover() -> None:
    if _SCENARIO_CLASSES:
        return
    package = __package__ or __name__
    for mod_info in pkgutil.iter_modules(__path__, prefix=f"{package}."):
        module = importlib.import_module(mod_info.name)
        for attr in vars(module).values():
            if (
                isinstance(attr, type)
                and issubclass(attr, Scenario)
                and attr is not Scenario
            ):
                _SCENARIO_CLASSES.append(attr)


def list_scenarios() -> list[Type[Scenario]]:
    _discover()
    return list(_SCENARIO_CLASSES)
```

Create empty `tests/__init__.py`.

- [ ] **Step 3: 写冒烟测试**

Create `tests/test_trial_types.py`:

```python
import unittest

from trial_types import Option, Highlight, Round, RoundAnswer, Scenario


class ScenarioStub(Scenario):
    id = "stub"
    title = "Stub"
    people = []
    evidence = {}
    rounds = []
    round_answers = []
    key_evidence_ids = []
    mastermind_id = "B"
    reasoning_points = []

    def case_summary(self) -> str:
        return "case"

    def initial_context(self) -> dict:
        return {"people": self.people, "evidence": [
            {"id": k, "summary": v.get("summary", "")}
            for k, v in self.evidence.items()
        ]}


class TestTypes(unittest.TestCase):
    def test_round_answer_is_dataclass(self):
        a = RoundAnswer(1, "h1", "o1")
        self.assertEqual(a.highlight_id, "h1")

    def test_highlight_options(self):
        h = Highlight("h1", "stmt", [Option("o1", "A")])
        self.assertEqual(h.options[0].text, "A")

    def test_scenario_subclass_instantiable(self):
        s = ScenarioStub()
        self.assertIn("people", s.initial_context())
```

Run from template root or with sys.path? Tests need import path. For simplicity run tests from `noj-judge/sdk/templates/trial-agent/tests`? Better use `python3 -m unittest discover -s tests -t ..`? We'll document test command with `PYTHONPATH=noj-judge/sdk/templates/trial-agent`. In later tasks.

- [ ] **Step 4: 运行测试确认通过**

Run:
```bash
cd /home/xyber-nova/Github/neuro-oj/noj-judge/sdk/templates/trial-agent && \
PYTHONPATH=. python3 -m unittest discover -s tests -v
```
Expected: PASS

- [ ] **Step 5: 提交**

Commit: `feat(judge): 法庭推理模板类型与 scenario 发现骨架`

---

### Task 2: 审判状态机 TrialRunner

**Files:**
- Create: `noj-judge/sdk/templates/trial-agent/scenario_runner.py`
- Test: `noj-judge/sdk/templates/trial-agent/tests/test_scenario_runner.py`

**Interfaces:**
- Consumes: `Scenario`, `RoundAnswer`
- Produces:
  - `class TrialRunner`:
    - `__init__(scenario: Scenario, max_evidence_queries: int, max_wrong_rebuttals: int = 3, max_llm_calls: int = 30, max_llm_tokens: int = 20_000, seed: str = "default")`
    - `initial_context() -> dict`
    - `get_trial_state() -> dict`
    - `get_evidence(evidence_id: str) -> dict | None`
    - `submit_rebuttal(highlight_id: str, option_id: str) -> dict`
    - `final_verdict(person_id: str, evidence_ids: list[str], reasoning: str) -> dict`
    - `llm_called(billed_tokens: int = 0) -> None`
    - properties `is_finished`, `is_failed`, `current_round_index`, `used_evidence_queries`, `used_wrong_rebuttals`, `used_llm_calls`, `used_llm_tokens`, `queried_evidence_ids`
    - `scoring(reason_score: int = 0) -> dict` 计算 spec §7 的分数（质量+证据链+效率，理由质量由外部 judge 注入）

- [ ] **Step 1: 写失败测试**

Create `tests/test_scenario_runner.py`:

```python
import unittest

from scenario_runner import TrialRunner
from trial_types import Option, Highlight, Round, RoundAnswer


def make_scenario():
    class S:
        id = "s1"
        title = "T"
        people = [{"id": "A", "name": "管家"}, {"id": "B", "name": "律师"}]
        evidence = {
            "ev1": {"summary": "信件", "content": "B 威胁 A"},
            "ev2": {"summary": "门锁", "content": "门被反锁"},
        }
        rounds = [
            Round(
                index=1,
                speaker="A",
                statement="我在书房",
                highlights=[
                    Highlight("seg1", "我在书房", [
                        Option("opt1", "你在温室"),
                        Option("opt2", "门被反锁"),
                    ]),
                    Highlight("seg2", "我没见过 B", [
                        Option("opt3", "信里写了 B"),
                    ]),
                ],
            )
        ]
        round_answers = [RoundAnswer(1, "seg2", "opt3")]
        key_evidence_ids = ["ev1", "ev2"]
        mastermind_id = "B"
        reasoning_points = ["威胁"]

        def case_summary(self): return "case"
        def initial_context(self):
            return {
                "people": self.people,
                "evidence": [
                    {"id": k, "summary": v["summary"]}
                    for k, v in self.evidence.items()
                ],
            }

    return S()


class TestTrialRunner(unittest.TestCase):
    def test_correct_rebuttal_advances(self):
        sc = make_scenario()
        runner = TrialRunner(sc, max_evidence_queries=2, max_wrong_rebuttals=3)
        # 需要先查 ev1 才能命中 seg2? 简单实现不做门控也可通过
        res = runner.submit_rebuttal("seg2", "opt3")
        self.assertTrue(res["correct"])
        self.assertTrue(runner.is_finished)  # 仅一轮 + final? 这里只测推进
        self.assertEqual(runner.current_round_index, 1)

    def test_wrong_rebuttal_counts_and_allows_retry(self):
        sc = make_scenario()
        runner = TrialRunner(sc, max_evidence_queries=2, max_wrong_rebuttals=3)
        res = runner.submit_rebuttal("seg1", "opt1")
        self.assertFalse(res["correct"])
        self.assertEqual(runner.used_wrong_rebuttals, 1)
        self.assertFalse(runner.is_failed)

    def test_exceeding_wrong_rebuttals_fails(self):
        sc = make_scenario()
        runner = TrialRunner(sc, max_evidence_queries=2, max_wrong_rebuttals=0)
        res = runner.submit_rebuttal("seg1", "opt1")
        self.assertTrue(res["failed"])
        self.assertTrue(runner.is_failed)

    def test_evidence_query_budget(self):
        sc = make_scenario()
        runner = TrialRunner(sc, max_evidence_queries=1, max_wrong_rebuttals=3)
        self.assertIsNotNone(runner.get_evidence("ev1"))
        res = runner.get_evidence("ev2")
        self.assertEqual(res, {"error": "evidence_query_limit_exceeded"})
        self.assertTrue(runner.is_failed)

    def test_final_verdict_scoring(self):
        sc = make_scenario()
        runner = TrialRunner(sc, max_evidence_queries=2, max_wrong_rebuttals=3)
        # 必须先查询证据，最终裁决才能引用
        runner.get_evidence("ev1")
        runner.get_evidence("ev2")
        runner.submit_rebuttal("seg2", "opt3")
        result = runner.final_verdict("B", ["ev1", "ev2"], "B 威胁 A")
        self.assertTrue(result["accepted"])
        breakdown = runner.scoring(reason_score=50)
        self.assertEqual(breakdown["max_score"], 1000)
        self.assertEqual(breakdown["rebuttal_score"], 100)
        self.assertEqual(breakdown["mastermind_score"], 200)
        self.assertEqual(breakdown["evidence_score"], 200)
```

- [ ] **Step 2: 运行确认失败**

Run:
```bash
cd /home/xyber-nova/Github/neuro-oj/noj-judge/sdk/templates/trial-agent && \
PYTHONPATH=. python3 -m unittest tests.test_scenario_runner -v
```
Expected: FAIL（`TrialRunner` 不存在）

- [ ] **Step 3: 实现 TrialRunner**

Create `scenario_runner.py`:

```python
"""法庭推理状态机。"""
from __future__ import annotations

from typing import Any

from trial_types import Scenario

# spec §7 分值
REBUTTAL_PER_ROUND = 100
MASTERMIND_SCORE = 200
EVIDENCE_SCORE = 200
EFFICIENCY_SCORE = 50


class TrialRunner:
    def __init__(
        self,
        scenario: Scenario,
        max_evidence_queries: int,
        max_wrong_rebuttals: int = 3,
        max_llm_calls: int = 30,
        max_llm_tokens: int = 20_000,
        seed: str = "default",
    ) -> None:
        self._scenario = scenario
        self._max_evidence_queries = max_evidence_queries
        self._max_wrong_rebuttals = max_wrong_rebuttals
        self._max_llm_calls = max_llm_calls
        self._max_llm_tokens = max_llm_tokens
        self._seed = seed
        self.current_round_index = 0
        self.used_evidence_queries = 0
        self.used_wrong_rebuttals = 0
        self.used_llm_calls = 0
        self.used_llm_tokens = 0
        self.queried_evidence_ids: set[str] = set()
        self._is_failed = False
        self._is_finished = False
        self._final: dict[str, Any] | None = None

    @property
    def is_failed(self) -> bool:
        return self._is_failed

    @property
    def is_finished(self) -> bool:
        return self._is_finished

    def _round(self) -> Any:
        if self.current_round_index >= len(self._scenario.rounds):
            return None
        return self._scenario.rounds[self.current_round_index]

    def initial_context(self) -> dict[str, Any]:
        return self._scenario.initial_context()

    def get_trial_state(self) -> dict[str, Any]:
        r = self._round()
        if r is None or self._is_finished:
            return {"finished": True, "failed": self._is_failed}
        return {
            "round": r.index,
            "speaker": r.speaker,
            "statement": r.statement,
            "highlights": [
                {
                    "id": h.id,
                    "text": h.text,
                    "options": [{"id": o.id, "text": o.text} for o in h.options],
                }
                for h in r.highlights
            ],
        }

    def get_evidence(self, evidence_id: str) -> dict[str, Any] | None:
        if self._is_failed or self._is_finished:
            return None
        if evidence_id not in self._scenario.evidence:
            return None
        if self.used_evidence_queries >= self._max_evidence_queries:
            self._is_failed = True
            return {"error": "evidence_query_limit_exceeded"}
        self.used_evidence_queries += 1
        self.queried_evidence_ids.add(evidence_id)
        return dict(self._scenario.evidence[evidence_id])

    def submit_rebuttal(self, highlight_id: str, option_id: str) -> dict[str, Any]:
        if self._is_failed:
            return {"correct": False, "failed": True}
        if self._is_finished:
            return {"correct": False, "finished": True}
        r = self._round()
        if r is None:
            self._is_finished = True
            return {"correct": False, "finished": True}

        answer = self._scenario.round_answers[self.current_round_index]
        if answer.highlight_id == highlight_id and answer.option_id == option_id:
            self.current_round_index += 1
            if self.current_round_index >= len(self._scenario.rounds):
                self._is_finished = True
            return {"correct": True, "round": r.index, "finished": self._is_finished}

        self.used_wrong_rebuttals += 1
        if self.used_wrong_rebuttals > self._max_wrong_rebuttals:
            self._is_failed = True
            return {
                "correct": False,
                "failed": True,
                "reason": "rebuttal_limit_exceeded",
            }
        return {"correct": False, "round": r.index, "retry": True}

    def final_verdict(
        self,
        person_id: str,
        evidence_ids: list[str],
        reasoning: str,
    ) -> dict[str, Any]:
        if self._is_failed:
            return {"accepted": False, "reason": "failed"}
        if not self._is_finished:
            # 允许在未完成 5 轮时提交，但状态机记录为未完成
            pass
        self._is_finished = True
        self._final = {
            "person_id": person_id,
            "evidence_ids": list(evidence_ids),
            "reasoning": reasoning,
        }
        accepted = person_id == self._scenario.mastermind_id
        return {"accepted": accepted, "finished": True}

    def llm_called(self, billed_tokens: int = 0) -> None:
        """由外部 SDK/Agent 每次 LLM 调用后调用；记录 billed token，超限即失败。"""
        self.used_llm_calls += 1
        self.used_llm_tokens += max(0, billed_tokens)
        if (
            self.used_llm_calls > self._max_llm_calls
            or self.used_llm_tokens > self._max_llm_tokens
        ):
            self._is_failed = True

    def scoring(self, reason_score: int = 0) -> dict[str, int]:
        if self._is_failed:
            return {
                "max_score": 1000,
                "score": 0,
                "rebuttal_score": 0,
                "mastermind_score": 0,
                "evidence_score": 0,
                "reason_score": 0,
                "efficiency_score": 0,
            }
        if self._final is None:
            # 未调用 final_verdict：只保留已正确反驳分
            rebuttal = self.current_round_index * REBUTTAL_PER_ROUND
            return {
                "max_score": 1000,
                "score": rebuttal,
                "rebuttal_score": rebuttal,
                "mastermind_score": 0,
                "evidence_score": 0,
                "reason_score": 0,
                "efficiency_score": 0,
            }

        rebuttal = self.current_round_index * REBUTTAL_PER_ROUND
        mastermind = MASTERMIND_SCORE if self._final["person_id"] == self._scenario.mastermind_id else 0
        # 只有 final_verdict 中引用且确实 get_evidence 查询过的关键证据才计证据分
        queried_key = set(self._scenario.key_evidence_ids) & self.queried_evidence_ids
        matched = set(self._final["evidence_ids"]) & queried_key
        evidence = round(EVIDENCE_SCORE * len(matched) / len(self._scenario.key_evidence_ids)) if self._scenario.key_evidence_ids else 0

        # 效率分：按 LLM 与证据查询余量线性给分；证据查询上限可能在外部由 evidence 数×2/3 算好传入
        ev_cap = self._max_evidence_queries
        llm_cap = self._max_llm_calls
        llm_ratio = min(1.0, self.used_llm_calls / llm_cap) if llm_cap else 1.0
        ev_ratio = min(1.0, self.used_evidence_queries / ev_cap) if ev_cap else 1.0
        efficiency = round(EFFICIENCY_SCORE * (1 - (llm_ratio + ev_ratio) / 2))

        score = rebuttal + mastermind + evidence + reason_score + efficiency
        return {
            "max_score": 1000,
            "score": score,
            "rebuttal_score": rebuttal,
            "mastermind_score": mastermind,
            "evidence_score": evidence,
            "reason_score": reason_score,
            "efficiency_score": efficiency,
        }
```

> `get_evidence` 超限即失败、错误可重试但计数、`scoring` 按 spec §7 实现；LLM-as-judge 理由分由外部传入 `reason_score`。

- [ ] **Step 4: 运行测试确认通过**

Run:
```bash
cd /home/xyber-nova/Github/neuro-oj/noj-judge/sdk/templates/trial-agent && \
PYTHONPATH=. python3 -m unittest tests.test_scenario_runner -v
```
Expected: PASS

- [ ] **Step 5: fmt/lint（Python 无强制工具；自查 PEP8）与提交**

Commit: `feat(judge): 法庭推理审判状态机与评分`

---

### Task 3: 示例剧本 manor_001

**Files:**
- Create: `noj-judge/sdk/templates/trial-agent/scenarios/manor_001.py`

**Interfaces:**
- Consumes: `Scenario`, `Round`, `Highlight`, `Option`, `RoundAnswer`
- Produces: `class Manor001(Scenario)`，可从 `list_scenarios()` 发现

- [ ] **Step 1: 写示例剧本**

Create `scenarios/manor_001.py`:

```python
"""原创示例剧本：雪夜庄园的魔女审判（仅机制致敬，不使用原作 IP）。"""
from __future__ import annotations

from trial_types import Scenario, Round, Highlight, Option, RoundAnswer


class Manor001(Scenario):
    id = "manor_001"
    title = "雪夜庄园的魔女审判·示例"
    people = [
        {"id": "A", "name": "管家阿尔诺", "role": "嫌疑人"},
        {"id": "B", "name": "律师贝拉", "role": "嫌疑人"},
        {"id": "C", "name": "夫人塞西尔", "role": "嫌疑人"},
        {"id": "D", "name": "司机德里克", "role": "嫌疑人"},
    ]
    evidence = {
        "ev1": {"summary": "书房凶器：烛台", "content": "烛台底部有 A 的指纹（表面证据）"},
        "ev2": {"summary": "A 的私人信件", "content": "信中提到 B 掌握 A 的把柄，并威胁其家人"},
        "ev3": {"summary": "温室门锁报告", "content": "温室门从外部反锁，B 声称 23:00 在温室不成立"},
        "ev4": {"summary": "B 的通话记录", "content": "案发前 30 分钟 B 与 A 有通话"},
        "ev5": {"summary": "仆人证词", "content": "C 在 22:50 确实去了温室（干扰项）"},
        "ev6": {"summary": "花园脚印", "content": "雪地脚印属于 D（干扰项）"},
    }
    rounds = [
        Round(1, "C", "我看到 A 拿着烛台站在书房门口。", [
            Highlight("s1", "A 拿着烛台站在书房门口", [
                Option("o1", "烛台上的指纹也可能是事后印上去的"),
                Option("o2", "C 当时在温室，不可能看到书房门口"),
                Option("o3", "A 的指纹本来就在烛台上，不能证明动手"),
            ]),
            Highlight("s2", "C 当时在温室", [
                Option("o4", "温室门从外部反锁，C 不可能一直在里面"),
                Option("o5", "C 可能看错时间"),
            ]),
        ]),
        Round(2, "A", "是我杀了主人，我认罪。", [
            Highlight("s3", "是我杀了主人", [
                Option("o6", "信里写的是 B 威胁你，不是你主动想杀"),
                Option("o7", "你只是在自卫"),
                Option("o8", "你不可能杀人"),
            ]),
        ]),
        Round(3, "B", "我整晚都在温室，没离开过。", [
            Highlight("s4", "我整晚都在温室", [
                Option("o9", "温室门从外部反锁，你不可能一直在里面"),
                Option("o10", "有人看见你在书房"),
            ]),
        ]),
    ]
    round_answers = [
        RoundAnswer(1, "s2", "o4"),
        RoundAnswer(2, "s3", "o6"),
        RoundAnswer(3, "s4", "o9"),
    ]
    key_evidence_ids = ["ev2", "ev3", "ev4"]
    mastermind_id = "B"
    reasoning_points = ["威胁", "主谋", "温室门反锁"]

    def case_summary(self) -> str:
        return "庄园主死于书房；你需要在法庭上找出真正主谋。"

    def initial_context(self) -> dict:
        return {
            "case_summary": self.case_summary(),
            "people": self.people,
            "evidence": [
                {"id": k, "summary": v["summary"]}
                for k, v in self.evidence.items()
            ],
        }
```

> 示例只写了 3 轮便于离线验证；正式题应 5 轮，但结构一致。`scenario_runner` 不硬编码 5 轮，按 `rounds` 长度工作。

- [ ] **Step 2: 写发现测试**

Create `tests/test_scenario_registry.py`:

```python
import unittest

from scenarios import list_scenarios


class TestRegistry(unittest.TestCase):
    def test_manor_001_discovered(self):
        classes = list_scenarios()
        ids = [c.id for c in classes]
        self.assertIn("manor_001", ids)
```

- [ ] **Step 3: 运行测试**

Run:
```bash
cd /home/xyber-nova/Github/neuro-oj/noj-judge/sdk/templates/trial-agent && \
PYTHONPATH=. python3 -m unittest tests.test_scenario_registry -v
```
Expected: PASS

- [ ] **Step 4: 提交**

Commit: `feat(judge): 法庭推理示例剧本 manor_001`

---

### Task 4: 离线评测入口 evaluate_offline 与参考 Agent

**Files:**
- Create: `noj-judge/sdk/templates/trial-agent/evaluate_offline.py`
- Create: `noj-judge/sdk/templates/trial-agent/reference_agent/main.py`
- Test: `noj-judge/sdk/templates/trial-agent/tests/test_offline_e2e.py`

**Interfaces:**
- Produces:
  - `run_offline_evaluation(scenario, solve_agent, max_evidence_queries=None, max_wrong_rebuttals=3, judge_fn=None, seed="default") -> dict`
  - `reference_agent.main.solve_agent(ctx, api)`：`ctx` 为 `initial_context`，`api` 为 `TrialApi` 适配层（`get_evidence/get_trial_state/submit_rebuttal/final_verdict`）

- [ ] **Step 1: 写失败测试**

Create `tests/test_offline_e2e.py`:

```python
import unittest

from evaluate_offline import run_offline_evaluation


class TestOfflineE2EModule(unittest.TestCase):
    def test_run_offline_evaluation_exists(self):
        self.assertTrue(callable(run_offline_evaluation))
```

- [ ] **Step 2: 运行确认失败**

Run:
```bash
cd /home/xyber-nova/Github/neuro-oj/noj-judge/sdk/templates/trial-agent && \
PYTHONPATH=. python3 -m unittest tests.test_offline_e2e -v
```
Expected: FAIL（`evaluate_offline` 不存在）

- [ ] **Step 3: 实现 evaluate_offline 与参考 Agent**

Create `evaluate_offline.py`:

```python
"""离线评测：不依赖 NOJ SDK，直接驱动用户 solve_agent(ctx, api)。"""
from __future__ import annotations

import random
from typing import Any, Callable

from scenario_runner import TrialRunner
from scenarios import list_scenarios
from trial_types import Scenario

SolveAgent = Callable[[dict[str, Any], Any], None]


def pick_scenario(scenario: Scenario | None = None, seed: str = "default") -> Scenario:
    if scenario is not None:
        return scenario
    classes = list_scenarios()
    rng = random.Random(seed)
    cls = rng.choice(classes)
    return cls()


def run_offline_evaluation(
    scenario: Scenario | None = None,
    solve_agent: SolveAgent | None = None,
    max_evidence_queries: int | None = None,
    max_wrong_rebuttals: int = 3,
    judge_fn: Callable[[dict], int] | None = None,
    seed: str = "default",
) -> dict:
    sc = pick_scenario(scenario, seed=seed)
    if max_evidence_queries is None:
        max_evidence_queries = max(1, int(len(sc.evidence) * 2 / 3))
    runner = TrialRunner(
        sc,
        max_evidence_queries=max_evidence_queries,
        max_wrong_rebuttals=max_wrong_rebuttals,
        max_llm_calls=30,
        seed=seed,
    )

    if solve_agent is not None:
        class Api:
            def __init__(self):
                self._finished = False

            def get_evidence(self, eid):
                return runner.get_evidence(eid)

            def get_trial_state(self):
                return runner.get_trial_state()

            def submit_rebuttal(self, hid, oid):
                return runner.submit_rebuttal(hid, oid)

            def final_verdict(self, pid, eids, reasoning):
                runner.final_verdict(pid, eids, reasoning)
                self._finished = True
                return {"accepted": pid == sc.mastermind_id}

            def llm(self, messages, **params):
                runner.llm_called()
                return {"choices": [{"message": {"content": "stub"}}]}

        solve_agent(sc.initial_context(), Api())

    reason_score = 0
    if judge_fn is not None and runner._final is not None and not runner.is_failed:
        reason_score = judge_fn(runner._final)

    breakdown = runner.scoring(reason_score=reason_score)
    return {
        "scenario_id": sc.id,
        "seed": seed,
        "used_evidence_queries": runner.used_evidence_queries,
        "used_wrong_rebuttals": runner.used_wrong_rebuttals,
        "used_llm_calls": runner.used_llm_calls,
        "is_failed": runner.is_failed,
        "is_finished": runner.is_finished,
        **breakdown,
    }
```

Create `reference_agent/main.py`:

```python
"""参考 Agent：离线/在线通用的 solve_agent(ctx, api)。"""
from __future__ import annotations

from typing import Any


def solve_agent(ctx: dict[str, Any], api: Any) -> None:
    # 示例：先查关键证据，再按已知剧本路径推进；正式题目应让 Agent 自行推理。
    for eid in ("ev2", "ev3", "ev4"):
        api.get_evidence(eid)

    answers = [(1, "s2", "o4"), (2, "s3", "o6"), (3, "s4", "o9")]
    for _round, hid, oid in answers:
        api.submit_rebuttal(hid, oid)

    api.final_verdict("B", ["ev2", "ev3", "ev4"], "B 威胁 A，是主谋")
```

- [ ] **Step 4: 完成 E2E 测试**

Replace content of `tests/test_offline_e2e.py`:

```python
import unittest

from scenarios.manor_001 import Manor001
from evaluate_offline import run_offline_evaluation
from reference_agent.main import solve_agent


class TestOfflineE2E(unittest.TestCase):
    def test_reference_agent_scores_high_without_llm(self):
        result = run_offline_evaluation(
            scenario=Manor001(),
            solve_agent=solve_agent,
            judge_fn=lambda _final: 50,
        )
        self.assertEqual(result["is_failed"], False)
        self.assertGreaterEqual(result["score"], 750)

    def test_brute_force_without_evidence_is_blocked_by_limits(self):
        def brute_force(ctx, api):
            state = api.get_trial_state()
            for highlight in state["highlights"]:
                for option in highlight["options"]:
                    res = api.submit_rebuttal(highlight["id"], option["id"])
                    if res.get("failed"):
                        return
                    if res.get("correct"):
                        break
            api.final_verdict("B", [], "猜的")

        result = run_offline_evaluation(
            scenario=Manor001(),
            solve_agent=brute_force,
            max_wrong_rebuttals=0,
            judge_fn=lambda _final: 0,
        )
        self.assertEqual(result["score"], 0)
```

> 注意：示例剧本只有 3 轮，最大证据查询数 = max(1, int(6*2/3)) = 4；参考 Agent 查询 3 条关键证据并全部引用，未用 LLM，因此总分接近满分但不是 1000（效率分未满）。正式题 5 轮/12–15 证据时按 spec 校准。

- [ ] **Step 5: 运行测试**

Run:
```bash
cd /home/xyber-nova/Github/neuro-oj/noj-judge/sdk/templates/trial-agent && \
PYTHONPATH=. python3 -m unittest discover -s tests -v
```
Expected: PASS

- [ ] **Step 6: 提交**

Commit: `feat(judge): 法庭推理离线评测入口与参考 Agent`

---

### Task 5: LLM-as-judge 适配层与 README

**Files:**
- Create: `noj-judge/sdk/templates/trial-agent/llm_judge.py`
- Create: `noj-judge/sdk/templates/trial-agent/README.md`

**Interfaces:**
- Produces:
  - `build_judge_messages(scenario, final_verdict) -> list[dict]`
  - `parse_judge_response(text: str) -> int`（解析 JSON `{"score": 0..50}`，失败返回 0）
  - README 说明模板结构、运行方法、如何接 NOJ SDK

- [ ] **Step 1: 写失败测试**

Create `tests/test_llm_judge.py`:

```python
import unittest

from llm_judge import build_judge_messages, parse_judge_response
from scenarios.manor_001 import Manor001


class TestLlmJudge(unittest.TestCase):
    def test_parse_valid(self):
        self.assertEqual(parse_judge_response('{"score": 42}'), 42)

    def test_parse_invalid_returns_zero(self):
        self.assertEqual(parse_judge_response("oops"), 0)

    def test_build_messages_contains_reasoning_points(self):
        sc = Manor001()
        msgs = build_judge_messages(sc, {
            "person_id": "B",
            "evidence_ids": ["ev1", "ev2", "ev3", "ev4"],
            "reasoning": "B 威胁 A，温室门反锁证明 B 说谎",
        })
        joined = "\n".join(m["content"] for m in msgs)
        self.assertIn("威胁", joined)
```

- [ ] **Step 2: 运行确认失败**

Run:
```bash
cd /home/xyber-nova/Github/neuro-oj/noj-judge/sdk/templates/trial-agent && \
PYTHONPATH=. python3 -m unittest tests.test_llm_judge -v
```
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现 llm_judge.py**

Create `llm_judge.py`:

```python
"""LLM-as-judge 理由评分适配层。"""
from __future__ import annotations

import json
import re
from typing import Any

from trial_types import Scenario

MAX_REASON_SCORE = 50


def build_judge_messages(
    scenario: Scenario,
    final_verdict: dict[str, Any],
) -> list[dict[str, str]]:
    system = (
        "你是一个公正的推理评分员。根据剧本标准答案，判断选手最终裁决的"
        "理由是否覆盖关键推理点。只输出 JSON：{\"score\": 0..50}"
    )
    user = (
        f"剧本: {scenario.title}\n"
        f"标准主谋: {scenario.mastermind_id}\n"
        f"关键推理点: {', '.join(scenario.reasoning_points)}\n"
        f"选手最终裁决: {json.dumps(final_verdict, ensure_ascii=False)}\n"
        "请评分。"
    )
    return [
        {"role": "system", "content": system},
        {"role": "user", "content": user},
    ]


def parse_judge_response(text: str) -> int:
    try:
        obj = json.loads(text)
        score = int(obj.get("score", 0))
    except Exception:
        m = re.search(r"\{[^{}]*\"score\"\s*:\s*(\d+)[^{}]*\}", text)
        if not m:
            return 0
        score = int(m.group(1))
    return max(0, min(MAX_REASON_SCORE, score))
```

- [ ] **Step 4: 写 README**

Create `README.md`:

```markdown
# 法庭推理 Agent 题支持包模板

原创法庭推理题（借鉴《魔法少女的魔女审判》机制，不使用原作 IP）。

## 目录

- `trial_types.py`：Scenario/Round/Highlight/Option/RoundAnswer
- `scenario_runner.py`：审判状态机 + 评分
- `scenarios/`：原创剧本（每文件一个 Scenario）
- `evaluate_offline.py`：离线评测入口
- `reference_agent/`：参考 Agent
- `llm_judge.py`：理由评分 prompt 与解析

## 运行测试

```bash
cd noj-judge/sdk/templates/trial-agent
PYTHONPATH=. python3 -m unittest discover -s tests -v
```

## 接 NOJ 双容器

后续将 `evaluate_offline.py` 的 `Api` 替换为 evaluator 注册的 capabilities，
并把 `reference_agent/main.py` 作为用户 `main.py` 的模板；`llm_complete`
capability 在 evaluator 侧调用 `noj_evaluator_sdk.llm.complete`。
```

- [ ] **Step 5: 运行全部测试并提交**

Run:
```bash
cd /home/xyber-nova/Github/neuro-oj/noj-judge/sdk/templates/trial-agent && \
PYTHONPATH=. python3 -m unittest discover -s tests -v
```
Expected: PASS

Commit: `feat(judge): 法庭推理模板 LLM judge 适配与 README`

---

## 验证清单

- [ ] `python3 -m unittest discover -s tests -v` 全绿；
- [ ] 示例剧本可离线跑通，参考 Agent 满分；
- [ ] 穷举/超限用例被状态机判 0；
- [ ] `list_scenarios()` 能发现 `manor_001`；
- [ ] README 说明清晰。
