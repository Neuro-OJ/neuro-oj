# Agent Note: 用户封禁即刻吊销会话、题目转号并发控制与数值类型加固

Status: implemented

## Problem

开赛前审计与并发压测发现以下稳定性与数据一致性隐患：
1. **AR-05 (用户封禁会话未失效)**：管理员执行封禁用户操作后，数据库虽然记录了封禁状态，但未能递增 `users.session_version`。持有有效 JWT 的违规用户在 24 小时令牌过期前仍可继续访问已认证接口（未做实时状态查询的路由或缓存场景）。
2. **AR-03 (题目转 P 号并发唯一键冲突与搜索脱节)**：
   - 管理员并发调用 `to_p`（草稿题/私有题转公开题）时，通过 `MAX(display_id)` 计算下一个公开题号，因无排他锁保护，并发事务会计算出相同的题号，导致 PostgreSQL 抛出 23505 唯一键冲突。
   - `to_p` 与 `to_public` 改变题目状态后，未同步向 Redis 队列发布 `publishSearchIndexEvent("problem", id, "upsert")` 搜索事件，导致题库公开后在全局搜索中不可查。
3. **SC-02 / 决策 8 (专网环境镜像签名配置空白)**：离线专网赛事环境中无法连接公网 OIDC 验证 Cosign 签名，若直接强启会导致部署失败；若无操作规范指引，则存在镜像篡改风险。
4. **TH-01 (PostgreSQL bigint count 类型隐患)**：PostgreSQL 原生 `count(*)` 返回 64 位整数（`int8` / `bigint`），驱动在部分反序列化路径下将其转换为 string，可能导致上层按数值计算时出现隐式转换异常或 NaN。

## Decision

1. **封禁用户立即作废 JWT 会话（AR-05）**：
   - 在 `users-bans.ts` 的 `banUser` 事务中，增加 `session_version: sql`${users.session_version} + 1``。
   - 所有现有 JWT 的 `session_version` 将低于数据库版本，在 `authMiddleware` 中即刻被判定为失效（401 Unauthorized）。
2. **题目转号排他锁与搜索同步（AR-03）**：
   - 在 `to_p` 事务开始时引入事务级排他咨询锁 `SELECT pg_advisory_xact_lock(hashtext('to_p_problem_number'))`，并在事务内以 `FOR UPDATE` 锁定待转换题目，保证题号分配与转换严格串行化，彻底消除 23505 冲突。
   - 转换成功后遍历题目列表，补齐发布 `publishSearchIndexEvent("problem", id, "upsert")` 索引事件。
3. **专网赛事与公网验签部署指引（SC-02）**：
   - 维持 `.env.prod.example` 默认配置 `NOJ_ENFORCE_IMAGE_SIGNATURES=false`。
   - 在运维部署文档（`production-deploy.md`）增设专题章节，明确离线专网使用 `docker save/load` 介质带入与 SHA-256 校验和对齐规范，联网环境提供 Cosign OIDC 证书正则配置模板。
4. **统一计数字段数值类型（TH-01）**：
   - 在用户资料、评论、提交队列、封禁列表等核心查询中，将 `count(*)` 统一转换为 `count(*)::int`，确保返回纯 JavaScript number 类型。

## Alternatives considered

1. **分布式 Redis 锁替代 PostgreSQL 咨询锁**：
   - 题目题号分配属于纯数据库内事务逻辑，使用 PostgreSQL 内置 `pg_advisory_xact_lock` 随事务提交或回滚自动释放，无需担心进程崩溃导致的锁超时与死锁问题。
2. **封禁时将 JWT 加入 Redis 黑名单**：
   - 现有系统已具备 `session_version` 会话撤销机制，直接利用版本号递增实现单源真相治理，无需在 Redis 中额外维护黑名单集合。

## Consequences

- 违规账号一经封禁，其所有活跃会话立即失效，保障赛事期间恶意行为能够被即时阻断。
- 题目批量导入与批量转公开在高并发场景下 100% 成功，不再发生 23505 唯一索引碰撞，搜索索引实时同步。
- 生产运维指引覆盖离线内网与联网高安全两类环境，兼顾安全性与现场可用性。
- 消除数字计数字段潜在的 string/number 隐式类型缺陷。
