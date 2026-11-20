# Agent Note: 知识图谱 P1 题目挂载、审核与 AI 打标（含成本控制）

Status: implemented

## Problem

P0 只有图谱本身；题目还不能挂知识点。P1
要让题目被归类：人工挂载为基础能力（不依赖 AI），AI 打标为可选加速，且 LLM
调用按 token 计费，必须可预期、可封顶、不泄露隐藏数据。

## Decision

- 表 `problem_knowledge`（每题至多一个有效主知识点，部分唯一索引）与
  `knowledge_tag_runs`（打标记录：hash、模型、token、状态）；审计 action 增加
  `knowledge.mapping.*`（`audit_logs` CHECK 约束同步迁移）。
- 人工挂载：题目编辑权限或实例管理员；整体替换为 `source=human`，AI
  不覆盖。审核队列：通过 / 驳回 / 修改。比赛保护期内不暴露知识点。
- 网关新增 `POST /internal/platform-completions`（用途白名单仅
  `knowledge.tag`、`max_tokens` 上限、alias `platform.tagger`）与
  `GET /internal/platform-usage`；`llm_usage` 增加 `principal_type` /
  `principal_id`，平台用量与学生额度分开记账。Provider Key 仍只在网关。
- AI 打标任务 `knowledge.tag`：发布新版本时经 runtime 入队（不 import
  功能代码）；开关关闭、内容 hash
  未变、已有人工挂载均不调用；调用前按自然月用量对比
  `knowledge_ai_monthly_token_budget`，超额记 `budget_paused`
  并延后到下月；用量查询失败则报错退避，不绕过预算；非法输出重试一次后失败，题目保持未归类。
- 成本控制：system 提示词为固定指令 + 节点 `id 名称`（不含
  summary，逐字节稳定以命中提示词缓存），user
  提示词仅标题、题型、截断的题面与公开样例；`max_tokens` 300、`temperature`
  0。存量回填须先预估（题数、token、费用）并带 `expected_count` 确认，偏差超 10%
  返回 409。
- 默认仅在低峰时段（北京时间 00:30–08:30，可配置 `knowledge_ai_offpeak_only` /
  `knowledge_ai_offpeak_window`，支持跨零点）调用模型：时段外任务顺延到下一时段开始，发布投递与回填直接以下一时段为可执行时间。
- 配置只登记实际读取的项：`knowledge_ai_tagging_enabled`（默认关）、`knowledge_auto_accept_threshold`、`knowledge_ai_monthly_token_budget`。
- 前端：编辑页知识点选择器、题目页知识点标签、后台「知识图谱」页（用量与预算、回填预估与确认、审核队列）；总开关关闭时整块隐藏。未做图谱可视化（暂缓）。

## Alternatives considered

- 网关侧另存一套按用途预算：与 core 配置重复，改为 core 调用前查询网关用量判断。
- 提示词带节点 summary：输入约 13–15k token，改为仅 id + 名称（约 6k）。
- 开启 AI 时自动回填全部存量：可能产生意外费用，改为预估后人工确认。

## Consequences

- 已验证：knowledge 域测试 65 通过、problems 319、网关全量 204、core platform
  238、noj-ui 单元 346 与组件 440 通过；门禁通过。测试均 mock
  模型调用，未发起真实网络请求。
- 未在真实模型上验证打标质量；上线前应在小批题目上人工抽查准确率并据此调整阈值与提示词（`prompt_version`）。
