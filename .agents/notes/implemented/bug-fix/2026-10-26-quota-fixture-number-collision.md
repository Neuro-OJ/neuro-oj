# Agent Note: 稳定升级额度夹具题号

Status: implemented

## Problem

`versioning-upgrade-quota-bucket.test.ts` 使用 92500～93399 的随机题号。Domain
测试
并行共享测试数据库时，该窄区间会与其它版本夹具发生唯一键碰撞，使额度桶验收在
进入业务断言前因 `problems_domain_number_unique` 失败。

## Decision

按夹具 tag 计算稳定哈希，并放入本文件专用的 5000000～5099999 题号区间。相同 tag
在一次测试中保持可复现，不同用例 tag 保持独立；题号不再依赖随机数或时间窗口。

## Alternatives considered

- 扩大随机区间或捕获唯一键后重试：放弃，仍无法提供确定性，也会掩盖夹具隔离问题。
- 修改生产题号分配逻辑：放弃，失败发生在测试夹具建题阶段，与生产逻辑无关。

## Consequences

额度桶测试的建题步骤不再因并行 Domain 夹具随机碰撞而产生假阴性；后续失败能够真实
反映额度桶映射、幂等或升级派发行为。
