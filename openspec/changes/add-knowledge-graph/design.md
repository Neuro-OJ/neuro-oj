## Context

See `proposal.md` for the motivation. 相关现状：

- 标签：`tags` + `problem_tags`（表在
  `noj-core/src/shared/db/schema/catalog.ts`，功能代码在
  `noj-core/src/features/tags/`），扁平、`kind ∈ {problem, algorithm}`，`algorithm`
  类通过题目后才可见。
- 难度：`problems.difficulty` 文本三档，出题人填写。
- 版本：题目以「草稿 →
  不可变版本」发布（`modules/problems/services/versioning/publish.ts`）。
- 成绩：`submissions.effective_attempt_id` 物化有效成绩，比赛另有
  `contest_effective_attempt_id`。
- 代码结构：core
  已采用功能切片（`openspec/changes/refactor-core-feature-slices`）。新功能放在
  `src/features/<name>/`，用 `defineFeature()` 声明路由、后台任务（类型须以
  `<name>.` 为前缀）、 worker 与观测，在 `src/features.ts` 登记一行；表定义放在
  `src/shared/db/schema/`；样例见 `src/features/trainings/`。
- 配置：运行时配置经 `src/shared/config/settings-registry.ts` 注册，DB
  持有、后台可热改。
- LLM：网关的模型调用只接受评测发放的 eval_token，**core
  目前没有系统级发起模型调用的通道**。
- 部署形态：开源项目，既有公共实例，也有学校/集训队自部署的内部训练实例（题库常为私有、规模小、
  可能不允许题面外发）。

## Goals / Non-Goals

**Goals:**

- 官方提供一套可评审、可回溯、随版本发布的 AI
  竞赛知识图谱内容包；实例可整体替换或扩展。
- 未启用 AI 时功能完整可用（人工挂知识点）；启用 AI 后新题自动获得知识点与难度。
- 学习者按知识点「从易到难」练完一类题，并看到自己在整张图上的掌握情况。
- 教练能看到班级在各知识点上的掌握分布，并按知识点布置作业。
- 出题方能看到题库在图谱上的覆盖缺口。

**Non-Goals:**

- 不允许单个域（工作空间）修改图谱；图谱是实例级的。
- 不替换现有 `tags`、`trainings`；不改变评测与有效成绩语义。
- 第一版不做 IRT/知识追踪（BKT/DKT）等复杂学生模型；先用可解释的规则。
- 不做 AI 解题提示/助教（另行立项）。
- 首版不提供在线编辑图谱的 UI（内容包走评审流程）。

## Decisions

### 1. 代码组织：`src/features/knowledge/`

```text
noj-core/src/features/knowledge/
├── index.ts          # defineFeature({ name: "knowledge", router, tasks }) + 对外出口
├── routes.ts         # 图谱/节点/阶梯/掌握度/覆盖度/审核 API
├── graph.ts          # 内容包加载、校验（DAG、悬挂、ID 唯一）、导入
├── tagging.ts        # knowledge.tag 任务：构造请求、校验输出、落库
├── difficulty.ts     # knowledge.calibrate 任务
├── mastery.ts        # knowledge.mastery 任务与推荐
├── coach.ts          # 班级热力图、按知识点挑题
├── *.test.ts
└── README.md
```

表定义在 `src/shared/db/schema/knowledge.ts`（并在 schema 聚合中导出）。

**与旧模块解耦**：题目发布、有效成绩变更发生在旧模块中。旧模块只经
`modules/runtime` 出口投递 `knowledge.tag` / `knowledge.mastery`
任务（任务类型是字符串约定），**不 import 本功能代码**，避免
`problems/evaluations ↔ knowledge`
运行时循环。功能关闭时任务处理器直接成功返回。

### 2. 内容包：官方默认，实例可替换或扩展

官方内容包放在 `noj-core/data/knowledge-graph/`，与代码分开授权与版本化：

```text
noj-core/data/knowledge-graph/
├── pack.yaml          # id: official, version: 2026.11.0, license: CC-BY-SA-4.0, extends: (无)
├── LICENSE            # CC BY-SA 4.0
├── areas/
│   └── ml-foundations.yaml
└── docs/              # 节点讲解（预留，见第 9 节）
    └── ml.linear-regression.md
```

```yaml
# areas/ml-foundations.yaml
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

- 校验：ID 唯一、`requires` 无悬挂、整体为 DAG、每个领域非空；官方包校验纳入
  CI。
- 导入：`scripts/noj.ts knowledge import [--pack <dir>]`（缺省为官方包；纳入
  `dev-setup` 与生产 `init`，`noj-cli` 提供对应命令）幂等同步到
  DB，并记录当前生效的包 `id@version`。
- **替换**：实例管理员导入自己的包（如学校课程大纲）。新包中不存在的节点标记
  `deprecated`，已有挂载 保留但不再展示，直到人工改挂或 `replaced_by` 迁移。
- **扩展**：包可声明
  `extends: official@<version>`，在官方节点之上**追加**节点与前置边；不得修改或删除
  被扩展包的节点，ID 冲突即导入失败。
- 删除节点只能标记 `deprecated` 并可指定 `replaced_by`，已有挂载自动迁移。
- 内容采用 **CC BY-SA 4.0**（代码仍为
  AGPL-3.0），便于教师/教练引用与贡献；内容包可在后续拆为独立仓库。

备选：后台在线编辑。放弃原因：内容质量依赖评审，版本化与回溯比编辑体验更重要。

### 3. 数据模型（`src/shared/db/schema/knowledge.ts`）

| 表                       | 关键字段                                                                                                                                             | 说明                        |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------- |
| `knowledge_packs`        | `id`, `version`, `extends`, `imported_at`, `active`                                                                                                  | 实例当前生效的内容包        |
| `knowledge_nodes`        | `id`, `area`, `name`, `summary`, `syllabus[]`, `doc_path`, `pack_id`, `status(active/deprecated)`, `replaced_by`, `sort`                             | 实例级，无 `domain_id`      |
| `knowledge_edges`        | `from_id`, `to_id`（to 依赖 from）                                                                                                                   | 仅前置关系                  |
| `problem_knowledge`      | `problem_id`, `node_id`, `role(primary/secondary)`, `source(ai/human)`, `confidence`, `version_id`, `review_status(auto/pending/confirmed/rejected)` | 已归类题目恰好 1 个 primary |
| `problem_difficulty`     | `problem_id`, `prior`(0–100), `calibrated`(0–100), `sample_size`, `updated_at`                                                                       | 与 `problems` 分表          |
| `knowledge_tag_runs`     | `problem_id`, `version_id`, `model`, `prompt_version`, `content_hash`, `raw_output`, `status`, `cost`                                                | 审计与复现                  |
| `user_knowledge_mastery` | `user_id`, `node_id`, `state(none/learning/mastered)`, `solved_count`, `max_difficulty`, `updated_at`                                                | 物化，供图谱页与热力图读取  |

所有迁移遵守三步式规则；通过 `deno task db:generate` 生成。

### 4. 开关与配置（settings registry，runtime 级，可热改）

| 设置                              | 默认    | 说明                                                      |
| --------------------------------- | ------- | --------------------------------------------------------- |
| `knowledge.enabled`               | `true`  | 总开关；关闭后所有知识点 UI 与 API 隐藏，任务直接成功返回 |
| `knowledge.ai_tagging_enabled`    | `false` | AI 打标须实例管理员显式开启；未开启时只支持人工挂载       |
| `knowledge.auto_accept_threshold` | `0.75`  | AI 置信度不低于此值直接生效，否则进入审核                 |
| `knowledge.pass_ratio`            | `0.6`   | 非客观题的默认及格线（满分比例），出题人可按题覆盖        |
| `knowledge.mastery_min_solved`    | `3`     | 判定掌握所需达标题数 K                                    |

### 5. 挂载与归类

每道已发布题目处于「已归类」或「未归类」：

- **已归类**：恰好一个主知识点、至多三个次要知识点；`review_status=pending`
  的挂载计为已归类，界面标注 「待确认」。人工挂载（`source=human`）优先，AI
  不覆盖。
- **未归类**：仅在以下情况出现——AI
  打标未开启或未配置模型且无人工挂载；打标排队中或失败；AI 结果被驳回
  且未人工补挂。未归类题目可正常作答，但不进入阶梯、推荐、掌握度与难度分档；覆盖度面板单列「未归类」
  清单。人工挂载后立即归类；开启 AI 打标后，对全部未归类题目批量投递打标任务。
- **人工挂载**：出题人（具备该题编辑权限）与实例管理员可在题目编辑页挂/改知识点，不依赖
  AI。

### 6. AI 打标（P1，默认关闭）

触发：题目发布内容变化的新版本后，发布流程投递
`knowledge.tag`（target=problem，同题去重，只处理最新 版本；`content_hash`
相同则跳过）。

输入（严格白名单）：题型、标题、题面、公开样例、评测模式；评测器/参考解只取**截断后的源码摘要**。
隐藏测试数据与任何用户提交一律不发送。候选集为全部 active 节点的
`id + name`（不含 summary，见下文成本控制；预计 ≤300
节点，超过后改为「先选领域、再选节点」两段式）。

输出受 JSON Schema 约束：

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
primary；否则重试一次后记失败，题目保持未归类并列入 审核。落库按第 5
节规则；记录 `prompt_version` 与模型名，改 prompt 后可选择性重跑。

**网关平台调用**：网关新增 `POST /internal/platform-completions`，仅接受 core
内部服务凭据（与现有 `/internal/*` 同一鉴权）；请求必须带
`purpose`（第一版只允许 `knowledge.tag`），用量计入独立的 `platform`
额度主体并写审计。模型通过 model alias `platform.tagger` 配置。

**本地模型**：alias 可指向任意 OpenAI 兼容地址（如内网 Ollama /
vLLM），题面不出内网；运维文档给出 配置示例。core 不持有任何 Provider Key。

**成本控制**（LLM 调用按 token 计费，AI 打标须可预期、可封顶）：

- 单次调用 token：
  - 候选知识点只发 `id + name`（181 节点约 6k 输入 token；带 summary 约
    13–15k）；
  - 提示词按「固定部分在前、可变部分在后」组织：系统指令与候选列表（同一图谱版本内不变）在前，题面在后，
    以命中服务商提示词缓存；
  - 题面、样例、评测器摘要各设字符上限（系统设置，默认合计约 2k
    token）；输出限制为 JSON，`max_tokens` 取小值。
- 调用次数：默认关闭；题目内容 hash
  不变跳过；已有人工挂载的题目不调用；失败最多重试 1 次，预算类错误不重试。
- 预算封顶：网关为 `purpose=knowledge.tag` 设每月 token /
  金额上限（`knowledge_ai_monthly_budget`）。超额后
  任务以「预算暂停」状态延后到下个计费周期或预算调高后重试，题目保持未归类，覆盖度面板与审核页显示预算暂停。
- 回填预估：开启 AI 打标后的存量回填，先展示待打标题数、预计输入/输出 token
  与费用（按 alias 配置的单价）， 管理员确认后才投递；回填按网关 RPM/TPM 限流。
- 选型与可见性：默认推荐小模型（打标是分类任务），支持本地模型（零调用费）；后台展示打标用途的累计
  token、费用与本月剩余预算（复用网关用量查询）。
- 成本相关配置（预算、字符上限）随 P1
  一并登记，不预先登记（避免只登记不读取的死键）。

### 7. 难度：AI 先验 + 数据校准（P2）

- `prior`：AI 给出的 0–100 知识点内相对难度；无 AI 时取出题人三档映射（easy 25 /
  medium 50 / hard 75）。
- 数据信号 `d_data`：`1 − 达标人数 / 尝试人数`，用平均尝试次数微调，映射到
  0–100。
- `calibrated = (k·prior + n·d_data) / (k + n)`，n 为尝试人数，k
  为先验强度（默认 20）。小实例数据少， 自然以先验为主。
- `knowledge.calibrate` 每日按批重算；现有三档 `difficulty` 改为由 `calibrated`
  派生展示。

「达标」：有效得分 ≥ 题目及格线。客观题套卷为满分；其余题型默认
`knowledge.pass_ratio`，出题人可按题 覆盖。该定义与题单「score>0」相互独立。

### 8. 掌握度与学习路径（P3）

- `learning`：该节点下（primary）有任一题达标。
- `mastered`：达标题数 ≥ K，且至少一题难度位于该节点题目难度上三分之一；节点题量
  < K 时为「全部达标」。
- 只统计练习有效成绩与已结束比赛成绩；进行中比赛成绩不计入。
- `knowledge.mastery` 由有效成绩变更时投递（按 user × node
  去重），增量更新物化表。

推荐：**前沿节点**（前置均已掌握、自身未掌握；前置为软约束，不锁题）；**下一题**（难度略高于用户已达标
最高难度、且未达标的第一题）。阶梯只含用户**当前可访问**的题目（域访问政策 +
已发布 + 非保密保护）； 跨域题目以 `/d/<域>/…`
链接呈现。题库稀疏时，图谱页可切换为「只显示有题的知识点」。

### 9. 讲解文档（预留位置，内容分期）

- 节点可带 `doc_path` 指向内容包 `docs/<node-id>.md`；格式固定：直觉解释 →
  核心概念 → 常见误区 → 一道带完整解析的例题 → 「去做第一题」。每篇 5–10
  分钟读完。
- P0 只建字段与渲染占位；P2 起在节点页渲染；内容先试点 10–20
  个基础节点，按「看过讲解 vs 未看」的达标率 对比决定是否扩充。内容须原创，AI
  起草、人工审核。

### 10. 教练视角（P4）

- **班级热力图**：班级成员 × 知识点的掌握状态矩阵（读
  `user_knowledge_mastery`），只有该班级的教学人员
  可见；按领域折叠，支持只看前沿节点。
- **按知识点布置作业**：选择知识点与题数，系统从阶梯中按难度挑选本域可访问的题目，生成普通作业的题目列表
  （复用现有作业创建流程，不新增作业类型）。
- 教学模块经 `src/features/knowledge/index.ts` 获取挑题与热力图数据。

### 11. 可见性

- 知识点在练习场景公开；题目处于进行中比赛或比赛保密保护期时：题目页不展示知识点，不出现在任何节点阶梯、
  推荐、掌握度与覆盖度统计中。
- `algorithm` 类标签维持「通过后可见」，与知识点相互独立。

### 12. 缓存与多副本

图谱节点/边只随导入变化：允许进程内只读缓存（TTL 10
分钟，导入后经现有设置失效机制通知重新加载），在
`dev-docs/engineering/domain-boundaries.md` 登记。掌握度、难度一律读 DB。

## Risks / Trade-offs

- **AI 误标** → 置信度阈值 + 审核队列 + 人工优先；覆盖度面板展示「待确认」比例。
- **节点粒度不当** → 首版控制在 150–250 节点，以题量统计驱动后续拆并。
- **冷启动题量不足 / 私有题库稀疏** →
  覆盖度面板暴露断层；图谱页可只显示有题节点。
- **内部部署不允许外发题面** → AI 打标默认关闭，支持本地模型；不开 AI
  时功能完整。
- **替换内容包导致挂载失效** → 旧节点标记 deprecated 而非删除，提供
  `replaced_by` 迁移与「失效挂载」清单。
- **LLM 成本** → 只发 id+name 候选、提示词缓存、输入截断；内容 hash
  不变跳过；按用途设月度预算封顶，回填先预估费用再确认（见第 6 节）。
- **掌握度规则过于简单** → 第一版以可解释为先，保留物化表以便替换为概率模型。

## Migration Plan

1. P0：内容包、表、导入与校验、只读 API 与图谱浏览页；不影响现有功能。
2. P1：人工挂载 + 审核队列 + 网关平台调用 + AI 打标（默认关闭）。
3. P2：难度与节点阶梯、题目页「同类下一题」、讲解文档渲染与试点内容。
4. P3：掌握度、推荐与覆盖度面板。
5. P4：教练视角。
6. 回滚：各期为增量，关闭 `knowledge.enabled` 即隐藏全部能力；表保留。

## Open Questions

- 首版图谱内容：由 AI 依据 IOAI / NOAI 公开考纲起草，懂 AI
  竞赛的维护者评审后合入。
- 「达标」默认线 60% 是否合适，还是按题型分别设置？
- 是否在 noj-docs 公开整张图谱作为「学习大纲」页面？
- 内容包何时拆为独立仓库（贡献者增多、需要独立发版节奏时）？
