import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { authMiddleware } from "../middleware/auth.ts";
import { ForbiddenError } from "../lib/errors.ts";
import { onEvent } from "../lib/event-bus.ts";
import { getSubmission } from "../services/submissions.ts";
import { getQueueOverview } from "../services/queue.ts";

/**
 * SSE（Server-Sent Events）路由。
 *
 * 通过 Redis Pub/Sub 事件总线接收评测状态变更和队列变更通知，
 * 以 SSE 格式流式推送给前端浏览器。
 *
 * 路由挂载在 `/api/v1` 前缀下（见 app.ts 中的 app.route("/api/v1", sse)），
 * 因此本文件内的路径为相对路径（如 `/submissions/:id/events`）。
 *
 * 认证复用现有 authMiddleware。authMiddleware 通过 c.set("userId") /
 * c.set("userRole") 注入用户信息，此处通过 c.get("userId") / c.get("userRole") 读取。
 */
const sse = new Hono<{ Variables: { userId: string; userRole: string } }>();

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
  const userId = c.get("userId") as string | undefined;

  // 校验提交存在并验证访问权限，同时获取当前状态
  const submission = await getSubmission(id, userId);

  return streamSSE(c, async (stream) => {
    // 当前 SSE 流是否已关闭（防止重复清理）
    let streamClosed = false;
    let resolveAbort: (() => void) | null = null;

    // 关闭流并清理资源
    function closeStream() {
      if (streamClosed) return;
      streamClosed = true;
      clearInterval(keepAlive);
      unsub();
      if (resolveAbort) resolveAbort();
    }

    // 如果提交已经处于终态（finished/error），立即推送触发通知并关闭
    if (submission.status === "finished" || submission.status === "error") {
      await stream.writeSSE({
        event: "submission:updated",
        data: JSON.stringify({
          type: "submission:updated",
          id: id,
        }),
      });
      closeStream();
      return;
    }

    const unsub = onEvent(
      `noj:events:submission:${id}`,
      (_channel, message) => {
        if (streamClosed) return;
        stream.writeSSE({
          event: "submission:updated",
          data: message,
        }).catch(() => {
          closeStream();
        });
      },
    );

    // 30s 心跳保持连接（防止代理/中间件超时断连）
    const keepAlive = setInterval(() => {
      if (streamClosed) return;
      stream.writeSSE({ event: "keepalive", data: "" }).catch(() => {
        closeStream();
      });
    }, 30_000);

    // 保持 stream 活跃，直到客户端断开
    await new Promise<void>((resolve) => {
      resolveAbort = resolve;
      stream.onAbort(() => {
        closeStream();
      });
    });
  });
});

/**
 * 全局队列 SSE 端点。
 *
 * 仅管理员可订阅。收到 `queue:changed` 事件后，
 * 前端应调用 GET /api/v1/queue 刷新全量队列数据。
 *
 * 事件格式：
 *   event: queue:changed
 *   data: { type: "queue:changed" }
 */
sse.get("/queue/events", (c) => {
  // 仅管理员可订阅队列变更
  if (c.get("userRole") !== "admin") {
    throw new ForbiddenError("仅管理员可访问", "FORBIDDEN");
  }

  return streamSSE(c, async (stream) => {
    let streamClosed = false;
    let resolveAbort: (() => void) | null = null;

    function closeStream() {
      if (streamClosed) return;
      streamClosed = true;
      clearInterval(keepAlive);
      unsub();
      if (resolveAbort) resolveAbort();
    }

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

    const unsub = onEvent(
      "noj:events:queue",
      (_channel, message) => {
        if (streamClosed) return;
        stream.writeSSE({
          event: "queue:changed",
          data: message,
        }).catch(() => {
          closeStream();
        });
      },
    );

    const keepAlive = setInterval(() => {
      if (streamClosed) return;
      stream.writeSSE({ event: "keepalive", data: "" }).catch(() => {
        closeStream();
      });
    }, 30_000);

    await new Promise<void>((resolve) => {
      resolveAbort = resolve;
      stream.onAbort(() => {
        closeStream();
      });
    });
  });
});

export default sse;
