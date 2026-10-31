# Agent Note: 删除 BFF 公开元信息缓存填充锁

Status: implemented

## Problem

#698
指出单副本部署下站点元信息缓存的分布式锁维护成本偏高。现有请求等待其他请求填充，超时后还可能因锁竞争得到
BFF_CACHE_PENDING 504。

## Decision

保留现有 Redis 缓存、30 秒 TTL、上游命名空间和匿名回源；删除 NX
锁、owner、轮询、解锁 Lua
与等待超时错误。缓存未命中直接加载，读取故障绕过缓存，写入失败返回已加载结果，上游失败不缓存。
同步修订进程缓存约束，允许有界、带 TTL
且可容忍短暂不一致的只读展示数据；仍要求登记 TTL
和多副本后果。此次不新增进程缓存，不改变系统配置失效机制。

## Alternatives considered

替换为进程缓存需要改动装配、部署配置和现有共享缓存行为。直接移除填充锁即可解决本项问题，范围更小。

## Consequences

并发冷请求可能分别回源；低频公开元信息在 30
秒内继续共享缓存。请求不再因填充锁竞争额外等待或得到 504。每日签到不变。

验证：`cd noj-ui && deno task test` 全部 325 项通过，包含
TTL、命名空间、并发未命中、缓存读写故障及上游重试回归；修改的 TypeScript
文件格式、lint 和 Agent Note 校验通过。

`deno task check:types:nuxt` 通过（已有自动导入重名警告）。
