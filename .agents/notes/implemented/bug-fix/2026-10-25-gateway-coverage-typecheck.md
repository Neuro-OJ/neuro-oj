# Agent Note: 修复 Gateway 覆盖率门禁的测试类型错误

Status: implemented

## Problem

Gateway 覆盖率 job 使用带类型检查的 `deno task test:coverage`，而几个真实运行时
回归测试中的最小 Redis mock、ioredis connection 类型和 `Deno.HttpServer.shutdown()`
回调仍按旧类型书写，导致覆盖率 job 在运行测试前因 6 个 TypeScript 错误失败。
这些错误不影响 `--no-check` 的功能回归，却会阻断 CI 的覆盖率证据。

## Decision

为测试中实际使用的 ioredis 三项操作声明最小结构类型；对刻意不完整的 Redis mock
显式使用 `unknown as RedisClient`，并给脱离上下文的 mock 参数补齐类型。将 shutdown
回调改为返回 `void`，并把 postgres `begin` 的测试替身收窄为可展开的未知参数函数。
生产类型和运行时适配器不变。

## Alternatives considered

不把 `test:coverage` 改成 `--no-check`，因为这会掩盖覆盖率阶段的类型回归；不把
RedisClient 的生产接口改成可选字段，因为那会削弱实际调用方的类型约束。

## Consequences

Gateway 测试既保留现有最小 mock 语义，又可通过完整 `deno check`；覆盖率 job 不再
因测试类型错误在阈值计算前失败。
