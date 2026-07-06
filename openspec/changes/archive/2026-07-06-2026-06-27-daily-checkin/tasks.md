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

## 5. 验证

- [ ] 5.1 后端：`deno fmt --check && deno lint` 通过
- [ ] 5.2 后端：`deno task migrate` 成功，journal 7 条
- [ ] 5.3 前端：`deno fmt --check && deno lint` 通过
- [ ] 5.4 手动：登录后 POST /api/v1/checkin 返回 streak=1
- [ ] 5.5 手动：同日再次 POST 返回 400
- [ ] 5.6 手动：GET /today 返回正确状态

## 6. 文档

- [ ] 6.1 更新 `noj-core/AGENTS.md` 添加 `checkin` 路由到 API 路由表
- [ ] 6.2 更新 `noj-core/AGENTS.md` 添加 `check_ins` 表到数据库 Schema 表
