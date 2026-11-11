## Context

See `proposal.md` for the motivation. 相关现状：

- 标签：`tags` +
  `problem_tags`（`noj-core/src/shared/db/schema/catalog.ts`），扁平、`kind ∈ {problem, algorithm}`，
  `algorithm` 类通过题目后才可见。
- 难度：`problems.difficulty` 文本三档，出题人填写。
- 版本：题目以「草稿 →
  不可变版本」发布（`modules/problems/services/versioning/publish.ts`）。
- 成绩：`submissions.effective_attempt_id` 物化有效成绩，比赛另有
  `contest_effective_attempt_id`。
- 后台任务：`modules/runtime/tasks`，`TASK_TYPES` 枚举 + handler
  注入，带租约与重试。
- LLM：core 通过 `modules/platform/gateway`
  管理网关；网关的模型调用只接受评测发放的 eval_token， **core
  目前没有系统级发起模型调用的通道**。

## Goals / Non-Goals

**Goals:**

- 图谱由平台统一维护，可评审、可回溯、可随版本发布。
- 每道已发布题目在无人工干预时也能自动获得可用的知识点与难度。
- 学习者能按知识点「从易到难」练完一类题，并看到自己在整张图上的掌握情况。
- 出题方能看到题库在图谱上的覆盖缺口。

**Non-Goals:**

- 不允许各域自定义或扩展图谱（后续如需要再引入「域内别名/隐藏」，不改节点）。
- 不替换现有 `tags`、`trainings`；不改变评测与有效成绩语义。
- 第一版不做 IRT/知识追踪（BKT/DKT）等复杂学生模型；先用可解释的规则。
- 不做 AI 解题提示/助教（另行立项）。

## Decisions

### 1. 图谱即代码：仓库 YAML 是唯一真相源

图谱放在 `noj-core/data/knowledge-graph/`，按领域分文件：

```yaml
# noj-core/data/knowledge-graph/ml-foundations.yaml
area: ml-foundations
name: 机器学习基础
nodes:
  - id: ml.linear-regression # 稳定 ID，发布后永不复用
    name: 线性回归
    summary: 最小二乘、梯度下降求解、MSE 评估
    syllabus: [ioai, noai] # 对应考纲，可选
    requires: [math.gradient, data.train-test-split]
  - id: ml.regularization
    name: 正则化
    requires: [ml.linear-regression]
```

- `deno task knowledge:check` 校验：ID 唯一、`requires` 无悬挂、整体为
  DAG、每个领域非空；CI 强制。
- `deno task knowledge:import`（纳入 `dev-setup` 与生产 `init`）幂等同步到
  DB；删除节点只能标记 `deprecated` 并指定 `replaced_by`，已有挂载自动迁移。
- 图谱变更走 PR，天然具备评审、历史与回滚；不提供在线编辑 UI。

备选：后台在线编辑。放弃原因：平台单点维护，评审与版本化比编辑体验更重要，且避免多副本缓存失效问题。

### 2. 数据模型

| 表                       | 关键字段                                                                                                                                             | 说明                                 |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------ |
| `knowledge_nodes`        | `id`, `area`, `name`, `summary`, `syllabus[]`, `status(active/deprecated)`, `replaced_by`, `sort`                                                    | 平台级，无 `domain_id`               |
| `knowledge_edges`        | `from_id`, `to_id`（to 依赖 from）                                                                                                                   | 仅前置关系                           |
| `problem_knowledge`      | `problem_id`, `node_id`, `role(primary/secondary)`, `source(ai/human)`, `confidence`, `version_id`, `review_status(auto/pending/confirmed/rejected)` | 每题恰好 1 个 primary                |
| `problem_difficulty`     | `problem_id`, `prior`(0–100, AI), `calibrated`(0–100), `sample_size`, `updated_at`                                                                   | 与 `problems` 分表，避免热更新锁主表 |
| `knowledge_tag_runs`     | `problem_id`, `version_id`, `model`, `prompt_version`, `raw_output`, `status`, `cost`                                                                | 审计与复现                           |
| `user_knowledge_mastery` | `user_id`, `node_id`, `state(none/learning/mastered)`, `solved_count`, `max_difficulty`, `updated_at`                                                | 物化，供图谱页直接读取               |

所有新增列遵守三步式迁移规则；通过 `deno task db:generate` 生成。

### 3. AI 打标流程

触发：题目发布新版本后投递
`knowledge.tag`（target=problem，同题去重，只处理最新版本）。

输入（严格白名单）：题型、标题、题面、公开样例、评测模式；评测器/参考解只取**截断后的源码摘要**。
隐藏测试数据与任何用户提交一律不发送。候选集为全部 active 节点的
`id + name + summary` （预计 ≤300
节点，单次上下文可容纳；超过后改为「先选领域、再选节点」两段式）。

输出：JSON Schema 约束

```json
{
  "primary": "ml.regularization",
  "secondary": ["ml.linear-regression"],
  "confidence": 0.86,
  "difficulty": 55,
  "rationale": "要求在 Ridge/Lasso 间选择并调参……"
}
```

校验：节点必须存在且 active、secondary ≤3 且不含
primary；否则重试一次后标记失败进入审核。

落库规则：

- 已有 `source=human` 的挂载**不被覆盖**；AI
  结果仅作为「建议差异」进入审核队列。
- `confidence ≥ 阈值`（系统设置，默认 0.75）→ `review_status=auto`
  直接生效；否则 `pending`， 在平台审核前仍展示但标注「待确认」。
- 记录 `prompt_version` 与模型名，改 prompt 后可选择性重跑。

回填：`noj-cli` / 管理 API 触发批量投递，按任务队列限速，复用网关 RPM/TPM 限流。

### 4. 网关平台用途调用

网关新增 `POST /internal/platform-completions`，仅接受 core
的内部服务凭据（与现有 `/internal/*` 同一鉴权）。 请求必须带
`purpose`（第一版只允许 `knowledge.tag`），用量计入独立的 `platform`
额度主体并写审计。 模型通过现有 model alias 配置（新增 alias
`platform.tagger`），平台未配置时任务直接跳过并在覆盖度面板提示。

备选：core 直连 Provider。放弃原因：违背「Provider Key 只在网关」的安全模型。

### 5. 难度：AI 先验 + 数据校准

- `prior`：AI 给出的 0–100 知识点内相对难度。
- 数据信号
  `d_data`：基于有效成绩，`1 − 达标人数 / 尝试人数`，并用平均尝试次数做微调，映射到
  0–100。
- `calibrated = (k·prior + n·d_data) / (k + n)`，n 为尝试人数，k
  为先验强度（默认 20）。
- `knowledge.calibrate`
  定时任务（每日）按批次重算；有效成绩变更时不实时重算，避免写放大。
- 现有 `difficulty` 三档改为由 `calibrated` 派生显示；出题人填写值仅作为无
  AI、无数据时的回退。

「达标」定义：题目有效得分 ≥ 题目及格线。客观题套卷为满分；其余题型默认满分的
60%，
出题人可在题目元数据覆盖。该定义与题单「score>0」相互独立，不修改题单语义。

### 6. 掌握度与学习路径

规则（可解释、可配置）：

- `learning`：该节点下（primary）有任一题达标。
- `mastered`：达标题数 ≥ K（默认
  3），且其中至少一题难度位于该节点题目难度的上三分之一； 节点题量 < K
  时降为「全部达标」。
- 只统计练习有效成绩与已结束比赛的成绩；进行中的比赛成绩不计入，避免泄露保密题。

`knowledge.mastery` 任务在有效成绩变更后按 (user, node)
去重投递，增量更新物化表。

推荐：

- **前沿节点**：所有前置已 `mastered`、自身未 `mastered`
  的节点；前置为软约束，不锁题。
- **下一题**：在节点阶梯中，选难度略高于用户已达标最高难度、且未达标的第一题。
- 阶梯只包含用户**当前可访问**的题目（域访问政策 + 已发布 +
  非保密保护），跨域题目以 `/d/<域>/…` 链接呈现。

### 7. 可见性

- 知识点在练习场景对所有可见题目公开（用户本就是按知识点主动选题，无剧透问题）。
- 题目处于进行中比赛或比赛保密保护期时：题目页不展示知识点，不出现在任何节点阶梯与统计中。
- `algorithm` 类标签维持「通过后可见」，与知识点相互独立。

### 8. 缓存与多副本

图谱节点/边为只读且只随部署变化：允许进程内缓存，TTL 10 分钟，在
`dev-docs/engineering/domain-boundaries.md` 登记。掌握度、难度一律读
DB，不做进程内缓存。

## Risks / Trade-offs

- **AI 误标** → 置信度阈值 + 审核队列 + 人工优先；覆盖度面板展示「待确认」比例。
- **节点粒度不当**（过粗无指导意义、过细题量不足）→ 首版控制在 150–250
  节点，以题量统计驱动后续拆并。
- **冷启动题量不足** → 覆盖度面板直接暴露断层，作为出题优先级输入。
- **LLM 成本** → 每题每版本一次调用，内容不变（题面 hash 相同）的新版本跳过。
- **掌握度规则过于简单** →
  第一版以可解释为先，保留物化表结构以便后续替换为概率模型。

## Migration Plan

1. 发布 P0：图谱表与导入，不影响现有功能。
2. P1 上线后执行一次回填；低置信度结果集中审核。
3. P2/P3 依赖回填完成，前端按特性开关灰度。
4. 回滚：各期功能均为增量，关闭特性开关即可；表保留。

## Open Questions

- 首版图谱内容：建议由我依据 IOAI / NOAI
  公开考纲起草初稿，平台维护者评审后合入。
- 「达标」默认线 60% 是否合适，还是按题型分别设置？
- 是否需要在 noj-docs 公开整张图谱作为「学习大纲」页面？
