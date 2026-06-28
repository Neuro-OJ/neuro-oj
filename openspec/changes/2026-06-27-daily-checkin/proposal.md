## Why

当前 Neuro OJ 缺少用户日常活跃度激励机制。用户完成注册登录后无明确目标驱动持续回访，社区黏性弱。需要引入每日签到机制：登录用户可每日签到一次，记录连续签到天数，作为简单的活跃度反馈。

## What Changes

- **新增** 签到数据表 `check_ins`：记录用户每日签到状态及连续签到天数
- **新增** 后端服务：
  - `POST /api/v1/checkin`：执行签到，每日仅限一次，重复签到返回 400
  - `GET /api/v1/checkin/today`：查询当前用户今日是否已签到及当前连续天数
- **新增** 前端组件 `CheckInCard.vue`：嵌入首页的签到卡片，展示签到状态、连续天数、未登录时引导登录
- **更新** 首页 `pages/index.vue`：集成签到卡片、随机题目推荐、最新提交三栏布局
- **数据库迁移**：`drizzle/0006_check_ins.sql` 创建表结构及 `(user_id, checkin_date)` 唯一约束

## Capabilities

### New Capabilities
- `checkin`: 每日签到功能：用户每日可签到一次，连续签到自动累计天数，断签重置

### Modified Capabilities
- `database-schema`: 新增 `check_ins` 表
- `home-page`: 首页布局重构，集成签到卡片、随机题目推荐、最新提交三个侧边模块

## Impact

- **noj-core**:
  - 新增 `drizzle/0006_check_ins.sql` 迁移
  - 新增 `src/db/schema.ts` 的 `checkIns` 表定义
  - 新增 `src/services/checkin.ts` 服务层（checkIn、getTodayCheckIn）
  - 新增 `src/routes/checkin.ts` 路由层
  - `src/app.ts` 注册 `/api/v1/checkin` 路由
- **noj-ui**:
  - 新增 `components/CheckInCard.vue` 组件
  - 修改 `pages/index.vue` 集成签到卡片
  - 暂未修改其他页面
- **数据库**: 需执行迁移 0006 创建 `check_ins` 表
