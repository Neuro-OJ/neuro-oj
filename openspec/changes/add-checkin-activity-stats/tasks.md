## 1. 后端：统计与历史接口

- [ ] 1.1 `services/checkin.ts` 新增 `getCheckinStats(userId, month?)`：累计天数（COUNT）、当前连续天数（今日未签到时取昨日 streak）、最长连续天数（MAX(streak)）、月签到天数、最近签到日期
- [ ] 1.2 `services/checkin.ts` 新增 `getCheckinHistory(userId, days)`：`days ∈ {30, 90, 365}` 校验，返回最近 N 天已签到日期数组 + total_days
- [ ] 1.3 `routes/checkin.ts` 注册 `GET /stats` 与 `GET /history`（authMiddleware），非法参数抛 400
- [ ] 1.4 调整 `getTodayCheckIn`：今日未签到时返回昨日 streak（昨日未签到为 0）
- [ ] 1.5 测试：`tests/services/checkin.test.ts` 覆盖统计/历史/未签到 streak 语义；`tests/routes/checkin.test.ts` 覆盖端点与 401/400

## 2. 后端：签到活跃榜

- [ ] 2.1 新增 `getCheckinLeaderboard(month, page, perPage, userId?)`：按用户分组计数当月签到天数，倒序 + 用户名升序分页，登录时计算 `user_rank`
- [ ] 2.2 路由：`routes/rankings.ts` 注册 `GET /checkin`（optionalAuth），`month` 缺省为当前 UTC 月
- [ ] 2.3 测试：`tests/routes/rankings.test.ts` 或 checkin 测试补充活跃榜分页/排序/user_rank 用例

## 3. 前端展示

- [ ] 3.1 个人主页 `pages/users/[id].vue` 新增「活跃度」卡片：`/api/v1/checkin/stats` + `/api/v1/checkin/history?days=30`（他人主页用公开只读口径或由后端按用户查询），日历 grid 渲染已签到日期
- [ ] 3.2 首页 `CheckInCard.vue`：未签到文案展示 `/checkin/today` 返回的 `streak`（连续天数），按钮状态不变
- [ ] 3.3 验证：`deno task lint` + `deno task fmt` + `deno task test`（noj-core）通过；`noj-ui` 构建通过

## 4. 回归与归档

- [ ] 4.1 手动验证：签到后 stats/history 数值一致；跨日未签连续天数语义正确；活跃榜分页正常
- [ ] 4.2 同步 `openspec/specs/checkin/spec.md` 主规范增量（/opsx:sync 或归档时）
- [ ] 4.3 归档 OpenSpec 变更（/opsx:archive 流程）
