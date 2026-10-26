# Agent Note: Core 分片与工作空间检查包含完整资源生命周期的时间预算

Status: implemented

## Problem

PR #694 的 CI run 40291504159 中，Core Sharded job 在 20 分钟整被取消。
两个测试分片分别输出 287 passed / 0 failed / 6 ignored 和 2255 passed / 0 failed
/ 2 ignored，大分片测试耗时 19 分 22 秒。 job 还包含依赖准备、迁移、专属数据库和
Redis 创建，以及所有权清理； 测试本身完成并不代表完整启动器已经退出，20
分钟上限没有留出收尾预算。

随后 run 40295814159 的 Core workspace job 121481663499 同样输出 977 passed / 0
failed / 1 ignored，测试耗时 14 分 19 秒；该旧别名实际覆盖
access、problems、assets、application、education 五个目标模块。 其 15
分钟整体上限在测试完成后取消资源清理，仍不能作为 job 通过。

## Decision

把 Core Sharded 和 Core workspace job 的整体上限调整为 30
分钟，保留完整测试入口、隔离资源、
清理步骤、退出码与失败判定。新提交继续运行同一套 CI 验证。

## Alternatives considered

重复重跑依赖机器偶然变快；缩小测试发现范围或跳过慢测试会丢失验收。
重新划分分片可以另外优化，但不是为这次完整资源生命周期提供预算的前提。

## Consequences

正常测试和清理可在整体期限内完成；异常卡住的 job 仍受 30 分钟硬上限约束。
分片测试输出的成功数字与 job 完整成功继续分开报告，旧超时不算通过。
