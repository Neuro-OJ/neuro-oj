import { Hono } from "hono";
import { type AuthEnv, authMiddleware } from "../../identity/index.ts";
import { Channels } from "../../../shared/sse/event-bus.ts";
import { createSseStream } from "../../../shared/sse/sse-stream.ts";
import {
  replayToStream,
  subscribeToChannel,
} from "../../../shared/sse/server-helpers.ts";
import { getQueueOverview } from "../services/queue.ts";
import { getSubmission } from "../services/submissions/submissions.ts";

/**
 * submission 域 SSE 路由。
 *
 * 挂载在 `/api/v1` 前缀下（见 app.ts），因此文件内路径为相对路径。
 */
const sse = new Hono<AuthEnv>();

// SSE 端点全部需要认证
sse.use("*", authMiddleware);

/**
 * 提交状态 SSE 端点。
 *
 * 前端 EventSource 连接到 `/api/v1/submissions/:id/events`，
 * 实时接收评测状态变更推送。
 *
 * 事件格式：
 *   event: submission:updated
 *   data: { type: "submission:updated", data: { ... } }
 *
 * 心跳：每 30s 发送 keepalive 事件
 */
sse.get("/submissions/:id/events", async (c) => {
  const { id } = c.req.param();
  const userId = c.get("userId");

  // 校验提交存在并验证访问权限，同时获取当前状态
  const submission = await getSubmission(
    id,
    userId,
    c.get("userRole"),
    c,
  );

  return createSseStream(
    c,
    async ({ stream, closed, close, onUnsubscribe }) => {
      // 如果提交已经处于终态（finished/error），立即推送触发通知并关闭
      if (submission.status === "finished" || submission.status === "error") {
        await stream.writeSSE({
          event: "submission:updated",
          data: JSON.stringify({
            type: "submission:updated",
            id,
          }),
        });
        close();
        return;
      }

      subscribeToChannel(
        onUnsubscribe,
        Channels.submission(id),
        "submission:updated",
        stream,
        () => closed,
        close,
      );

      // 重放缺失事件（先订阅后重放，避免竞态）
      await replayToStream(
        c,
        stream,
        () => closed,
        [Channels.submission(id)],
        "submission:updated",
      );
    },
  );
});

/**
 * 全局队列 SSE 端点。
 *
 * 登录用户可订阅。收到 `queue:changed` 事件后，
 * 前端应调用 GET /api/v1/queue 刷新全量队列数据。
 *
 * 事件格式：
 *   event: queue:changed
 *   data: { type: "queue:changed" }
 */
sse.get("/queue/events", (c) => {
  return createSseStream(
    c,
    async ({ stream, closed, close, onUnsubscribe }) => {
      // 连接建立后立即推送当前队列全量数据（MQTT Retain 语义）
      try {
        await getQueueOverview();
        await stream.writeSSE({
          event: "queue:changed",
          data: JSON.stringify({ type: "queue:changed" }),
        });
      } catch {
        // 获取当前队列失败不影响后续订阅
      }

      subscribeToChannel(
        onUnsubscribe,
        Channels.queue,
        "queue:changed",
        stream,
        () => closed,
        close,
      );

      // 重放缺失事件
      await replayToStream(
        c,
        stream,
        () => closed,
        [Channels.queue],
        "queue:changed",
      );
    },
  );
});

export default sse;
