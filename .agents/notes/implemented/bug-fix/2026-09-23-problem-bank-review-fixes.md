# Agent Note: 题库（noj-problems）上线前审查缺陷修复

Status: implemented

## Problem

对 `noj-problems` 五道题（`trial-snowy-manor`、`bpe-tokenizer`、`decoding-sampler`、
`llm-metrics`、`rag-cited-qa`）做了题目质量、区分度、与主线（`main`）兼容性及实现
正确性审查，发现以下上线阻断/高风险问题：

1. `trial-snowy-manor` 的 `sdk_evaluate.py` 产出的 `details.cases[]` 缺少布尔
   `hidden` 字段，违反 `noj-core` 的提交结果投影契约（缺标记时竞赛场景整份
   `details` 被剥离）；且 `**breakdown` 覆盖 `score`，case 分与提交分量纲不一致。
2. 该题文档化的 `NOJ_TRIAL_*` 环境变量与 `scenario_id` 随机化依赖 judge 注入，
   但 judge 只注入 `NOJ_LLM_*`，导致种子恒为默认值、剧本恒定、`scenario_id` 随
   结果泄露给提交者，可"读一次 id → 硬编码答案重交"刷分。
3. 各剧本布局同型（`answer_pos` 全为 `[1,2,2,3,3]`、`answer_highlight` 多为 0），
   且未对"异构固定位置序列"做下界校验，存在跨剧本可复用的零推理位置规律。
4. `decoding-sampler`/`llm-metrics` 的隐藏用例失败信息泄露期望值/实际值（可逐例
   读出隐藏答案），与各自 README 及 `noj-docs` 测试数据规范矛盾。
5. `rag-cited-qa` 声明总时限 600s，超过 judge 默认硬上限 300s；拒答用例判分口径
   与题面"例如"措辞不一致；LLM judge 的注入过滤漏掉 `citations`；参考解存在死代码；
   构建期可检索性断言名义 top-6 实际按 top-20。
6. `noj-problems/scripts/validate_manifest.py` 仍要求 `llm.provider_id`/`model`
   并检查其占位符，与主线"LLM 能力与平台配置解耦"契约漂移，造成误导性 WARN。
7. 三道路编程题的"2000ms/用例"名义限制未真正生效（`runner.call` 未传
   `timeout_ms`），且单例超时会整份评测失败而非该用例 0 分。

## Decision

- **Judge 注入提交标识**：`noj-judge/src/dual/mod.rs` 的 `build_llm_env` 增补
  `NOJ_SUBMISSION_ID` 与 `NOJ_REJUDGE_SEQ`，使题目侧可做确定性随机（同提交重测
  一致、不同提交不同剧本）。
- **运行时选项重排**：`trial-snowy-manor/scenario_runner.py` 按
  `seed:round:highlight` 对每轮选项做确定性重排，消除"记住固定位置序列"；
  `get_trial_state` 展示顺序随之改变，但标注（`falsified_by`/`supported_by`）
  仍不下发。
- **结果契约修复**：`trial-snowy-manor/sdk_evaluate.py` 的 case 补 `hidden: false`
  与同量纲 `score`，分项移入 `breakdown`；`scenario_id` 改为加盐哈希
  `scenario_hash`（部署方可定位、玩家不可记忆）。
- **隐藏信息脱敏**：`decoding-sampler`/`llm-metrics` 的 `compare_case` 增加
  `verbose` 分档，隐藏用例失败原因不含期望/实际值；evaluate 入口按可见性传入。
- **时限一致性**：三道路编程题显式传 `timeout_ms=CASE_TIME_LIMIT_MS`，单例超时
  降级为该用例 `TimeLimitExceeded`（0 分）并继续评测。
- **RAG 修正**：`problem.json`/`statement.md` 总时限改 300s；题面明确拒答须给出
  文档总数；`citations` 纳入注入检测；删除参考解死代码；`validate()` 显式传
  `top_k=MAX_GOLD_RANK`。
- **契约同步**：`validate_manifest.py` 只校验 `llm` 预算字段，忽略
  `provider_id`/`model`；移除 `--strict` 占位符逻辑与 `problem.json` 占位符。
- **门禁补强**：`tools/build_scenarios.py --check` 真正比较生成结果与源文件；
  新增跨种子重排回归、`hidden` 契约与泄露防护测试。

## Alternatives considered

- **靠调小 `max_wrong_rebuttals` 封堵固定位置序列**：会同时压缩正常选手的容错，
  且不能覆盖跨剧本记忆；选项重排更彻底且对选手透明。
- **让 judge 在容器创建时注入自定义 `NOJ_TRIAL_*`**：改动面更大且需新增契约；
  复用已有的 `build_llm_env` 注入点最小侵入。
- **隐藏用例失败一律不给原因**：会严重损害调试体验；采用 BPE 已有的 `verbose`
  分档，兼顾脱敏与可读。
- **保留 `provider_id`/`model` 必填并继续 WARN**：与主线解耦契约冲突，误导出题人；
  改为忽略未知键。
- **删除 `scenario_id` 且不提供替代**：部署方将无法定位提交抽到的剧本；加盐哈希
  同时满足去标识化与可运维性。

## Consequences

- 题目侧 `NOJ_TRIAL_SOLVE_ENTRY` 等变量仍由题目自身读取（judge 不注入），文档已
  明确其仅"另行注入时生效"，缺省即题面行为。
- `trial-snowy-manor` 的固定位置序列静态下界（`min_fixed_sequence_wrong`）在多数
  剧本仍 ≤ 错误上限，防线由"运行时重排"承担，`verify_scenarios.py` 对此给出 WARN
  并有 `tests/test_adversarial.py` 跨种子回归。
- 自适应试错（每轮借反馈）仍是已知残余面，由每次错误扣 100 分定价，非漏洞。
- 五道题隐藏用例数量增加（BPE 34→36、decoding 22→25、llm-metrics 38→42），
  README 计数已同步。
- `noj-problems` 与其 CI 的 manifest 校验不再报占位符 WARN；`problem.json` 不含
  部署期 UUID。
