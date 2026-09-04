# NOJ SSE 事件目录

> 由 `scripts/gen-event-catalog.ts` 生成，请勿手改。

| 频道 | 发布位置 |
| --- | --- |
| `submission` | noj-core/src/domains/submission/routes/sse.ts<br>noj-core/src/domains/submission/services/submissions/submissions-result.ts |
| `queue` | noj-core/src/domains/submission/mq/consumer.ts<br>noj-core/src/domains/submission/routes/sse.ts<br>noj-core/src/domains/submission/services/queue.ts<br>noj-core/src/domains/submission/services/self-tests.ts<br>noj-core/src/domains/submission/services/submissions/artifact-submissions.ts<br>noj-core/src/domains/submission/services/submissions/submissions-crud.ts<br>noj-core/src/domains/submission/services/submissions/submissions-rejudge.ts |
| `user` | noj-core/src/domains/community/routes/sse.ts<br>noj-core/src/domains/community/services/notifications.ts<br>noj-core/src/domains/messaging/routes/conversations.ts<br>noj-core/src/domains/messaging/services/messages.ts |
| `contestRanking` | noj-core/src/domains/contest/routes/sse.ts<br>noj-core/src/domains/submission/services/submissions/submissions-result.ts |
| `contestSubmission` | noj-core/src/domains/contest/routes/sse.ts<br>noj-core/src/domains/submission/services/submissions/artifact-submissions.ts<br>noj-core/src/domains/submission/services/submissions/submissions-crud.ts |
| `stats` | noj-core/src/domains/query/routes/sse.ts<br>noj-core/src/domains/query/services/stats-cache.ts |
| `announcements` | noj-core/src/domains/system/routes/announcements.ts<br>noj-core/src/domains/system/services/announcements.ts |
