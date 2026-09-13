# Agent Note: 消费者基类补 processing 自愈、sweeper 登记表与每实例关闭标记

Status: implemented

## Problem

`shared/mq/base-consumer.ts` 的 `BRPOPLPUSH` 语义下，消息在"已取走、未 ACK"窗口内因进程被杀/Redis 中断会残留在 `:processing`。此前只有评测结果队列有 sweeper 兜底，`noj:search:index` 与 `noj:review:dm` 的消息会**永久滞留且不可自愈**（搜索索引静默落后，直到有人手工 `search reindex`）。同时 `consumerShutdownRequested` 是三个消费者共享的单个模块级布尔量，且 sweeper 的队列清单是硬编码数组——新消费者接入时"记得去改清单"成了隐性要求。

## Decision

1. `createConsumer` 启动时自愈本队列 `:processing`（`RPOPLPUSH` 原子搬运，每进程每队列只执行一次，避免兄弟消费者重连时抢走正在处理的消息）。
2. 新增 `shared/mq/sweep-targets.ts` 登记表：`createConsumer` 创建时自动登记，sweeper 遍历登记表 → **新增消费者自动获得兜底**，消除"改清单"这一漂移源。
3. 关闭标记改为每实例独立；`requestConsumerShutdown()` 保留"关停全部"语义（进程优雅退出），并新增 `handle.requestShutdown()` 只停本实例。

## Alternatives considered

- 只把两个新队列加进 sweeper 的硬编码数组：能修当下，但下一个消费者仍会漏。
- 让 sweeper 动态发现所有 `*:processing` 键（`SCAN`）：无法区分队列归属，且会误扫评测队列（judge 侧写入）。
- 关闭标记保持全局：`shutdownSearchIndexConsumer()` 会连带停掉结果消费者与审核消费者。

## Consequences

残留消息在启动时自动回主队列，长尾滞留被消除；`tests/shared/mq/base-consumer.test.ts` 覆盖自愈、每队列一次与实例隔离（停 A 不影响 B）。搜索索引的对账/重建自动化仍待补（`reindexAll()` 目前只挂在手动 CLI）。
