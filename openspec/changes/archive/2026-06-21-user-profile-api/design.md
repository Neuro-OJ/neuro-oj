## Context

用户主页 API 需要聚合多个表的数据（users、submissions、evaluation_results、problems），返回用户统计、已通过题目和最近提交活动。目前 noj-core 已有用户基础信息查询（`GET /api/v1/auth/me`）和提交列表查询（`GET /api/v1/submissions`），但缺少聚合视图。

## Goals / Non-Goals

**Goals:**
- 提供 `GET /api/v1/users/:id/profile` 端点，返回用户主页所需全部数据
- 统计信息通过 SQL 聚合查询实时计算，不引入冗余统计字段
- 已通过题目列表去重，附带题目难度和通过时间
- 最近提交活动取最近 10 条提交记录（不含 code 字段）
- 支持查看任意用户主页（公开数据），无需认证

**Non-Goals:**
- 不实现用户资料编辑功能（头像、bio 等）
- 不引入缓存层（统计实时计算即可，主页访问频率不高）
- 不实现关注/粉丝等社交功能
- 不修改现有用户表结构

## Decisions

### 1. 单请求聚合 vs 多次查询

**选择**：单请求内多次查询（3 次 SQL），而非单次大 JOIN。

**理由**：用户主页需要三类不同粒度的数据——统计聚合、已通过题目列表（去重）、最近提交列表。单次 JOIN 会导致数据膨胀（统计行数 × 题目数 × 提交数），且去重逻辑复杂。三次独立查询更清晰、更易维护，且对数据库优化器更友好。

### 2. 新建 `services/users.ts` vs 扩展 `services/auth.ts`

**选择**：新建 `services/users.ts`。

**理由**：用户主页功能与认证/登录的关注点不同，放在独立文件中职责更清晰。`services/auth.ts` 保持专注于认证流程。

### 3. 公开访问 vs 需认证

**选择**：`GET /api/v1/users/:id/profile` 无需认证，公开可访问。

**理由**：用户主页是公开信息（类似 GitHub 个人主页），展示用户名、统计和通过的题目。提交列表中的 code 字段已排除，不涉及敏感信息。OJ 系统鼓励用户分享自己的主页。

### 4. 统计字段命名

**选择**：`total_submissions`、`accepted`（评测结果为 Accepted 的提交数）、`acceptance_rate`（accepted / total_submissions）、`solved_count`（通过的**不同题目**数）。

**理由**：`accepted` 是提交维度的通过次数（可重复），`solved_count` 是题目维度的去重解题数。两者含义不同，分开返回更清晰。

### 5. 已通过题目的判定标准

**选择**：存在 `evaluation_results` 且 `status = 'Accepted'` 的提交对应的题目。

**理由**：`evaluation_results.status` 存储的是评测结果状态（Accepted / WrongAnswer 等），与 `submissions.status`（pending/judging/finished/error）不同。以评测结果为准更准确。

## Risks / Trade-offs

- **[性能]** 用户主页每次请求执行 3 次 SQL 查询。对于大多数用户（提交数 < 1000），查询在毫秒级完成。若未来出现大量提交的用户，可考虑引入 Redis 缓存。
- **[公开数据]** 公开访问意味着任何人都可以枚举用户 ID 查看主页。用户 ID 使用 UUID，不可猜测，风险可控。
- **[通过率精度]** `acceptance_rate` 使用浮点数，前端可自行格式化显示。返回 0-1 之间的小数（如 0.714），而非百分比字符串。
