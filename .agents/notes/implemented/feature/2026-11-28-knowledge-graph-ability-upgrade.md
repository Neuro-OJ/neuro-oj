# Agent Note: 知识图谱能力分升级（轻量级 Elo + 主/次权重 + 置信度 + 读时遗忘衰减）

Status: implemented

## Problem

知识图谱原有的掌握度内核（`noj-core/src/features/knowledge/mastery.ts`）仅按 `role = 'primary'` 题目的二值达标计数与上三分位门槛判定三态，存在以下不足：

1. **忽略连续得分与协同知识点**：60 分险过与 98 分高分对掌握度无区分，且题目挂载的 `secondary` 协同知识点完全不计入能力评估；
2. **稀疏题库容易虚高**：节点题量 `< K` 时做对 1 道简单题即直接判定 `mastered`；
3. **缺少随时间推移的复习提醒**：长期未巩固的已掌握知识点不会触发轻量复习唤醒；
4. **前沿推荐边界缺陷**：`rankFrontierNodes` 要求 `stateOf(node.id) === "learning"` 才触发 `review_prerequisite`，导致零通过（`state === 'none'`）但 `failed_attempts >= 3` 的学生无法收到前置补强提示。

同时，`mastery.ts` 原先已达 1182 行，贴近 1200 行单文件门禁上限，不能继续堆叠纯计算逻辑。

## Decision

在**零额外常驻内存、零 LLM 消耗、不新增后台全表扫描写库**的前提下，完成掌握度与推荐内核升级，并对三态（`none / learning / mastered`）、技能树与教练班级矩阵保持向后兼容：

1. **模块拆分守住门禁**：
   - 新建无数据库依赖的纯函数模块 `noj-core/src/features/knowledge/ability.ts`，承载同题去重、主/次权重、轻量级 Elo、有效证据量、三态收敛与读时遗忘衰减；
   - 将覆盖度面板拆至 `noj-core/src/features/knowledge/coverage.ts`（由 `index.ts` 统一对外导出，避免 `coverage.ts <-> mastery.ts` 运行时循环依赖），保证所有源文件均低于 1200 行门禁。

2. **Schema 与安全迁移**：
   - 在 `user_knowledge_mastery` 扩展三个标量列并经 `deno task db:generate` 生成迁移 `0147_worried_silver_surfer.sql`：
     - `ability_score integer NOT NULL DEFAULT 0`（`CHECK 0..100`）；
     - `evidence_weight real NOT NULL DEFAULT 0`（`CHECK >= 0`）；
     - `last_passed_at text`（可空，ISO 8601）。
   - 所有新增列均带 `DEFAULT` 或可空，安全通过迁移门禁。

3. **轻量级 Elo + 置信度参数选型**：
   - **输入与防刷分**：复用 `loadUserProblemScores`（练习 + 已结束比赛有效最高分与对应作答时间 `best_at`），纯函数层再次按 `problem_id` 去重防刷分并按时间升序重放；难度 `d` 取 `problem_difficulty.calibrated`（缺失回退先验）；连续得分率 `y ∈ [0, 1]` 沿用 `FULL_SCORE = 10000` 与 `objectiveFullScore` 口径。
   - **公式与参数**：初值 $\theta_0 = 25$（对齐 easy 先验）、尺度 $S = 25$（$E = 1 / (1 + 10^{(d-\theta)/25})$）、初始步长 $K_0 = 32$、衰减系数 $\alpha = 0.2$（$K(w) = 32 / (1 + 0.2 w)$）；角色权重 `primary = 1.0`、`secondary = 0.35`；达标贡献 `1.0 * w_role`，未达标有效尝试折算 `0.25 * w_role` 计入 `evidence_weight`（不计入 `passed_weight`，防止靠反复失败虚增达标置信度）。
   - **三态兼容与防虚高**：
     - 保持 `solved_count / attempted_count / failed_attempts` 仅统计主知识点，且无主知识点达标时 `state` 保持 `none`（次要知识点仅提升能力分与证据量，不污染教练班级矩阵）；
     - 常规题库（`total >= K`）：`passed_weight >= K` 且含主知识点上三分之一达标题且 `ability_score >= 45` → `mastered`；
     - 稀疏题库（`0 < total < K`）：全部主知识点题达标，且满足 `passed_weight >= 1.5 && ability_score >= 45`，或攻克高难题（`max_passed_difficulty >= 67 && ability_score >= 50`）方可 `mastered`，避免做对 1 道简单题虚高；
     - `user_knowledge_placements` 保持严格隔离。

4. **读时遗忘衰减与推荐衔接**：
   - 读取 `GET /knowledge/me/mastery` 与 `GET /knowledge/me/recommendations` 时实时调用 `applyForgettingDecay`（不写库）：距 `last_passed_at` 60 天内无衰减；超过 60 天按 180 天半衰期温和衰减并设 65% 保底；满 90 天且处于 `learning`/`mastered` 时标记 `needs_review = true`。
   - 修复 `rankFrontierNodes` 边界：移除 `stateOf(node.id) !== "learning"` 限制，使 `state === 'none'` 且 `failed_attempts >= 3` 的节点正确触发 `review_prerequisite`；新增 `needs_review` 推荐理由（优先级高于新前沿节点、低于正在学习与根因补前置）。
   - `pickNextLadderItem` / `readNodeLadder` / `readMyRecommendations` 支持按目标难度 `d ≈ effective_ability + 5` 匹配未达标题，同时保留既有默认行为与比赛保护期 404 防线。

5. **前端最小闭环与全图总览视图**：
   - 更新 `noj-ui/utils/domain/education/knowledge.ts`、`knowledgeTree.ts`、`KnowledgeSkillTree.vue` 与学生端「我的学习」页，按 Precision Instrument 设计 Token 展示节点能力分（`tabular-nums`）与轻量「待复习」徽标，不影响教练班级矩阵；
   - 在 `knowledgeTree.ts` 扩展纯布局算法 `buildGlobalSkillTreeLayout`（3 列均衡宏观阶段泳道 + 跨领域连线）与 `collectDependencyChain`（全图跨领域上下游依赖链），新增 `KnowledgeGlobalOverview.vue` 并将 14 领域进度面板与搜索定位整合到左侧导航栏，支持节点表面直接拖拽、触控板平移/捏合缩放、交互式小地图、全屏切换及点击「讲解」/双击直达节点详情页，同时放开未登录态下公开知识图谱的浏览（不请求个人数据）；
   - 复用 `user_knowledge_placements` 扩展 `POST /knowledge/me/diagnostic/self-assess` 支持 `mode: 'remove'` 与 `include_prerequisites: true`，在全图快览面板与知识点详情页提供一键「标熟 / 含前置标熟 / 取消标熟」，立即点亮技能树并放行下游前置推荐，同时不污染刷题统计与教练班级矩阵。

## Alternatives considered

- **后台定时任务扫描全表做遗忘衰减写库**：引入额外写放大与多副本调度开销，且历史能力分会被覆盖；改为读时纯计算 `effective_ability` / `needs_review`，零写库且可随时调参。
- **把次要知识点也计入 `solved_count` 或直接标为 `learning`**：会导致教练班级矩阵出现大量 `solved_count = 0` 的 `learning` 单元格；改为仅累加 `ability_score` 与 `evidence_weight`，保持 `solved_count` 与班级矩阵语义清晰一致。
- **使用完整 IRT/BKT 参数估计模型**：需要海量标定样本与离线拟合成本；轻量级 Elo + 有效题量置信度零额外内存、确定性可单测且解释性强。

## Consequences

- `GET /knowledge/me/mastery` 向后兼容地新增 `ability_score`、`effective_ability`、`evidence_weight`、`needs_review`、`last_passed_at`；旧客户端与测试桩可忽略新增可选字段。
- 稀疏题库（仅 1 道简单/中等题）的既有测试在升级后若需断言 `mastered`，需配置高难题（`calibrated >= 67`）或至少 2 题，与防虚高语义一致。
- 存量用户在下一次有效提交触发 `knowledge.mastery` 重算前，`ability_score` 与 `evidence_weight` 默认为 `0`、`last_passed_at` 为 `null`，前端自动隐藏 0 分能力徽标且不误报「待复习」。
