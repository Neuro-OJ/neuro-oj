# checkin — 每日签到

每日签到、今日状态、签到统计/历史与月度签到榜。签到榜由
`read-models/queries/routes/rankings.ts`（`GET /api/v1/rankings/checkin`）调用
`getCheckinLeaderboard` 暴露。原位于
`modules/access/identity/{routes,services}/checkin.ts`。

| 文件                    | 职责                                                                      |
| ----------------------- | ------------------------------------------------------------------------- |
| `index.ts`              | 唯一对外出口：`feature` 声明 + 供其他功能/旧模块使用的函数与类型          |
| `routes.ts`             | `/api/v1/checkin`、`/checkin/today`、`/checkin/stats`、`/checkin/history` |
| `service.ts`            | 签到写事务、连续天数、统计、历史、签到榜                                  |
| `tests/routes.test.ts`  | 路由测试（401 / 2xx / 409）；`deno task test:domain checkin`              |
| `tests/service.test.ts` | 服务测试（幂等、streak、统计、榜）                                        |

关键约束：

- 表 `check_ins` 定义在 `src/shared/db/schema/identity.ts`，不随本功能移动。
- `POST /checkin` 按账号维度限流（60s/10，`enforceCheckinRateLimit`），
  只按账号不按 IP（NAT 下同班同学会互相顶掉）。
- `/stats`、`/history`：无 `user_id` 时返回本人（需登录），带 `user_id` 时公开。
- 原 `identityRouter` 上无作用于 `/checkin` 的 `use()`
  中间件，鉴权沿用各处理函数上的 `authMiddleware` /
  `optionalAuthMiddleware`，行为不变。
