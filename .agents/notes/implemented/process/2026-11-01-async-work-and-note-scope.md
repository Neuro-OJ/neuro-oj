# Agent Note: 异步队列分工、Agent Note 口径与 CI 选择器去 Python

Status: implemented

## Problem

#698 审查发现三处工程规范缺口：

- 0.11 引入 PostgreSQL 后台任务后，与 Redis
  消息队列并存却没有分工规则，导致搜索索引 一度两条链路并行（N1）。
- `.agents/notes/implemented/` 在 0.11 一个版本内从 266 篇增长到 575
  篇，大量是评审 修复、CI 修复的单点记录（N5）。
- `scripts/select-core-ci.py` 让仓库在 Deno、Rust 之外多维护一种运行时（N6）。

## Decision

- 在 `dev-docs/engineering/domain-boundaries.md` 写明分工：Core
  内部必须可靠的异步 工作一律走 PostgreSQL 后台任务；Redis 列表队列只用于 Core
  与 noj-judge 之间的评测 通信；Redis Pub/Sub 只做可丢失的广播。
- `.agents/notes/README.md` 规定评审修复、CI 修复、同一功能的后续修复更新已有
  Note， 只有新决策才新建。
- CI 选择器改写为 `scripts/select-core-ci.ts`，`changes` job 增加 `setup-deno`；
  自测直接调用 `selectDomains`，不再起子进程。

## Alternatives considered

- 用 `jq` 在 workflow 内联实现选择逻辑：不需要安装
  Deno，但逻辑不能被单元测试覆盖， 且与 `verify-domain-ci.ts`
  的门禁检查耦合在字符串上。
- 把选择器并入 `check-ci.ts`：两者职责不同（门禁 vs 输出 CI
  矩阵），合并后入口语义 不清。

## Consequences

- `changes` job 多一次 `setup-deno`（有缓存，约数秒）。
- 新增 Core 内部异步工作时，评审以本规则为准；Redis 队列只剩评测相关的使用方。
