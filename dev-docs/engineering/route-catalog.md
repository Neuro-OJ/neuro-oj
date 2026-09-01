# NOJ API 路由目录

> 由 `scripts/gen-route-catalog.ts` 生成，请勿手改。

| 方法 | 路径 | 文件 |
| --- | --- | --- |
| GET | `/` | noj-core/src/routes/rankings.ts |
| GET | `/` | noj-core/src/routes/search.ts |
| GET | `/checkin` | noj-core/src/routes/rankings.ts |
| GET | `/community/notifications/events` | noj-core/src/routes/sse.ts |
| GET | `/contests/:id/events` | noj-core/src/routes/sse.ts |
| GET | `/health` | noj-core/src/routes/health.ts |
| GET | `/me` | noj-core/src/routes/rankings.ts |
| GET | `/queue/events` | noj-core/src/routes/sse.ts |
| GET | `/stats` | noj-core/src/routes/stats.ts |
| GET | `/submissions/:id/events` | noj-core/src/routes/sse.ts |
| GET | `/submissions/stats/events` | noj-core/src/routes/sse.ts |
| GET | `NOJ_ENV` | noj-core/src/routes/health.ts |
| GET | `userId` | noj-core/src/routes/search.ts |
| GET | `userId` | noj-core/src/routes/sse.ts |
| GET | `userId` | noj-core/src/routes/sse.ts |
| GET | `userId` | noj-core/src/routes/sse.ts |
| GET | `userRole` | noj-core/src/routes/search.ts |
| GET | `userRole` | noj-core/src/routes/sse.ts |
| GET | `userRole` | noj-core/src/routes/sse.ts |
