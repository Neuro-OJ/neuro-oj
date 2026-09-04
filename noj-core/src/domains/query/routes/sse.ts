import { Hono } from "hono";
import { Channels } from "../../../shared/sse/event-bus.ts";
import { createSseStream } from "../../../shared/sse/sse-stream.ts";
import {
  replayToStream,
  subscribeToChannel,
} from "../../../shared/sse/server-helpers.ts";
import {
  getCachedTodayStats,
  getCachedTotalStats,
} from "../services/stats-cache.ts";

/**
 * query 域公开统计 SSE 路由。
 *
 * 无鉴权，挂载在 `/api/v1` 前缀下。
 */
const statsSse = new Hono();

statsSse.get("/submissions/stats/events", (c) => {
  return createSseStream(
    c,
    async ({ stream, closed, onUnsubscribe }) => {
      // 连接建立后立即推送当前统计数据（类似 MQTT Retain 语义）
      try {
        const [total, today] = await Promise.all([
          getCachedTotalStats(),
          getCachedTodayStats(),
        ]);
        await stream.writeSSE({
          event: "stats:updated",
          data: JSON.stringify({ type: "stats:updated", total, today }),
        });
      } catch {
        // 初始化失败不影响后续订阅
      }

      subscribeToChannel(
        onUnsubscribe,
        Channels.stats,
        "stats:updated",
        stream,
        () => closed,
        () => {},
        async (message) => {
          try {
            const [total, today] = await Promise.all([
              getCachedTotalStats(),
              getCachedTodayStats(),
            ]);
            return JSON.stringify({
              type: "stats:updated",
              total,
              today,
              ...JSON.parse(message),
            });
          } catch {
            // 静默失败
            return null;
          }
        },
      );

      // 重放缺失事件
      await replayToStream(
        c,
        stream,
        () => closed,
        [Channels.stats],
        "stats:updated",
      );
    },
  );
});

export default statsSse;
