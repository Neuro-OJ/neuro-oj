## 1. 概述

每日签到功能：登录用户可每日签到一次，记录连续签到天数。前端通过嵌入首页的卡片展示签到状态。

## 2. 数据模型

新增 `check_ins` 表：

| 字段 | 类型 | 约束 | 说明 |
|------|------|------|------|
| `id` | TEXT | PRIMARY KEY | UUID |
| `user_id` | TEXT | NOT NULL, FK→users.id | 签到用户 |
| `checkin_date` | TEXT | NOT NULL | 签到日期，格式 YYYY-MM-DD（UTC） |
| `streak` | INTEGER | NOT NULL, DEFAULT 1 | 连续签到天数 |
| `created_at` | TEXT | NOT NULL | 记录创建时间（ISO 8601） |

唯一约束：`UNIQUE (user_id, checkin_date)` —— 防止同日重复签到。

## 3. 关键 SQL

### 创建表
```sql
CREATE TABLE IF NOT EXISTS check_ins (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  checkin_date TEXT NOT NULL,
  streak INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS check_ins_user_date_unique
  ON check_ins (user_id, checkin_date);
```

### 查询今日签到
```sql
SELECT streak FROM check_ins
WHERE user_id = ? AND checkin_date = ?
LIMIT 1;
```

### 查询昨日签到（用于计算 streak）
```sql
SELECT streak FROM check_ins
WHERE user_id = ? AND checkin_date = ?
LIMIT 1;
```

### 插入今日签到
```sql
INSERT INTO check_ins (id, user_id, checkin_date, streak, created_at)
VALUES (?, ?, ?, ?, ?);
```

## 4. 业务逻辑

### 签到流程
1. 接收 `POST /api/v1/checkin` 请求（需登录）
2. 计算今日日期 `today = new Date().toISOString().slice(0, 10)` （UTC）
3. 计算昨日日期 `yesterday = today - 1 day`
4. 查询昨日签到记录：取其 `streak` 字段
5. 计算新 `streak = (yesterday_streak ?? 0) + 1`
6. 原子插入：`INSERT ... ON CONFLICT (user_id, checkin_date) DO NOTHING RETURNING id`
   - 若插入成功（`returning` 有返回值）→ 继续步骤 7
   - 若插入失败（`returning` 空集，并发竞态已有人先插入）→ 抛 `ConflictError("今天已签到")`
7. 返回 `{ checked_in: true, streak }`

### 连续天数规则
- 首次签到：streak = 1
- 连续每日签到：streak 累加
- 断签 1 天：再签到时 streak 重置为 1（因为昨日无记录）
- 边界处理：使用 UTC 日期，跨时区签到可能产生预期外行为

## 5. API 端点

### POST /api/v1/checkin
- 鉴权：必需
- 请求体：无
- 响应 200：`{ "data": { "checked_in": true, "streak": 5 } }`
- 响应 409：`{ "error": "今天已签到", "code": "CONFLICT_ERROR" }`

### GET /api/v1/checkin/today
- 鉴权：必需
- 请求体：无
- 响应 200（已签到）：`{ "data": { "checked_in": true, "streak": 5 } }`
- 响应 200（未签到）：`{ "data": { "checked_in": false, "streak": 0 } }`

## 6. 关键决策

| 决策 | 选择 | 理由 |
|------|------|------|
| 日期粒度 | UTC 日期（YYYY-MM-DD） | 简化时区处理，跨时区用户接受可能偏移 |
| 重复签到 | 服务端校验 + DB UNIQUE 约束，返回 409 ConflictError | 防止前端绕过，并发竞态由 ON CONFLICT DO NOTHING 兜底 |
| 唯一约束 | DB 层 UNIQUE (user_id, checkin_date) | 双重防护，并发签到最终由 DB 拒绝 |
| streak 计算 | 查昨日 + 1 | 简单查询 O(1)，无需扫描全表 |
| 跨时区行为 | 不处理 | 简化实现，明确已知限制 |

## 7. 已知限制

- **时区敏感**：使用 UTC 日期，东八区用户 0-8 点签到算前一天
- **无历史查询**：仅支持今日查询，不支持历史签到日历
- **无奖励机制**：纯展示，不关联积分/权限等
- **断签不通知**：用户不会收到"今天还没签到"提醒
- **无专用限流**：当前 main 分支尚未合入 issue #73 限流中间件
  （PR #74），签到端点暂不加 IP 限流；限流基础设施合并后单独 PR 接入。
  当前并发竞态由 SQL UNIQUE 约束 + ON CONFLICT DO NOTHING 兜底（评审 H2）。

## 8. 回滚方案

```sql
DROP TABLE IF EXISTS check_ins;
```

## 9. 前端集成

`CheckInCard.vue` 组件契约：
- Props: `isLoggedIn`, `username`, `checkedIn`, `streakCount`, `checkInLoaded`
- Emits: `checkin` (无参数)
- 行为：
  - 未登录：显示"登录以解锁" + 登录按钮
  - 已登录 + 未签到：显示"签到"按钮，点击 emit `checkin`
  - 已登录 + 已签到：显示"已签到" + "你已经连续签到 N 天"
