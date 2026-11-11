## Purpose

为 Neuro OJ 提供平台统一维护的 AI
知识图谱，使每道题目自动关联知识点与难度，学习者可按知识点从易到难系统练习并查看掌握情况。

## ADDED Requirements

### Requirement: Platform maintains a single versioned knowledge graph

系统 SHALL
以仓库内图谱源文件作为唯一真相源，导入为平台级知识点节点与前置边。图谱 SHALL
为有向无环图，节点 ID 稳定且不复用。工作空间 SHALL NOT 创建、修改或删除节点。

#### Scenario: Invalid graph is rejected before import

- **WHEN** 图谱源文件存在重复 ID、悬挂的前置引用或环
- **THEN** 图谱校验失败并指出具体节点，导入不执行，CI 失败

#### Scenario: Deprecated node migrates existing mappings

- **WHEN** 节点被标记为 deprecated 并指定 replaced_by
- **THEN** 导入后原节点上的题目挂载迁移到替代节点，原节点不再出现在图谱浏览与 AI
  候选集中

### Requirement: Every published problem is mapped to knowledge nodes

系统 SHALL
为每道已发布题目维护恰好一个主知识点与至多三个次要知识点，并记录来源（AI
或人工）、置信度及依据的题目版本。人工确认的挂载 SHALL 优先于 AI 结果且不被 AI
覆盖。

#### Scenario: New version triggers AI tagging

- **WHEN** 题目发布了内容变化的新版本且平台已配置打标模型
- **THEN** 系统投递打标任务，模型仅能从现有 active
  节点中选择，结果通过校验后写入挂载

#### Scenario: Low-confidence result requires review

- **WHEN** AI 打标置信度低于系统阈值，或输出未通过校验
- **THEN**
  挂载进入平台审核队列，界面标注「待确认」，平台管理员可接受、修改或驳回

#### Scenario: Human mapping is preserved

- **WHEN** 题目已有人工确认的挂载，AI 对新版本给出不同结果
- **THEN** 人工挂载保持生效，AI 结果仅作为建议差异进入审核队列

#### Scenario: Hidden data is never sent to the model

- **WHEN** 系统为题目构造打标请求
- **THEN**
  请求仅包含题面、公开样例、题型与评测器/参考解摘要，不包含隐藏测试数据或任何用户提交

### Requirement: Platform LLM calls go through the gateway

core 发起的系统级模型调用 SHALL 通过 LLM
网关的内部平台调用端点完成，计入独立的平台额度并写审计；core SHALL NOT
持有或直接使用 Provider Key。

#### Scenario: Tagging is skipped when no platform model is configured

- **WHEN** 平台未配置打标模型别名
- **THEN** 打标任务成功结束且不产生挂载，覆盖度面板提示未配置

### Requirement: Problem difficulty is calibrated from data

系统 SHALL 为每道题维护 0–100 的连续难度分：以 AI
先验冷启动，并随尝试人数增加按提交达标数据校准。现有三档难度 SHALL
由连续难度分派生展示。

#### Scenario: Prior dominates with few attempts

- **WHEN** 题目尝试人数远小于先验强度
- **THEN** 校准难度接近 AI 先验

#### Scenario: Data dominates with many attempts

- **WHEN** 题目尝试人数远大于先验强度
- **THEN** 校准难度主要由达标率决定

### Requirement: Learners see mastery and a ladder per knowledge node

系统 SHALL 按用户与知识点维护掌握状态（未开始 / 学习中 /
已掌握），并为每个节点提供按校准难度升序的题目阶梯与「下一题」推荐。阶梯 SHALL
只包含当前用户可访问的题目。

#### Scenario: Node becomes mastered

- **WHEN** 用户在某节点下达标题数达到阈值，且至少一道位于该节点难度上三分之一
- **THEN** 该节点状态变为已掌握，图谱页点亮该节点，其后继节点进入推荐前沿

#### Scenario: Next problem is slightly harder

- **WHEN** 用户在节点页请求下一题
- **THEN**
  系统返回难度略高于其已达标最高难度、且尚未达标的可访问题目；无此类题目时提示该节点已练完

#### Scenario: Prerequisites are advisory

- **WHEN** 用户打开前置未掌握的节点
- **THEN** 系统提示建议先学习的前置节点，但不阻止用户作答

### Requirement: Contest-protected problems are excluded

处于进行中比赛或比赛保密保护期的题目 SHALL NOT 展示知识点，SHALL NOT
出现在节点阶梯、推荐、掌握度计算与覆盖度统计中。

#### Scenario: Protection ends

- **WHEN** 题目的比赛保护结束
- **THEN** 题目自动出现在对应节点阶梯中，已结束比赛的有效成绩计入掌握度

### Requirement: Coverage gaps are visible to maintainers

系统 SHALL
为平台管理员提供覆盖度面板，列出题量不足、难度断层、待审核比例过高的知识点。

#### Scenario: Node lacks hard problems

- **WHEN** 某节点下没有校准难度位于上三分之一的题目
- **THEN** 覆盖度面板将该节点标记为「难度断层」
