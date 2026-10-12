# Agent Note: CI 红灯修复（文件规模棘轮 / 搜索 JIT / 私题索引 / LLM 配额与限流桶）

Status: implemented

## Problem

`main` 的 `CI` 工作流连续两次推送失败（HEAD `95315c5c2` 与上一提交），两个 job
红灯：

1. **Root Gates**：`scripts/check-file-size.ts` 的巨型文件棘轮判定
   `noj-judge/src/dual/mod.rs` 从基线 1861 行涨到 1884 行。该增长来自同一次提交
   新增的 `build_llm_env` 及其两个内联测试。
2. **Core Perf**：`search perf: 10 万题重建后搜索 < 500ms` 实测 604ms（CI）/
   517ms（本地），连续失败。

同时，2026-09-05 作弊面审计中两项被搁置的网关风险仍未修（F-06 / F-10）， issue
#554（竞赛私题标题进搜索索引）仍开放。

## Decision

### 1. 文件规模棘轮：拆分而非放宽

把 `build_llm_env` 与其两个内联测试从 `dual/mod.rs` 抽到新子模块
`noj-judge/src/dual/llm_env.rs`，`dual/mod.rs` 降到 1839 行，并按棘轮规则
**下调** `SIZE_BASELINE`。棘轮语义是"只允许下调、不允许上调"，因此不放宽基线。

### 2. 搜索性能：消除 JIT 纯开销（真实优化，非调阈值）

根因链（全部实测取证）：

- `to_tsvector('simple','题目 1：测试数据')` = `'测试数据':3`，中文**不切词**；
  `websearch_to_tsquery('simple','测试')` 与之匹配为 **false** → FTS
  分支恒不命中。
- 查询退化为 `ILIKE '%测试%'`；"测试"仅 2 字符，**pg_trgm 无法为 <3 字符 pattern
  建索引** → 全表扫描 10 万行。
- 该扫描的计划代价（~248 万）触发 **PostgreSQL JIT**，实测编译占
  **238ms/309ms**。
- `SET jit = off` 后同一查询降至 **57ms**；端到端 `searchFlat` 从 **277ms →
  57ms**。

修复：在 `connection.ts` 的连接 startup 参数默认发送 `-cjit=off` （可用
`DATABASE_JIT=on` 覆盖）。这是 OLTP 负载的通行做法，消除的是纯编译开销，
不改变任何查询结果——因此不属于"为过门禁而放宽阈值"。

### 3. #554：竞赛索引只收录公开题

`buildContestEntry` 此前把竞赛内**全部**题目标题与编号写进索引
`body`/`metadata`， 而公开赛条目
`is_public=true`，导致公开赛引用的私题标题可被搜索发现。聚合查询 改为仅纳入
`p.visibility = 'public'` 的题目，并补回归测试。

### 4. F-06：新增"用户×题目"组合配额维度

此前配额维度仅 `global/user/problem`。单用户可反复提交打满**全选手共享**的
`problem/day`（默认 5000 calls）桶，使之后提交者 LLM 调用 `out_of_usage`、
评测得 0 分（关门攻击）。新增 `user_problem` scope（day/month）， `scope_id`
形如 `<userId>:<problemId>`，与既有 `user`/`problem` scope 平行；
同步更新配置注册表、种子、内部配额 API 与测试。

### 5. F-10：无真实 IP 时按 submission 隔离限流桶

Evaluator 容器直连网关、无 `X-Forwarded-For`，此前全部落到共享的
`llm:rate:ip:unknown:<minute>` 桶（默认 60/min），少量高吞吐提交即可让他人 LLM
评测随机 429。新增 `ipRatePrefix()`：有真实 IP 按 IP 分桶，缺失/`unknown` 时改按
`llm:rate:sub:<submission_id>` 隔离。

## Alternatives considered

- **上调 `dual/mod.rs` 基线到 1883**：违背棘轮"只允许下调"的设计意图，会让巨型
  文件持续膨胀，否决。
- **把搜索阈值从 500ms 放宽**：这是真实可消除的 238ms 纯开销，放宽阈值会掩盖
  问题且与设计文档的性能预算（GIN tsvector < 50ms、trgm < 200ms）不符，否决。
- **为中文短查询建 2 字索引**：pg_trgm 对 <3
  字符无索引能力；改分词器（zhparser） 属大范围架构变更，超出本次修复范围。
- **F-06 改为"不允许共享 problem 桶"**：会让每题的并发额度难以按题配置；
  新增组合维度是正交且向后兼容的做法（既有 `problem` 桶保留）。
- **F-10 直接禁用 IP 限流**：会移除对真实 IP 的保护；按 submission 隔离保留了
  单任务自身的速率约束。

## Consequences

- `main` 的两个 CI 红灯应转绿；`dual/mod.rs` 与搜索查询的关键性能被锁入回归。
- 搜索默认关闭 JIT：对长分析型查询可能变慢，可用 `DATABASE_JIT=on` 恢复。
- 新增 `user_problem` 配额维度：默认值由 env（`NOJ_LLM_DEFAULT_USER_PROBLEM_*`，
  已随 compose 注入）与 `limits.ts` 内置值提供；`llm_quotas` 不写占位行
  （`scope_id=""` 与 `<userId>:<problemId>` 精确匹配不上，写了也不生效，
  2026-09-25 评审修正）。需要单独限额时写一条精确 `scope_id` 的行。
- `QUOTA_ENV_KEYS` 由 18 个变为 24 个，配置注册表与 `.env.example` 同步更新。
- 新增 `DATABASE_JIT` 环境变量（默认 off）。
