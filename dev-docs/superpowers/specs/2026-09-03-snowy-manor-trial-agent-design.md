# 原创法庭推理 Agent 题《雪夜庄园的魔女审判》设计

> 日期：2026-09-03
> 状态：Proposed（方向已与用户确认，待评审后进入实施计划）
> 范围：一类新的 AI Agent 评测题（法庭推理/多阶段反驳）；涉及支持包内剧本运行时、Solution→Evaluator capability、llm-gateway 精确计费与超限语义；不改变 NOJ 现有客观题/代码题/产物题主流程

## 1. 背景与动机

NOJ 面向 AI 能力训练与社区口碑，希望提供有挑战性、有区分度、低成本、有趣味的 AI 类题目。经过多轮讨论，我们选择“侦探/法庭推理 Agent”作为第一个方向：

- 现代 LLM 本身推理能力强，简单“单凶手 + 有限撒谎”容易被一眼看穿，缺少区分度；
- 借鉴《魔法少女的魔女审判》（下称“原游戏”）的“高亮证词 → 唯一正确反驳 → 推进多人审判”机制，能形成强区分度；
- 采用**原创皮 + 借鉴机制**：不使用原游戏角色、文本、世界观、专有名词，避免法人尺度/IP 授权问题；
- 评测成本集中在 LLM 调用，通过“预写剧本 + 结构化交互 + 评测级硬预算”控制。

### 1.1 已确认的关键决策

- 定位：竞赛模式优先，所有 Agent 使用平台统一 LLM（竞赛禁用 BYOK）；公平优先。
- 形态：取消开放式调查/探索阶段；证据清单开局可见，具体证据内容由 Agent 按需查询；直接进入法庭辩论。
- 机制：5 轮审判；每轮若干高亮证词，每句 2–4 个反驳选项，唯一正确反驳推进下一轮；选错可重试，但受“反驳错误”独立上限约束，在预算内完成即可。
- 剧本：由出题人预写为 **Python class/模块**（非 JSON Schema 定稿），evaluator 运行时加载；支持复杂编程化功能。
- 隐藏性：剧本池放在统一题目包（支持包）中，由 evaluate.py 随机抽取一个；依赖“支持包不发给用户”保证隐藏。
- 预算：按整个评测（submission）隔离，不按剧本/轮次隔离；KISS。
- LLM 能力：Agent 直接 `call_capability("llm_complete", messages)`，由 Evaluator 侧 capability 转发到 `noj_evaluator_sdk.llm.complete` → llm-gateway。
- 理由评分：LLM-as-judge，在同一评测 token 预算内执行。
- 题目上传：复用现有统一题目包上传流程，无需新增平台上传机制。

## 2. 目标与非目标

### 2.1 目标

- 设计一个可运行、可判分、可扩展的“法庭推理 Agent 题”样例；
- 明确剧本 Python class 模型与评测协议；
- 明确 LLM 调用链、预算与超限语义；
- 明确理由评分（LLM-as-judge）流程；
- 识别并最小化需要的平台改动。

### 2.2 非目标

- 不做开放世界/自由 NPC 对话；
- 不直接使用《魔法少女的魔女审判》的 IP 元素；
- 不做多剧本同评测（一个评测随机抽 1 个剧本）；
- 不做赛后异步批量 LLM judge；
- 不新增“题目上传/支持包上传”平台机制（复用现有流程）；
- 不实现训练/微调类评测。

## 3. 题目玩法与用户视角

### 3.1 故事设定（原创）

在一座被大雪封闭的庄园中发生命案。玩家不是传统侦探，而是一名“审判代理人”，需要在庄园内部法庭上与多名相关人物逐轮对质，戳穿谎言、推进真相。所有人物、地点、故事均为原创。

### 3.2 做题人体验

1. 打开题目，阅读题面与说明；
2. 在代码编辑器中编写 `main.py`，实现 `solve_agent(initial_context)`（或其他题面声明的入口函数），内部自主驱动调查/反驳流程；
3. 提交后，评测系统从剧本池随机抽取一个原创剧本；
4. Agent 收到 `initial_context`：人物表、案件摘要、证据清单（id + 一句话摘要）；
5. Agent 进入 5 轮法庭审判，每轮：
   - evaluator 返回当前发言、高亮证词与反驳选项；
   - Agent 可调用 `get_evidence` 查询证据详情、调用 `llm_complete` 进行推理；
   - Agent 提交 `submit_rebuttal`，选对推进，选错可重试；
6. 完成 5 轮后，Agent 提交 `final_verdict`：主谋、证据链、理由；
7. 评测输出单一 score 与分项 details。

> **入口形态说明**：NOJ 现有 Solution Host 是“加载 `main.py` 并注册顶层函数、Evaluator 用 `runner.call` 调用”。本题需要 Solution 侧**主动驱动**，因此 evaluate.py 调用用户暴露的 `solve_agent(initial_context)` 函数；该函数在返回前通过 `call_capability` 自主完成所有法庭交互。这样保持与现有 Solution Host 兼容，不引入新的运行器。
>
> **结束语义**：`final_verdict` capability 在 evaluator 侧记录最终裁决并关闭审判状态机，然后 `solve_agent` 正常返回；evaluator 读取 `solve_agent` 返回值作为“Agent 已完成”信号（可为 `None`/状态 dict）。若 Agent 未调用 `final_verdict` 就返回，评测视为未完成：只保留已正确反驳轮次的分（每轮 100，最多 500），主谋/证据链/理由/效率均按 0 处理；若同时触发了预算超限，则按 6.3 整体 0 分。

### 3.3 趣味与区分度来源

- 逐轮“高亮证词找漏洞”像解谜，有推进感和叙事张力；
- 证据查询预算（约证据数 2/3）强制取舍，不能全查；
- LLM 轮次/token 预算限制盲目思考，强者用更少预算完成；
- 5 轮反转与多人互相指控/辩解形成多层推理，弱 Agent 会中途卡住。

## 4. 剧本模型（Python class）

剧本不使用 JSON Schema 固化，而是每个剧本一个 Python 模块/类，由 evaluator 运行时导入。这样每轮判定、证据按需生成、文本模板化、复杂真相链都可以用代码表达。

### 4.1 目录约定（支持包内）

```text
<题目支持包>.zip
├── evaluate.py            # 评测主程序（必选）
├── scenario_runner.py     # 剧本加载/审判状态机（可由 evaluate.py 内置或独立模块）
└── scenarios/
    ├── __init__.py        # 空文件或自动发现列表
    ├── manor_001.py       # 原创剧本 1
    ├── manor_002.py       # 原创剧本 2
    └── ...
```

### 4.2 Scenario 类最小接口

```python
class Scenario:
    id: str
    title: str
    case_summary: str
    people: list[dict]          # 人物表（id/name/public_bio/role）
    evidence_list: list[dict]   # 证据清单（id/summary）
    rounds: list[Round]         # 5 轮审判定义

    def initial_context(self) -> dict:
        """返回 Agent 开局可见内容：case_summary/people/evidence_list。"""

    def get_evidence(self, evidence_id: str) -> dict | None:
        """返回证据详情；未知 id 返回 None。"""

    def get_trial_state(self, round_index: int) -> dict:
        """返回当前轮发言/高亮句/反驳选项。"""

    def check_rebuttal(
        self,
        round_index: int,
        highlight_id: str,
        option_id: str,
    ) -> dict:
        """判定反驳是否正确；正确返回推进，错误返回可重试信息。"""

    def final_chain(self) -> list[str]:
        """最终裁决所需关键证据子集。"""

    def answer(self) -> dict:
        """标准答案：mastermind/person id、key_evidence_ids、reasoning_points。"""
```

### 4.3 Round 结构（示意）

```python
class Round:
    index: int
    speaker: str
    statement: str
    highlights: list[Highlight]   # 本轮可点击的高亮句（含干扰项）

class Highlight:
    id: str
    text: str
    options: list[Option]

class Option:
    id: str
    text: str
    # 注意：Option 不向 Agent 暴露 correct；correct 是剧本内部答案
    required_evidence: str | None  # 可选：需要先查询该证据才能选对

class RoundAnswer:
    round_index: int
    correct_highlight_id: str
    correct_option_id: str
```

> 关键：**每轮整轮有且仅有一个正确 `(highlight_id, option_id)`**，而不是每个 Highlight 都要选对。其余高亮句/选项都是干扰项。`Scenario` 内部保存 `round_answers`，`check_rebuttal` 用 `RoundAnswer` 判定；公开的 `get_trial_state` 不得包含 correct 标记。
>
> 具体字段可在开发中演进，但须保持“每轮唯一正确反驳”与“证据门控可表达”两条能力。

### 4.4 剧本质量要求

- 难度相近：剧本池所有剧本结构相同（5 轮、12–15 条证据），主谋/人物/秘密/文本不同；
- 唯一可解：每轮在全部高亮句与选项中，有且仅有一个正确的 `(highlight_id, option_id)`；正确反驳可通过已查证据唯一确定；
- 隐藏性：剧本不得包含在题面、模板、示例或任何用户可见内容中；correct 标记只存在于剧本内部答案。

## 5. 评测流程与交互协议

### 5.1 总流程

```text
evaluate.py 启动
  ├─ 加载 scenarios/ 下全部剧本
  ├─ 以 submission_id（或评测任务 id）+ rejudge_seq 为随机种子，随机抽 1 个剧本
  │    （保证同一提交重测/重试时剧本不变，评分可复现）
  ├─ 实例化 Scenario，注册 capabilities：
  │     get_evidence / get_trial_state / submit_rebuttal /
  │     final_verdict / llm_complete
  ├─ 调用 SolutionRunner（选手 main.py 中的 Agent 入口）
  ├─ Agent 通过 call_capability 与剧本状态机交互
  ├─ 完成 final_verdict 或触发超限/超时
  ├─ 若完成 final_verdict，调用 LLM-as-judge 评理由分
  └─ 输出 ---RESULT--- + {score, details}
```

### 5.2 Agent 侧 capability 接口

| capability | 参数 | 返回 | 预算 |
|---|---|---|---|
| `get_evidence` | `evidence_id` | 证据详情 | 证据查询 +1 |
| `get_trial_state` | — | 当前轮发言/高亮/选项 | 不计 |
| `submit_rebuttal` | `highlight_id`, `option_id` | 对/错/推进 | 选错 +1（独立反驳错误上限） |
| `final_verdict` | `person_id`, `evidence_ids`, `reasoning` | 最终判定并结束 | 不计 |
| `llm_complete` | `messages`, `params`（可选 dict，含 model/temperature 等） | LLM 响应 | LLM 轮次 +1，token 计费 |

> Agent 通过 `noj_solution_sdk.call_capability(name, *args)` 调用，无需新增 Agent SDK 包装。
> 注意：当前 Solution SDK 的 `call_capability` 只支持位置参数（不含 `**kwargs`），
> 因此 `llm_complete` 的额外参数统一以单个 JSON dict 作为第二位置参数传入，
> evaluator handler 形如 `def cap_llm_complete(messages, params=None)`。
> `initial_context`（人物/案件/证据清单）作为 `solve_agent(initial_context)` 参数传入，不单设 capability；`get_evidence` 才返回证据完整内容，二者分离用于计“查询数”。
>
> **隔离边界**：`get_evidence` / `get_trial_state` / `submit_rebuttal` 只能作用于**当前剧本**；未知 evidence id 返回 `None`/错误，不查询、不返回其他剧本或支持包内其他文件内容。Agent 无从通过 capability 枚举剧本池或读取剧本源码。

> **`llm_complete` 是一条 evaluator 注册的普通 capability**，不是 judge 内置的 BYOK capability：
> - evaluator 在 `register_capability("llm_complete", handler)` 中调用 `noj_evaluator_sdk.llm.complete`；
> - judge 对普通 capability 帧直接转发给 evaluator；只有名为 `request_user_llm_completion` 的 BYOK capability 才由 judge 特判。
> - 因此本题竞赛使用平台统一 Provider/eval_token，不走 BYOK；若未来支持练习模式 BYOK，可让 evaluator 的 `llm_complete` handler 内部分流。

### 5.3 Evaluator 侧 capability 实现要点

- 每个 capability handler 是普通 Python 函数，经 `register_capability` 注册；
- `llm_complete` handler 内部调用 `noj_evaluator_sdk.llm.complete`（出站 HTTP，不回调 Solution，不应死锁；需 E2E 验证）；
- 证据查询计数、轮次推进、最终判定由 evaluator 内剧本状态机维护；
- 最终结果写入标准 `details.cases`，本次评测一个 case（对应随机抽到的剧本），顶层 score 由 evaluate.py 给出。

## 6. 预算、成本与超限

### 6.1 预算维度与默认值

预算按整个评测（submission）隔离，不按轮次或剧本再分。为让 LLM-as-judge 不被 Agent 挤掉，预算分“Agent 可用额度”与“judge 保留额度”，二者共同构成 eval_token 的总硬上限。

| 限制 | Agent 可用 | judge 保留 | 合计/说明 |
|---|---|---|---|
| LLM 请求轮次 | 30 次/评测 | 1 次（默认） | `eval_token.max_calls = 31`（可配置） |
| billed token | 20k/评测 | 2k（默认） | `eval_token.max_tokens = 22k`（可配置） |
| 证据查询 | 证据数 × 2/3（约 8–10 次） | 不适用 | evaluator 本地计数 |
| 反驳错误 | 3 次/评测（默认，可配置） | 不适用 | evaluator 本地计数；防穷举 |
| 单次 LLM `max_tokens` | ≤2k | ≤2k | 防单次超长输出 |
| wall-clock | 5 分钟 | 同上 | 防死循环/失控 |

> 说明：表中“Agent 可用”是评测器应尽量让 Agent 使用的上限；“judge 保留”是留给 `final_verdict` 后 LLM-as-judge 的额度。`eval_token` 的硬上限为两者之和，gateway 仍是最终权威。具体数值在样例题校准后调整。

**运行时参数（评测容器/调用超时）**：
- `runtime_config.evaluator.time_limit_ms` 应覆盖整个评测 wall-clock（如 5 分钟 = 300000 ms）；
- `runtime_config.solution.call_timeout_ms` 不应使用普通题目的短默认值：evaluator 对 `solve_agent` 的 `runner.call("solve_agent", ..., timeout_ms=<整个评测余量>)` 应允许 Agent 自主跑完整场；
- 若 Agent 内部某次 `call_capability` 因 evaluator 侧 LLM 出站调用耗时较长，judge 的 capability 超时需按 `register_capability(..., timeout_ms=...)` 设置合理值（如 60–120s），不能按普通 RPC 短超时处理；
- `eval_token.max_calls` 应设置为“Agent 上限 + judge 保留”之和，`max_tokens` 同理；这些值由 noj-core 在签发 eval_token 时按题目/评测配置写入，不能沿用默认 100/50k。

### 6.2 LLM 调用链与计数

```text
Solution Agent
  └─ call_capability("llm_complete", messages)
        → Evaluator capability handler
        → noj_evaluator_sdk.llm.complete(messages)
        → noj-llm-gateway POST /v1/chat/completions
        → 按 eval_token 的 max_calls / max_tokens 计数
```

- **LLM 请求轮次**：由 gateway 单次提交级 `calls` 计数承载（现有 `llm:sub:<submission_id>:calls`）。
- **billed token**：需要 gateway 支持精确 billed token（见第 8 节）。
- **证据查询**：由 evaluator 本地计数。
- **Agent 额度保护**：evaluator 在 `llm_complete` handler 内维护“Agent 已用 LLM 次数/token”，当 Agent 用尽自己的 30 次/20k 额度时，handler 直接返回 `out_of_usage`（不再转发 gateway），从而保护 judge 保留额度；gateway 的硬上限仍作为兜底。

### 6.3 超限语义

- 任一**硬上限**超限（eval_token 的 calls/tokens、证据查询、反驳错误、wall-clock）→ 该评测整体 0 分。
- Agent 超过自身可用额度（30 次/20k）但未超过 eval_token 硬上限时，`llm_complete` 返回 `out_of_usage`，评测器置失败标记；若 Agent 仍继续/最终返回，该评测记 0。
- LLM/token 硬超限：gateway 返回 OpenAI 兼容 `out_of_usage` 错误；Evaluator 侧捕获后标记评测失败。
- 证据查询超限：`get_evidence` 返回 `evidence_query_limit_exceeded`，并置评测失败标记；后续 `final_verdict` 不再计分。
- 反驳错误超限：`submit_rebuttal` 返回 `rebuttal_limit_exceeded`，并置评测失败标记；后续 `final_verdict` 不再计分。
- 选错反驳可重试，但每次选错都计入“反驳错误”独立上限；只要未超限且其他预算充足，前面选错不直接判 0（错误次数会影响可用容错，并间接影响效率/策略）。

### 6.4 LLM-as-judge 与预算

- 理由评分在同一评测、同一 eval_token 预算内执行，但使用 6.1 的 judge 保留额度；
- Agent 正常完成 `final_verdict` 后，evaluate.py 调用 judge；若 judge 调用失败（网络/解析/额度异常），理由分记 0 或保守分，不影响其余已确定得分；
- 若 Agent 已触发 6.3 的失败标记，则不再执行 judge，整评测 0 分。

## 7. 评分模型

每评测满分 1000：

| 评分项 | 分值 | 说明 |
|---|---|---|
| 5 轮反驳正确 | 500 | 每轮 100 |
| 最终主谋正确 | 200 | 指向剧本 answer.mastermind |
| 证据链完整 | 200 | `final_verdict.evidence_ids` 覆盖关键证据子集，缺一扣；**只有调用 `get_evidence` 成功查询过的证据才计入该子集** |
| 理由质量 | 50 | LLM-as-judge，依据 reasoning_points 判定 |
| 效率 | 50 | 根据 LLM 轮次/证据查询余量综合计算 |
| **满分** | **1000** | |

效率分公式（初版，可在开发中调整）：

```text
llm_ratio = used_llm_calls / max_llm_calls
ev_ratio  = used_evidence_queries / max_evidence_queries
efficiency_score = round(50 * (1 - (llm_ratio + ev_ratio) / 2))
```

若某维度超限则该评测记 0，不进入效率分计算。

## 8. 需要的平台改动

### 8.1 noj-llm-gateway（必需）

1. **精确 billed-token 结算**：
   - 解析上游 `usage.prompt_tokens_details.cached_tokens`（OpenAI 兼容字段），其他 Provider 按可用的缓存字段适配；
   - `billed_prompt_tokens = max(0, prompt_tokens - cached_tokens)`;
   - `billed_total = billed_prompt_tokens + completion_tokens`;
   - 用 `billed_total` 计入 submission token 上限、配额与成本。
2. **OpenAI 兼容超限错误**：
   - 当单次提交 `max_calls` / `max_tokens` 超限时，返回形如：
     ```json
     {
       "error": {
         "message": "Out of usage for this evaluation",
         "type": "invalid_request_error",
         "code": "out_of_usage"
       }
     }
     ```
   - 现有非 OpenAI 兼容错误可保留用于非超限错误，但 Agent 评测应能识别 `out_of_usage`。

### 8.2 noj-core

- 题目必须满足现有 LLM 调用题的前置配置，否则 judge 不会向 evaluator 注入 `NOJ_LLM_*`，`llm_complete` 无法工作：
  - `type` 为 P（或审核通过的官方题），且题目配置包含 `llm.provider_id` / `llm.model`；
  - `runtime_config.evaluator.network.enabled = true`；
  - 管理后台存在启用状态的对应 Provider；
- 题目/提交侧：需要确认/扩展“该题允许 evaluator 将 LLM 能力暴露为普通 capability 给 solution”的配置语义；若现有权限模型默认禁止普通用户题启用 LLM，则沿用 P 型限制即可。
- 竞赛提交禁用 BYOK：在竞赛创建评测任务时不使用用户 BYOK provider；本题统一平台 Provider。
- `eval_token` 签发时按 6.1 写入 `max_calls`/`max_tokens`（Agent 额度 + judge 保留），不沿用默认值。
- 若需要运营在后台配置剧本池，现阶段非必需（剧本在支持包内）。

### 8.3 noj-judge / 双容器协议

- 现有 `call_capability` 已支持 Solution→Evaluator；
- 需验证 capability handler 内调用 `llm.complete`（出站 HTTP）无死锁/无协议冲突；
- 若能力不足，补充“Solution 侧调用 Evaluator 侧能力期间 evaluator 仍可调用上游 LLM”的支持（不应触发双向 RPC 死锁）。

### 8.4 SDK / 支持包模板

- 提供“法庭推理题”支持包模板（scenario_runner + evaluate.py 骨架 + 示例剧本）；
- 提供 `scenarios/` 自动发现、随机抽取、校验唯一可解的工具函数（可在模板内实现）；
- 提供 LLM-as-judge prompt 模板与解析函数。

### 8.5 文档

- 出题人文档：如何编写 Scenario class、如何上传支持包、如何本地验证；
- 做题人文档：提交 `main.py` 需要实现什么入口、如何调用 capabilities、预算规则。

## 9. 验证方案

### 9.1 本地/评测链验证

1. 用示例剧本跑通 `evaluate.py`：
   - 正确 Agent 应能 5 轮全对、final_verdict 正确、拿到满分；
   - 故意选错几次应能重试并在预算内完成；
   - 证据查询超过 2/3 应触发 0 分；
   - LLM 轮次超限应触发 0 分；
   - 反驳错误超过独立上限应触发 0 分（验证不能靠穷举过关）；
   - LLM-as-judge 应能稳定给理由分。
2. 验证 `call_capability("llm_complete", ...)` 在真实双容器中工作，且 evaluator 可同时维护审判状态与出站 LLM 调用。
3. 验证 gateway billed-token 结算：mock 上游返回 `prompt_tokens_details.cached_tokens`，确认计数与超限按 billed 计算。

### 9.2 公平性验证

- 同一 Agent 跑剧本池多个剧本，分数分布差异应小（难度相近）；
- 不同水平 Agent（弱/中/强）在同一剧本上分数应拉开；
- 预算参数（LLM 30 次/证据 2/3/20k token/反驳错误 3 次）需实测校准。

## 10. 风险与开放问题

| 风险/问题 | 说明/对策 |
|---|---|
| capability handler 内调 `llm.complete` | 理论为出站 HTTP，不应死锁；需 E2E 实测；若协议限制，则需调整 evaluator 内部调用方式 |
| LLM-as-judge 稳定性 | 使用低温度、结构化输出、参考 reasoning_points；失败时保守给分；必要时可多次采样取稳 |
| 同一预算内 judge 与 Agent 竞争 | 预留 judge 预算或失败保守给分 |
| 剧本难度校准 | 首版人工维护小剧本池；后续可工具化校验 |
| 随机抽剧本可能造成个别运气 | 依赖剧本池难度校准；竞赛可通过多次提交/排名机制缓解 |
| 证据查询“2/3”语义 | 按证据数动态计算；若证据含无关干扰项，应保证关键证据可达且 2/3 够用 |
| 是否泄露剧本/证据 | 支持包不发给用户；details 不输出完整剧本与关键答案；LLM 调用日志需脱敏控制 |

## 11. 里程碑建议

1. **P0 概念验证**：手写 1 个剧本 + evaluate.py + 参考 Agent，本地跑通全流程（可先不接真实 LLM）；
2. **P1 平台打通**：实现/验证 `llm_complete` capability 链路、gateway billed-token、`out_of_usage`；
3. **P2 模板化**：沉淀 Scenario class 模板、校验工具、LLM-as-judge 模板、出题文档；
4. **P3 题目上线**：编写 3–5 个难度相近剧本，接入真实竞赛/练习并校准参数。

## 12. 参考

- 《魔法少女的魔女审判》直播/二次创作指南：仅借鉴机制，不使用其角色/文本/世界观（详见 Bilibili 官方指南转载与 4Gamer 报道）。
- NOJ 现有文档：统一题目包、Web 题目编辑器、Evaluator SDK / Solution SDK、LLM 调用题、评测镜像与运行时。
