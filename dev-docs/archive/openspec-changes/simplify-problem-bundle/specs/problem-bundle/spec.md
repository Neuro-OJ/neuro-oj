## Purpose

规定统一题目包 manifest 的格式 3：以单一字段判别题型、可缺省的运行配置、
旧格式的自动转换策略，以及 noj-core 与 noj-cli 共用的唯一校验实现。

## ADDED Requirements

### Requirement: Problem kind is declared by a single discriminator

格式 3 manifest SHALL 包含 `kind` 字段，取值为 `ai`、`oi` 或 `objective` 之一。
系统 SHALL 仅根据 `kind` 决定题型，并 SHALL NOT 接受 `is_objective` 或
`judge_type` 字段。

#### Scenario: Minimal AI problem manifest

- **WHEN** 题包根级包含 `evaluate.py`、`statement.md`，且 `problem.json` 为
  `{"format_version": 3, "kind": "ai", "title": "A+B"}`
- **THEN** 导入成功，题目为双容器 AI 评测题，提交模式为 `code`

#### Scenario: Legacy discriminator in format 3 is rejected

- **WHEN** 格式 3 manifest 包含 `is_objective` 或 `judge_type`
- **THEN** 导入以 HTTP 400 拒绝，并提示改用 `kind`

#### Scenario: Missing or unknown kind is rejected

- **WHEN** 格式 3 manifest 缺少 `kind` 或其值不是 `ai` / `oi` / `objective`
- **THEN** 导入以 HTTP 400 拒绝，并列出允许的取值

### Requirement: Each kind has a closed field set

每个 `kind` SHALL 定义允许的题型专属字段集合；通用字段为 `format_version`、
`kind`、`title`、`description`、`number`、`difficulty`、`tags`、`samples`。 格式
3 manifest 中出现不属于「通用字段 ∪ 该 kind 专属字段」的顶层字段时，系统 SHALL
以 HTTP 400 拒绝，错误信息 SHALL 指明该字段并列出该 `kind` 支持的全部字段。

#### Scenario: Field not supported by kind

- **WHEN** `kind` 为 `objective` 的 manifest 包含 `template`
- **THEN** 导入以 HTTP 400 拒绝，错误信息包含 `template` 与 objective
  支持的字段列表

#### Scenario: Typo in field name

- **WHEN** 格式 3 manifest 包含未定义字段 `dificulty`
- **THEN** 导入以 HTTP 400 拒绝并指明 `dificulty` 为不支持字段

### Requirement: AI runtime configuration has platform defaults

对 `kind: "ai"`，`runtime_config` 及其每个字段 SHALL 可缺省。系统 SHALL
在导入时用平台缺省值补全为完整配置后再校验与保存：时限、内存与命令为固定值；
缺省镜像 SHALL 为导入平台的官方评测镜像（名称由部署的镜像仓库前缀决定）。
`submission_mode` 为 `prediction` 时 SHALL NOT 补全 `solution`。

#### Scenario: Only time limit overridden

- **WHEN** manifest 仅声明 `runtime_config.evaluator.time_limit_ms: 180000`
- **THEN** 保存的配置中 evaluator 时限为 180000，其余字段均为平台缺省值

#### Scenario: Default image not on allowlist

- **WHEN** manifest 省略镜像，且平台镜像白名单未登记缺省镜像
- **THEN** 导入或发布以与显式声明未登记镜像相同的错误拒绝

### Requirement: LLM declaration implies evaluator network

当 `kind: "ai"` 的 manifest 声明 `llm` 时，系统 SHALL 将 evaluator
网络缺省为开启。 若同时显式声明
`runtime_config.evaluator.network.enabled: false`，系统 SHALL 以 HTTP 400 拒绝。

#### Scenario: LLM without explicit network

- **WHEN** manifest 声明 `llm: {"max_calls": 10}` 且未声明网络配置
- **THEN** 导入成功，保存的 evaluator 网络为开启

#### Scenario: Conflicting network declaration

- **WHEN** manifest 同时声明 `llm` 与 `evaluator.network.enabled: false`
- **THEN** 导入以 HTTP 400 拒绝并指出两者冲突

### Requirement: Older formats remain importable via automatic conversion

系统 SHALL 将格式 2 manifest 与声明 `type: "P"` 的格式 1 manifest 按固定规则
转换为格式 3 后导入，并在导入结果中返回升级告警（含 `noj problem migrate`
指令）；本变更不设旧格式删除时间点。导入期转换与 `noj problem migrate` SHALL
使用同一转换实现，且转换 SHALL NOT 写入任何平台缺省值。

#### Scenario: Format 2 bundle

- **WHEN** 导入 `is_objective: true` 的格式 2 题包
- **THEN** 导入成功，题目为客观题套卷，结果包含升级到格式 3 的告警

#### Scenario: Format 1 P bundle

- **WHEN** 导入 `format_version: 1`、`type: "P"` 的题包
- **THEN** 导入成功并给出包含 `noj problem migrate` 的升级告警

#### Scenario: CLI migration rewrites manifest

- **WHEN** 出题人对格式 1 或格式 2 题目目录运行 `noj problem migrate`
- **THEN** `problem.json` 被改写为语义等价的格式 3，且移除已退役字段

### Requirement: Bundle validation has a single implementation

noj-core 导入与 noj-cli 的 `lint` / `pack` / `push` / `migrate` SHALL 使用同一份
题目包校验实现（noj-cli 以相对路径直接引用 noj-core 源码）。仓库中 SHALL NOT
存在题目包校验逻辑的副本。

#### Scenario: Offline lint matches server import

- **WHEN** 某题包在 `noj problem lint` 中通过校验
- **THEN** 同一题包在服务端导入时不会因 manifest 或 zip 结构校验失败

### Requirement: Hydro archives keep their import behavior

根级含 `problem.yaml` 的 Hydro 归档 SHALL 继续可导入，并 SHALL 规范化为
`kind: "oi"` 的格式 3 manifest，导入结果与本变更前一致。

#### Scenario: Hydro archive import

- **WHEN** 上传根级含 `problem.yaml` 与 `problem.md` 的 Hydro OI 归档
- **THEN** 导入为 `oi` 题目，行为与变更前一致
