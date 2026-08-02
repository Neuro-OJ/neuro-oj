## Why

当前每日签到功能"有名无实"：后端 `check_ins` 表完整记录每日签到与连续天数，但数据产生后没有任何下游消费者：

- `check_ins` 数据在 rankings / stats / dashboard / users 等服务中零引用
- 无历史查询：看不到签到日历、累计签到天数、月度活跃
- streak 只在首页点击签到的动画中短暂展示；**今日未签到则看不到自己的连续天数**
- 无排行榜 / 个人主页展示，他人也无法看到活跃度

需要把签到数据转化为可查询、可展示的活跃度统计，让"活跃度"成为用户档案与社区的可见信号。

## What Changes

- 后端新增签到统计接口 `GET /api/v1/checkin/stats`：返回累计签到天数、当前连续天数、最长连续天数、本月签到天数、最近签到日期
- 后端新增签到历史接口 `GET /api/v1/checkin/history?days=N`：返回最近 N 天签到日历（含今日状态），支持日历渲染
- 调整 `GET /api/v1/checkin/today`：今日未签到时返回**进行中的连续天数**（昨日 streak），首页不再"看不到自己的连续天数"
- 后端新增签到活跃榜 `GET /api/v1/rankings/checkin?month=YYYY-MM`：按月度签到天数排序（可含当前用户自身排名）
- 前端个人主页（`pages/users/[id].vue`）新增活跃度卡片：连续天数、累计天数、本月签到日历
- 首页 `CheckInCard.vue` 未签到时展示当前连续天数

## Capabilities

### New Capabilities

<!-- 无：活跃度统计是对现有 checkin 能力（specs/checkin）的扩展 -->

### Modified Capabilities

- `checkin`: 扩展签到能力——新增统计/历史查询接口、今日未签到时的连续天数语义、月度活跃榜

## Impact

- **代码**：`noj-core/src/services/checkin.ts`（新增 stats/history/ranking 查询）、`noj-core/src/routes/checkin.ts`（新增 2 个端点）、`noj-core/src/routes/rankings.ts` 或独立活跃榜路由、`noj-ui/pages/users/[id].vue`（活跃度卡片）、`noj-ui/components/feature/CheckInCard.vue`（连续天数展示）
- **测试**：`noj-core/tests/services/checkin.test.ts` 与 `tests/routes/checkin.test.ts` 补充 stats/history/leaderboard 用例
- **数据库**：无迁移（`check_ins` 表已含全部所需数据：每行记录当日 streak，`MAX(streak)` 即历史最长连续天数）
- **环境变量 / 依赖**：无新增
