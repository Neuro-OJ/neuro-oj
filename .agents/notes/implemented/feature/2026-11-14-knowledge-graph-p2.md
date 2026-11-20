# Agent Note: 知识图谱 P2 难度校准、题目阶梯与讲解文档

Status: implemented

## Problem

P1
让题目有了知识点，但学习者还看不到「这个知识点下按什么顺序做题」：难度只有出题人主观三档，也没有讲解。P2
要给每个知识点提供从易到难的题目阶梯与「下一题」，并试点讲解文档。

## Decision

- 表
  `problem_difficulty`（`prior`、`calibrated`、`sample_size`、`pass_ratio_override`）；配置
  `knowledge_pass_ratio`（默认 60%）。「达标」= 有效得分 ≥
  及格线（客观题套卷为满分），只计练习与已结束比赛成绩，进行中比赛不计。
- 校准
  `calibrated = round((k·prior + n·d_data)/(k+n))`，k=20，n=尝试人数，`d_data`
  由达标率换算；prior 用 AI
  结果或出题人三档映射（25/50/75）。每日周期任务批量重算（多副本互斥）。三档展示由
  calibrated 派生，`problems.difficulty` 列不改。
- API：`/knowledge/nodes/:id`
  返回讲解原文（防目录穿越）；`/knowledge/nodes/:id/ladder?domain=`
  按难度升序返回本域可访问、非保密题目及当前用户达标情况与推荐下一题；`/knowledge/problems/:id/next`；图谱可按域附题目数。
- 前端：域内知识点页（讲解经现有 `MarkdownRenderer`
  渲染与净化、前后置知识点、阶梯与推荐）、题目页「同类下一题」与校准难度、编辑页及格线。未做图谱可视化（暂缓）。
- 讲解试点 15
  篇（基础节点），固定结构：直觉理解、核心概念、常见误区、例题与完整解析、下一步；例题代码均实际运行通过。

## Alternatives considered

- 直接改写
  `problems.difficulty`：会影响现有筛选与统计，改为独立表并在展示时优先使用。
- 实时重算难度：每次提交都会触发写放大，改为每日批量。

## Consequences

- 已验证：knowledge 74、problems 319、共享 467、noj-ui 单元 350 与组件 459
  通过；门禁通过。
- 带 `domain` 的图谱题目数为逐节点查询（181 次），规模扩大后应改为单条聚合 SQL。
- 讲解需专家复核：双下降表述、RAG 示例的演示性嵌入、MLP 与反向传播两篇的重叠。
- 顺带修复 P1 引入的网关测试随机失败：伪 Db 以「最后一个数值」取
  `estimated_cost`，实际取到 `latency_ms`，耗时为 1ms
  时失败；改为按占位符位置取值。覆盖率门禁的失败输出也改为过滤 Download/Check
  噪声并把测试结果放在末尾，此前 8000 字符尾部只剩编译行、看不到失败用例。
