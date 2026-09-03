import { Hono } from "hono";
import { type AuthEnv, authMiddleware } from "../../identity/index.ts";
import { Channels } from "../../../shared/sse/event-bus.ts";
import { createSseStream } from "../../../shared/sse/sse-stream.ts";
import {
  replayToStream,
  subscribeToChannel,
} from "../../../shared/sse/server-helpers.ts";

/**
 * community 域社区通知 SSE 路由。
 *
 * 需要登录认证，挂载在 `/api/v1` 前缀下。
 */
const communitySse = new Hono<AuthEnv>();

communitySse.use("*", authMiddleware);
/**
 * GET /api/v1/community/notifications/events
 * 社区通知 SSE 端点。
 *
 * 收到 notification:new 事件后前端应刷新通知列表和未读计数。
 * SSE 事件仅作触发器，不包含通知内容。
 */
communitySse.get("/community/notifications/events", (c) => {
  const userId = c.get("userId") as string;
  // 通知端点不启用兜底超时：订阅为常驻连接（与原实现一致）
  return createSseStream(
    c,
    async ({ stream, closed, close, onUnsubscribe }) => {
      subscribeToChannel(
        onUnsubscribe,
        Channels.user(userId),
        "notification:new",
        stream,
        () => closed,
        close,
        (message) => {
          // 仅透传社区通知事件，避免与私信等同一用户通道事件交叉
          try {
            const payload = JSON.parse(message) as { type?: string };
            return payload.type === "notification:new" ? message : null;
          } catch {
            return null;
          }
        },
      );

      // 重放缺失的通知事件
      await replayToStream(
        c,
        stream,
        () => closed,
        [Channels.user(userId)],
        "notification:new",
        (payload, seq) => {
          const p = payload as { type?: string };
          return p.type === "notification:new" ? { ...p, seq } : null;
        },
      );

      // 发送初始化事件，触发代理 flush 响应头
      await stream.writeSSE({ event: "connected", data: "" });
    },
    { safetyTimeoutMs: 0 },
  );
});

export default communitySse;
