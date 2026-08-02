## Context

### 现状

- `check_ins` 表：`user_id + checkin_date` 唯一，每行记录当日的 `streak`（连续签到天数）；日期统一使用 **UTC**（`todayUtc()`，`services/checkin.ts`）
- 端点：`POST /api/v1/checkin`（签到）、`GET /api/v1/checkin/today`（今日状态）
- 唯一数据消费者：首页 `CheckInCard.vue`；今日未签到时 `getTodayCheckIn` 返回 `{ checked_in: false, streak: 0 }`，连续天数不可见
- streak 计算规则：昨日有记录 → 昨日 streak + 1；否则重置为 1（签到逻辑已实现，本期不变）

### 数据可用性

`check_ins` 已有全部所需数据，无需新表/迁移：

| 指标 | 查询方式 |
|------|---------|
| 累计签到天数 | `COUNT(*)` |
| 当前连续天数（今日未签到时） | 昨日记录 streak（若昨日签到） |
| 最长连续天数 | `MAX(streak)`（每行 streak 是该段连续期的峰值） |
| 月度签到天数 | `COUNT(*) WHERE checkin_date LIKE 'YYYY-MM%'` |
| 月度活跃榜 | 按 `user_id` 分组计数，倒序 |

## Goals / Non-Goals

**Goals:**
- 提供签到统计与历史查询接口（个人数据，需登录）
- 今日未签到也能看到进行中的连续天数
- 提供月度签到活跃榜（公开只读，与用户榜一致）
- 个人主页与首页展示活跃度

**Non-Goals:**
- 不做签到奖励 / 积分体系（issue #184 可选方向，本期排除）
- 不做断签提醒
- 不引入时区个性化（保持 UTC 统一，与现有实现一致）
- 不改 streak 计算规则本身
- 不把提交等行为纳入活跃度（本期仅统计签到）

## Decisions

### D1: 复用 check_ins 表，零迁移

**选择**：所有新指标均由 `check_ins` 聚合得出，不新增表、不写迁移。
**理由**：表中每行 streak 即该连续段峰值，`MAX(streak)` 即可给出历史最长连续天数；累计/月度计数可直接 COUNT。

### D2: 统计接口 `GET /api/v1/checkin/stats`（需登录，返回本人）

响应：`{ total_days, current_streak, max_streak, month_days, last_checkin_date }`

- `current_streak`：今日已签到 → 今日 streak；未签到 → 昨日 streak（昨日未签到则为 0）
- `month_days`：默认当月（UTC）签到天数，支持 `month=YYYY-MM` 查询参数

### D3: 历史接口 `GET /api/v1/checkin/history?days=30|90|365`（需登录，返回本人）

响应：`{ days: ["YYYY-MM-DD", ...], total_days }`，`days` 为最近 N 天（含今日）中已签到的日期升序数组，供日历组件直接渲染。

### D4: `GET /api/v1/checkin/today` 语义微调

今日未签到时返回 `{ checked_in: false, streak: <昨日 streak> }`（昨日未签到则为 0），使首页签到卡始终可见连续天数。已签到行为不变（`checked_in: true` + 今日 streak）。

### D5: 签到活跃榜 `GET /api/v1/rankings/checkin?month=YYYY-MM&page&per_page`

- 公开只读（沿用 optionalAuth：登录时额外返回 `user_rank`）
- 排序：当月签到天数 DESC → 用户名 ASC；分页与现有 rankings 一致
- 响应行：`{ user_id, username, days, rank, is_current_user? }`

### D6: 前端展示出口

- 个人主页新增「活跃度」卡片：当前连续天数、累计签到天数、本月签到日历（轻量日历 grid，不引新依赖）
- 首页 `CheckInCard` 未签到文案改为「已连续签到 N 天」（N 来自 `/checkin/today`）

## 影响面

- `noj-core/src/services/checkin.ts`：新增 `getCheckinStats` / `getCheckinHistory` / `getCheckinLeaderboard`（或独立 `checkin-ranking.ts`）
- `noj-core/src/routes/checkin.ts`：注册 stats / history
- `noj-core/src/routes/rankings.ts`：注册 `/checkin` 子路由（或独立路由文件，随实现选择）
- `noj-ui/pages/users/[id].vue`、`noj-ui/components/feature/CheckInCard.vue`
- 测试：`tests/services/checkin.test.ts`、`tests/routes/checkin.test.ts`、`tests/routes/rankings.test.ts`（如路由拆分）
