## Why

竞赛系统的代码审查发现赛后访问控制与既定规则不一致，且 ICPC 平局时的确定性排序规则未在规范中声明。修复这些问题可避免竞赛结束后题目无法公开，并使实现与规格保持一致。

## What Changes

- 允许所有已登录用户在竞赛结束后查看竞赛题目；赛前和进行中的访问规则维持不变。
- 明确 ICPC 相同解题数、罚时和最后通过时间时，按报名时间、用户 ID 稳定排序。
- 为两项行为补充路由和排名回归测试。

## Capabilities

### New Capabilities

- `contest-review-corrections`: 定义竞赛审查修复后的题目访问控制与 ICPC 平局排序规则。

### Modified Capabilities

- 无。

## Impact

- 影响 `noj-core/src/routes/contests.ts` 的题目访问守卫。
- 影响 `noj-core/src/services/contest-ranking.ts` 的既有排序规则说明。
- 影响竞赛路由和排名服务测试；不新增 API、数据库迁移或依赖。
