# Agent Note: 知识图谱 V2（技能树视图、45 篇讲解与摸底/错因闭环）

Status: implemented

## Problem

知识图谱 P0–P4 虽然完成了图谱建模、AI
打标、难度校准、掌握度与教练矩阵，但在体验与闭环上仍有三块短板：

1. 前端缺少可交互的有向技能树（DAG），且带 `domain` 查图谱节点题量时后端存在 181
   次顺序查库；
2. 181 个节点仅有 15 篇讲解，大量入门与高频核心节点为空节点，内容门禁也未校核
   `doc` 引用完整性；
3. 冷启动缺少快速摸底诊断直接点亮基础能力，且未与 PR #792 落地的
   `evaluation-feedback`（`badcases.error_type` / 分项 `metrics`）错因分析打通。

## Decision

1. **轻量技能树与 N+1 消除**：
   - `difficulty.ts` 的 `loadNodeProblemCounts` 改为单条分组 SQL 聚合 +
     单次域内保护期查询，彻底消除 181 次循环查库。
   - 新增纯拓扑布局工具 `knowledgeTree.ts` 与 `KnowledgeSkillTree.vue`，支持 14
     领域切换、考纲过滤（IOAI / NOAI /
     LMCC）、「仅看有题节点」、前置/后继连线高亮，并严格遵循设计 token（Signal
     绿 / Primary 蓝 / Neutral 灰 / 6px 圆角）。
2. **高频节点讲解扩充与打标多能力约束**：
   - 补写并挂载 **30 篇**覆盖全 14 领域的原创中文核心节点讲解（累计达 **45
     篇**）。
   - 在 `pack.ts` 与 `scripts/check-knowledge-pack.ts` 中加入 `validatePackDocs`
     门禁校验；在 `tagging.ts` `buildTagSystemPrompt` 中补充跨阶段 AI
     工程题「主能力 + 最多 3 项次要协同能力」指引（保持不附带 summary 与按 `id`
     排序的前缀缓存稳定性）。
3. **摸底诊断与 PR #792 错因联动**：
   - 新增独立表 `user_knowledge_placements`（含 Drizzle 迁移）与
     `features/knowledge/diagnostic.ts`，支持高杠杆检查点筛选及领域/节点自评（`merge`
     / `replace`），通过 `rankFrontierNodes` 放行下游前沿推荐而完全不污染
     `user_knowledge_mastery.solved_count` 与教练矩阵。
   - 新增
     `features/knowledge/remediation.ts`（`GET /knowledge/problems/:problemId/remediation`），结合题目主/次节点、缺失前置链，以及提交/自测页
     `AiFeedbackPanel` 提取的 `badcases.error_type` 与薄弱分项 `metrics`
     返回精准补强节点；保护期题目严格沿用 404 防线。

## Alternatives considered

- 直接往 `user_knowledge_mastery` 写入 `state='mastered'` 或虚拟
  `solved_count`：会污染真实做题统计与班级掌握度矩阵，改为独立
  `user_knowledge_placements` 表隔离。
- 把摸底与错因代码塞进 `mastery.ts`：`mastery.ts` 已接近 1200
  行文件上限，拆分为独立的 `diagnostic.ts` 与 `remediation.ts` 更清晰且守住
  `check-file-size` 门禁。

## Consequences

- `AiFeedbackPanel` 与 `KnowledgeMyLearning` 对新增 `knowledge`
  方法与可选字段采用向后兼容访问，保留旧测试桩与未登录降级行为。
- 摸底自评目前聚焦「能力自评与检查点解锁」，独立自适应随堂摸底试卷可作为后续增强项按需扩展。
