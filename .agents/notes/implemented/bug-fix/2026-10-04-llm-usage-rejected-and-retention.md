# Agent Note: 网关被拒请求不存原文并为 llm_usage 增加保留期清理

Status: implemented

## Problem

2026-09-28 审计 G-04（High）：沙箱可直接调用 `POST /v1/chat/completions`，即使请求被限流/额度
拒绝（429），网关仍把 `request_messages` 写入 `llm_usage`。此前已有 10MB 入站上限与单条 64KB
截断，但仍存在两点：

- 被拒请求的写库量与请求速率成正比，无需任何前置条件即可持续写库（持久化 DoS）；
  选手 prompt 原文随之长期留存；
- `llm_usage` 没有任何清理机制，只增不减。

## Decision

- 新增 `recordRejectedUsage`：调用前拒绝（`enforceAndCount` 失败，上游未被调用）**不保存 prompt
  原文**（`request_messages = []`，保留 `prompt_hash`），并以 Redis `SET NX EX 60` 按
  "提交 + 拒绝原因"去重，窗口内重复拒绝只计指标不落库。Redis 不可用时照常写入（审计宁多勿漏）；
- 调用后结算超额（上游已调用、产生真实费用）与上游错误分支保持完整记录；
- 新增 `NOJ_LLM_USAGE_RETENTION_DAYS`（默认 90，0 关闭），`createApp` 启动时与每 6 小时执行
  `pruneUsage`：按 ISO 文本 `created_at` 截止时间每批 5000 行删除；多副本经 Redis 锁
  `llm:usage:prune:lock` 互斥；
- `RedisClient` 新增 `setNx`；env 已登记到 `config-registry.ts`、`.env.example`、`.env.prod.example`
  与运维文档。

## Alternatives considered

- 被拒请求完全不落库：拒绝事件对排查配额问题有价值，且指标无法关联到具体提交；
- 进程内去重表：违反多副本约束（禁止新增进程内可变状态），改用 Redis；
- 用 PostgreSQL 分区表按月 DROP：需要迁移与运维改造，超出发布前修复范围。

## Consequences

- 被拒请求写库量上限约为"活跃提交数 × 拒绝原因数 / 分钟"，与请求速率无关；
- 运营在后台看不到被拒请求的 prompt 原文；
- 超过 90 天的用量审计默认被删除，需要更长留存的部署须显式调大该值。
