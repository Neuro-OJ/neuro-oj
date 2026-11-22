## Purpose

为 Neuro OJ 提供可评审、可版本化的 AI
竞赛知识图谱：题目关联知识点与难度，学习者按知识点从易到难系统练习并查看掌握情况，教练按知识点查看班级掌握分布并布置作业。

## ADDED Requirements

### Requirement: Instance uses one versioned knowledge graph content pack

实例 SHALL 在任一时刻只启用一个图谱内容包。官方内容包 SHALL
随仓库发布并作为默认值；实例管理员 SHALL 能导入自定义内容包整体替换，或导入声明
`extends` 的扩展包在被扩展包之上追加节点与前置边。图谱 SHALL 为有向无环图，节点
ID 稳定且不复用。工作空间（域）SHALL NOT 创建、修改或删除节点。

#### Scenario: Official pack is the default

- **WHEN** 新实例完成初始化
- **THEN** 官方内容包被导入并生效，记录其 `id@version`

#### Scenario: Invalid graph is rejected before import

- **WHEN** 内容包存在重复 ID、悬挂的前置引用或环
- **THEN** 校验失败并指出具体节点，导入不执行；官方包的此类错误使 CI 失败

#### Scenario: Extension pack cannot modify base nodes

- **WHEN** 扩展包定义的节点 ID 与被扩展包中的节点冲突
- **THEN** 导入失败并指出冲突节点，当前生效的图谱不变

#### Scenario: Replacing a pack keeps existing mappings recoverable

- **WHEN** 实例导入新内容包，旧包中的某些节点在新包中不存在
- **THEN** 这些节点被标记为
  deprecated（不删除），其上的题目挂载保留但不展示，并列入「失效挂载」清单；指定了
  `replaced_by` 的节点挂载自动迁移到替代节点

### Requirement: The feature can be disabled per instance

实例 SHALL 提供知识图谱总开关。关闭时 SHALL 隐藏全部知识点相关界面与
API，相关后台任务 SHALL 直接成功结束且不产生副作用；重新开启后数据保持完整。

#### Scenario: Disabled instance hides everything

- **WHEN** 实例管理员关闭知识图谱功能
- **THEN** 图谱页、节点页、题目页知识点、覆盖度面板与班级热力图均不可访问，相关
  API 返回未启用错误，其余功能不受影响

### Requirement: Every published problem is classified or explicitly unclassified

每道已发布题目 SHALL 处于「已归类」或「未归类」两种状态之一。已归类题目 SHALL
恰好有一个主知识点与至多三个次要知识点，并记录来源（AI
或人工）、置信度、审核状态及依据的题目版本；审核状态为「待确认」的挂载计为已归类，界面标注「待确认」。人工挂载
SHALL 优先于 AI 结果且不被 AI 覆盖。具备题目编辑权限的出题人与实例管理员 SHALL
能人工挂载与修改知识点，不依赖 AI。

未归类（没有主知识点）SHALL 仅在以下情况出现：AI
打标未开启或未配置模型且无人工挂载；打标任务排队中或失败；AI
结果被驳回且尚未人工补挂。未归类题目 SHALL NOT
进入节点阶梯、推荐、掌握度计算与难度分档统计，并 SHALL
列入覆盖度面板的「未归类」清单。

#### Scenario: Manual mapping works without AI

- **WHEN** 实例未开启 AI 打标，出题人在题目编辑页为题目选择主知识点
- **THEN** 题目立即变为已归类（来源为人工），进入对应节点阶梯

#### Scenario: Unclassified problem is excluded until mapped

- **WHEN** 题目已发布但没有主知识点
- **THEN**
  题目照常可作答，但不出现在任何节点阶梯、推荐与掌握度统计中，并出现在覆盖度面板「未归类」清单

#### Scenario: Human mapping is preserved

- **WHEN** 题目已有人工挂载，AI 对新版本给出不同结果
- **THEN** 人工挂载保持生效，AI 结果仅作为建议差异进入审核队列

### Requirement: AI tagging is opt-in and keeps problem content private

AI 打标 SHALL 默认关闭，仅在实例管理员显式开启且配置打标模型后运行。模型 SHALL
只能从当前生效图谱的 active 节点中选择。发送给模型的内容 SHALL
仅限题型、标题、题面、公开样例、评测模式与评测器/参考解截断摘要。打标模型 SHALL
可配置为任意 OpenAI 兼容地址（含内网本地模型）。

#### Scenario: AI tagging is off by default

- **WHEN** 新实例未修改配置时发布题目
- **THEN** 不投递打标调用，题目保持未归类直至人工挂载

#### Scenario: New version triggers AI tagging when enabled

- **WHEN** AI 打标已开启且模型已配置，题目发布了内容变化的新版本
- **THEN**
  系统投递打标任务，结果通过校验后按置信度写入挂载（不低于阈值直接生效，否则标记待确认）

#### Scenario: Enabling AI tagging backfills unclassified problems

- **WHEN** 实例管理员开启 AI 打标并配置模型
- **THEN** 系统为全部未归类题目投递打标任务，已有人工挂载的题目不受影响

#### Scenario: Low-confidence or invalid output requires review

- **WHEN** AI 打标置信度低于阈值，或输出未通过校验
- **THEN**
  挂载进入审核队列，实例管理员可接受、修改或驳回；校验失败时题目保持未归类

#### Scenario: Hidden data is never sent to the model

- **WHEN** 系统为题目构造打标请求
- **THEN** 请求不包含隐藏测试数据或任何用户提交

### Requirement: Platform LLM calls go through the gateway

core 发起的系统级模型调用 SHALL 通过 LLM
网关的内部平台调用端点完成，携带用途标识，计入独立的平台额度并写审计；core SHALL
NOT 持有或直接使用 Provider Key。

#### Scenario: Tagging is skipped when no model is configured

- **WHEN** AI 打标已开启但未配置打标模型别名
- **THEN** 打标任务成功结束且不产生挂载，题目保持未归类，覆盖度面板提示未配置

### Requirement: AI tagging cost is bounded and visible

AI 打标的模型调用成本 SHALL 可预期、可封顶、可查看：系统 SHALL
为打标用途设置月度 token / 金额预算并在超额时暂停调用；SHALL
限制单次调用的输入规模（候选知识点仅含 ID
与名称、题面等输入有长度上限、输出长度受限）；题目内容未变化或已有人工挂载时
SHALL NOT 调用模型；存量回填前 SHALL
向实例管理员展示预计调用量与费用并经确认后才执行。

#### Scenario: Monthly budget exhausted

- **WHEN** 本计费周期打标用途的用量达到预算上限
- **THEN**
  后续打标任务不再调用模型，以「预算暂停」状态延后，题目保持未归类，后台显示预算已用尽；预算调高或进入下一周期后自动恢复

#### Scenario: Backfill requires a cost estimate

- **WHEN** 实例管理员开启 AI 打标且存在未归类的存量题目
- **THEN** 系统先展示待打标题数、预计 token 与费用，管理员确认后才投递回填任务

#### Scenario: Unchanged content is not re-tagged

- **WHEN** 题目发布的新版本与上次打标时的内容 hash 相同
- **THEN** 不调用模型，沿用已有挂载

### Requirement: Problem difficulty is calibrated from data

系统 SHALL 为每道题维护 0–100 的连续难度分：以 AI 先验冷启动（无 AI
时以出题人三档难度映射为先验），并随尝试人数增加按提交达标数据校准。现有三档难度
SHALL 由连续难度分派生展示。

#### Scenario: Prior dominates with few attempts

- **WHEN** 题目尝试人数远小于先验强度
- **THEN** 校准难度接近先验

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

### Requirement: Knowledge nodes may link an explanation document

节点 SHALL 可选地关联内容包中的一篇讲解文档；存在时节点页 SHALL
渲染该讲解并在末尾引导到阶梯第一题，不存在时节点页 SHALL 正常显示且不报错。

#### Scenario: Node without explanation

- **WHEN** 用户打开未关联讲解的节点
- **THEN** 节点页显示节点简介与题目阶梯，不显示讲解区块

### Requirement: Coaches see class mastery and assign by knowledge node

班级的教学人员 SHALL 能查看班级成员 × 知识点的掌握状态矩阵，并 SHALL
能按知识点与题数从阶梯中挑选本域可访问的题目生成作业题目列表。非该班级教学人员
SHALL NOT 查看该班级矩阵。

#### Scenario: Heatmap is restricted to teaching staff

- **WHEN** 非该班级教学人员请求班级掌握矩阵
- **THEN** 请求被拒绝

#### Scenario: Assignment generated by knowledge node

- **WHEN** 教练选择某知识点并指定题数布置作业
- **THEN**
  系统按难度从易到难挑选本域可访问、非保密保护的题目，生成普通作业的题目列表

### Requirement: Contest-protected problems are excluded

处于进行中比赛或比赛保密保护期的题目 SHALL NOT 展示知识点，SHALL NOT
出现在节点阶梯、推荐、作业挑题、掌握度计算与覆盖度统计中。

#### Scenario: Protection ends

- **WHEN** 题目的比赛保护结束
- **THEN** 题目自动出现在对应节点阶梯中，已结束比赛的有效成绩计入掌握度

### Requirement: Coverage gaps are visible to maintainers

系统 SHALL
为实例管理员与出题人提供覆盖度面板，列出题量不足、难度断层、未归类题目、待确认挂载与失效挂载。

#### Scenario: Node lacks hard problems

- **WHEN** 某节点下没有校准难度位于上三分之一的题目
- **THEN** 覆盖度面板将该节点标记为「难度断层」
