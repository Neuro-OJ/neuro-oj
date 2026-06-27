# 任务清单

## 1. 数据库

- [ ] 1.1 创建 `drizzle/0006_check_ins.sql` 迁移文件
  - [ ] CREATE TABLE check_ins
  - [ ] CREATE UNIQUE INDEX check_ins_user_date_unique
- [ ] 1.2 更新 `drizzle/meta/_journal.json` 注册 idx=6 迁移
- [ ] 1.3 更新 `src/db/schema.ts` 添加 `checkIns` 表定义（与 SQL 保持一致）

## 2. 后端服务层

- [ ] 2.1 创建 `src/services/checkin.ts`
  - [ ] 实现 `checkIn(userId)` 函数
  - [ ] 实现 `getTodayCheckIn(userId)` 函数
  - [ ] 定义 `CheckInResponse` 接口

## 3. 后端路由层

- [ ] 3.1 创建 `src/routes/checkin.ts`
  - [ ] POST `/` 路由调用 `checkIn`
  - [ ] GET `/today` 路由调用 `getTodayCheckIn`
- [ ] 3.2 在 `src/app.ts` 注册 `/api/v1/checkin` 路由

## 4. 前端组件

- [ ] 4.1 创建 `components/CheckInCard.vue`
  - [ ] Props: isLoggedIn, username, checkedIn, streakCount, checkInLoaded
  - [ ] Emits: checkin
  - [ ] 模板：未登录态 / 未签到态 / 已签到态
  - [ ] 样式：使用 Tailwind CSS，符合项目主题

## 5. 验证（评审 L1：改为自动化测试）

- [ ] 5.1 后端：`deno fmt --check && deno lint` 通过
- [ ] 5.2 后端：`deno task migrate` 成功，journal 7 条
- [ ] 5.3 前端：`deno fmt --check && deno lint` 通过
- [ ] 5.4 自动化：`tests/services/checkin.test.ts` 通过
  - 首次签到 streak=1
  - 重复签到抛 ConflictError（评审 M3）
  - **并发签到两个都返回正确**（评审 H2：1 个 200 + 1 个 409，无 500）
  - 昨日签到后今日签到 streak 累加
  - 断签后签到 streak 重置为 1
  - getTodayCheckIn 未签到/已签到分别返回正确
- [ ] 5.5 自动化：`tests/routes/checkin.test.ts` 通过
  - 未登录 POST/GET 都返回 401
  - 已登录首次 POST 返回 200 + streak=1
  - 同日重复 POST 返回 409 CONFLICT_ERROR
  - GET /today 已签到/未签到分别正确
- [ ] 5.6 自动化：`noj-tests/e2e/09_checkin.test.ts` 通过
  - 6 个场景覆盖：401/200/409/concurrent
- [ ] 5.7 后端：`deno task test` 全部通过

## 6. 文档

- [ ] 6.1 更新 `noj-core/AGENTS.md` 添加 `checkin` 路由到 API 路由表
- [ ] 6.2 更新 `noj-core/AGENTS.md` 添加 `check_ins` 表到数据库 Schema 表
