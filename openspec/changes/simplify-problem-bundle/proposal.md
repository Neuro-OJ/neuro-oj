## Why

题目包（Problem Bundle）的**文件布局**本身已经足够简单（`problem.json` +
`evaluate.py` + `statement.md` + 自由组织的测试数据），但 **manifest
语义、兼容层与校验实现**持续累积复杂度：

- **题型靠字段组合推断**：`is_objective`、`judge_type`、`submission_mode`、`llm`
  四个字段共同决定题型，导致大量互斥规则——客观题禁止 5 个字段、OI 禁止 4
  个字段、`is_objective` 与 `judge_type=oi` 互斥、`llm` 要求 evaluator
  网络、`prediction` 禁止 `llm`。`validateBundleManifest` 约 190
  行中相当一部分在处理这些组合。而服务端内部早已有明确的判别字段
  `ProblemDraftContent.kind`（`ai` / `oi` / `objective`），题包格式却没有对齐。
- **兼容层仍承担实际负载**：格式 1 P/U 包转换、`type` / `domain_id`
  剥离、`llm.provider_id` / `model` 容忍、Hydro `problem.yaml` 分支混在
  `parseBundleZip` 中。私有题源 `noj-problems` 22 道题里 **19 道仍是格式
  1**，导致 v1 转换路径无法删除。
- **校验实现两份**：`noj-cli/src/problem/vendor/` 下手工复制了
  `problem-bundle.ts`（523 行）、`bundle-parser.ts`（401 行）与
  `runtime-config-validate.ts`（issue #514 决策），再用 424 行共享 fixture
  契约测试兜底漂移。每次改规则都要「改两处 + 跑契约」。
- **`runtime_config` 样板多**：每道编程题都要完整写两个容器的
  `image`、时限、内存；实际题包中镜像几乎全部相同，真正按题调整的只有时限与内存。

结果是出题人要记住「哪些字段能一起出现」，导入报错只能逐条列出禁止字段；
维护者每改一条规则要同步两套实现与一份契约。

## What Changes

- **新增格式 3，用单一判别字段 `kind` 声明题型**：`"ai"`（双容器 AI 评测，含
  code / artifact / prediction / ui 提交模式）、`"oi"`（传统 C/C++
  测试点评测）、`"objective"`（客观题套卷）。取值与服务端
  `ProblemDraftContent.kind` 一致。每种 `kind`
  有独立的允许字段集合；出现不属于该 `kind`
  的字段时，用**同一条通用错误**拒绝并列出该 `kind` 支持的字段。
  **BREAKING**：格式 3 移除 `is_objective` 与 `judge_type`。
- **`runtime_config` 全字段可缺省**（仅 `kind: "ai"`）：缺省镜像为官方
  `noj-evaluator-python` /
  `noj-solution-python`，缺省命令、时限与内存取平台默认值；
  题包只需写与默认值不同的字段。导入时规范化为完整配置落库，数据库与评测链路不变。
- **声明 `llm` 即隐含开启 evaluator 网络**；只有显式 `network.enabled: false` 与
  `llm` 同时出现才报错。
- **未知顶层字段一律拒绝**（格式 3），以捕获拼写错误；已退役字段给出迁移提示。
- **校验单一事实来源**：题包 manifest 与 zip 结构校验抽到仓库根下零依赖目录
  `packages/problem-bundle/`，noj-core 与 noj-cli 以相对路径直接引用，删除
  `noj-cli/src/problem/vendor/` 副本与共享 fixture 契约测试。
- **兼容层收敛**：
  - `noj problem migrate` 将格式 1 / 2 题包重写为格式 3；`noj-problems`
    一次性迁移后，**删除格式 1 转换**。
  - 格式 2 在一个小版本内（v0.12 系列）继续接受并在导入结果中告警，之后删除。
  - Hydro 导入从 `parseBundleZip` 中拆出为独立导入器（入口按根级文件识别），
    行为不变，只是不再与统一题包解析交织。
- 同步更新 noj-docs 题目包规范、出题指南与 `noj problem init` 脚手架。

**不变**：zip 文件布局（`problem.json` / `evaluate.py` / `statement.md` /
`questions.json` / `testdata/` / `ui.html`）；测试数据格式不强制；ZIP
安全限制；`evaluate.py` 入口约定；数据库表结构；评测链路与 API 路径；题目
`is_objective` / `judge_type` 列及前端展示。

## Capabilities

### New Capabilities

- `problem-bundle`: 统一题目包 manifest 格式 3、题型判别、缺省规则、版本兼容策略
  与校验实现的单一事实来源。

### Modified Capabilities

<!-- 现有题目包行为未纳入 openspec/specs，本变更以 ADDED 方式完整描述格式 3。 -->

## Impact

- **noj-core**：`modules/problems/types/problem-bundle.ts`、
  `services/bundle-parser.ts` 迁入 `packages/problem-bundle/`；
  `problem-bundle-edit.ts` / `problem-bundle-import.ts` 改为消费 `kind`；Hydro
  解析独立成文件。按「改到即迁」原则，题目包导入相关代码同时迁入
  `features/`（是否在本变更内完成见 design.md 开放问题）。
- **noj-cli**：删除 `src/problem/vendor/`；`lint` / `pack` / `push` / `init`
  引用 `packages/problem-bundle/`；新增 `problem migrate` 子命令。
- **noj-problems（私有仓库）**：一次性运行 `noj problem migrate`，单独提交。
- **noj-docs**：`standards/problem-bundle.md` 与出题人指南全面改写为格式 3。
- **出题人**：格式 2 题包在 v0.12 系列中仍可导入（带告警）；格式 1 题包需先运行
  `noj problem migrate`。
- **noj-ui / noj-judge / noj-llm-gateway**：无改动。
