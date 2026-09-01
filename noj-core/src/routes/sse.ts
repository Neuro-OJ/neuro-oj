import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { authMiddleware, optionalAuthMiddleware } from "../middleware/auth.ts";
import type { OptionalAuthEnv } from "../middleware/auth.ts";
import { Channels, onEvent } from "../lib/event-bus.ts";
import { createSseStream } from "../lib/sse-stream.ts";
import { replaySseEvents } from "../lib/sse-events.ts";
import { getSubmission } from "../domains/submission/index.ts";
import { getQueueOverview } from "../domains/submission/index.ts";
import { checkPermission } from "../lib/permissions.ts";
import {
  getCachedTodayStats,
  getCachedTotalStats,
} from "../services/stats-cache.ts";
import { getContest, getContestRanking } from "../domains/contest/index.ts";
import { NotFoundError } from "../lib/errors.ts";

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

/** 从 Last-Event-ID 头或 afterSeq 查询参数解析游标。 */
function lastEventId(
  c: {
    req: {
      header(key: string): string | undefined;
      query(key: string): string | undefined;
    };
  },
): number {
  const raw = c.req.header("last-event-id") ?? c.req.query("afterSeq") ?? "0";
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

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

      onUnsubscribe(
        onEvent(
          Channels.submission(id),
          (_channel, message) => {
            if (closed) return;
            stream.writeSSE({
              event: "submission:updated",
              data: message,
            }).catch(() => {
              close();
            });
          },
        ),
      );

      // 重放缺失事件（先订阅后重放，避免竞态）
      const after = lastEventId(c);
      const missed = await replaySseEvents(
        [Channels.submission(id)],
        after,
        200,
      );
      for (const ev of missed) {
        if (closed) return;
        await stream.writeSSE({
          event: "submission:updated",
          id: String(ev.id),
          data: JSON.stringify({ ...(ev.payload as object), seq: ev.id }),
        });
      }
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

      onUnsubscribe(
        onEvent(
          Channels.queue,
          (_channel, message) => {
            if (closed) return;
            stream.writeSSE({
              event: "queue:changed",
              data: message,
            }).catch(() => {
              close();
            });
          },
        ),
      );

      // 重放缺失事件
      const after = lastEventId(c);
      const missed = await replaySseEvents([Channels.queue], after, 200);
      for (const ev of missed) {
        if (closed) return;
        await stream.writeSSE({
          event: "queue:changed",
          id: String(ev.id),
          data: JSON.stringify({ ...(ev.payload as object), seq: ev.id }),
        });
      }
    },
  );
});

/**
 * 统计数据 SSE 端点（公开，无需认证）。
 *
 * 首页最新评测卡片订阅此端点，收到 `stats:updated` 事件后刷新统计数据。
 * 相比轮询，减少了服务端全表扫描频率。
 *
 * 事件格式：
 *   event: stats:updated
 *   data: { type: "stats:updated", total: {...}, today: {...} }
 */
export const statsSse = new Hono();

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

      onUnsubscribe(
        onEvent(
          Channels.stats,
          async (_channel, message) => {
            if (closed) return;
            try {
              const [total, today] = await Promise.all([
                getCachedTotalStats(),
                getCachedTodayStats(),
              ]);
              await stream.writeSSE({
                event: "stats:updated",
                data: JSON.stringify({
                  type: "stats:updated",
                  total,
                  today,
                  ...JSON.parse(message),
                }),
              });
            } catch {
              // 静默失败
            }
          },
        ),
      );

      // 重放缺失事件
      const after = lastEventId(c);
      const missed = await replaySseEvents([Channels.stats], after, 200);
      for (const ev of missed) {
        if (closed) return;
        await stream.writeSSE({
          event: "stats:updated",
          id: String(ev.id),
          data: JSON.stringify({ ...(ev.payload as object), seq: ev.id }),
        });
      }
    },
  );
});

/** 竞赛事件 SSE 端点（公开赛可匿名，OI 进行中由服务层强制认证）。 */
export const contestSse = new Hono<OptionalAuthEnv>();

contestSse.get(
  "/contests/:id/events",
  optionalAuthMiddleware,
  async (c) => {
    const contestId = c.req.param("id") as string;
    const viewerId = c.var.userId;
    // 实时权限查询（submission:read_all，admin:full_access 通配；匿名恒 false）
    const isAdmin = c.var.userId
      ? await checkPermission(c, "submission:read_all")
      : false;
    const contest = await getContest(contestId, viewerId);
    if (!contest.is_public && !isAdmin && !contest.is_registered) {
      throw new NotFoundError("竞赛不存在");
    }

    return streamSSE(c, async (stream) => {
      let streamClosed = false;
      let resolveAbort: (() => void) | null = null;
      let rankingTimer: ReturnType<typeof setTimeout> | undefined;
      let rankingInFlight = false;
      let lastRankingPushAt = 0;
      let unsubscribeRanking = () => {};
      let unsubscribeSubmission = () => {};

      const keepAlive = setInterval(() => {
        if (streamClosed) return;
        stream.writeSSE({ event: "keepalive", data: "" }).catch(closeStream);
      }, 30_000);
      const safetyTimer = setTimeout(closeStream, 300_000);

      function closeStream() {
        if (streamClosed) return;
        streamClosed = true;
        clearTimeout(safetyTimer);
        clearInterval(keepAlive);
        if (rankingTimer !== undefined) clearTimeout(rankingTimer);
        unsubscribeRanking();
        unsubscribeSubmission();
        resolveAbort?.();
      }

      async function pushRanking(event: string): Promise<void> {
        if (streamClosed || rankingInFlight) return;
        const waitMs = 5_000 - (Date.now() - lastRankingPushAt);
        if (waitMs > 0) {
          if (rankingTimer === undefined) {
            rankingTimer = setTimeout(() => {
              rankingTimer = undefined;
              void pushRanking("contest:ranking:updated");
            }, waitMs);
          }
          return;
        }

        rankingInFlight = true;
        try {
          const data = await getContestRanking(
            contestId,
            contest.type,
            isAdmin,
            viewerId,
          );
          await stream.writeSSE({
            event,
            data: JSON.stringify({
              type: event,
              contest_id: contestId,
              data,
            }),
          });
          lastRankingPushAt = Date.now();
        } catch {
          closeStream();
        } finally {
          rankingInFlight = false;
        }
      }

      await pushRanking("contest:ranking:snapshot");
      if (streamClosed) return;

      unsubscribeRanking = onEvent(
        Channels.contestRanking(contestId),
        () => void pushRanking("contest:ranking:updated"),
      );
      unsubscribeSubmission = onEvent(
        Channels.contestSubmission(contestId),
        (_channel, message) => {
          if (streamClosed) return;
          // 非 admin 订阅者隐藏 user_id，避免泄露“谁在提交哪题”。
          let payload = message;
          if (!isAdmin) {
            try {
              const event = JSON.parse(message) as Record<string, unknown>;
              delete event.user_id;
              payload = JSON.stringify(event);
            } catch {
              // 解析失败时保持原样（不阻断推送）
            }
          }
          stream.writeSSE({
            event: "contest:submission:created",
            data: payload,
          }).catch(closeStream);
        },
      );

      // 重放缺失事件（先订阅后重放，避免竞态）
      const after = lastEventId(c);
      const missed = await replaySseEvents(
        [
          Channels.contestRanking(contestId),
          Channels.contestSubmission(contestId),
        ],
        after,
        200,
      );
      for (const ev of missed) {
        if (streamClosed) return;
        const payload = ev.payload as { type?: string };
        if (payload.type === "contest:submission:created") {
          let data = JSON.stringify({ ...payload, seq: ev.id });
          if (!isAdmin) {
            try {
              const parsed = JSON.parse(data) as Record<string, unknown>;
              delete parsed.user_id;
              data = JSON.stringify(parsed);
            } catch {
              // 保持原样
            }
          }
          await stream.writeSSE({
            event: "contest:submission:created",
            id: String(ev.id),
            data,
          });
        } else {
          // ranking 变更事件：走 pushRanking 拉取最新榜单
          void pushRanking("contest:ranking:updated");
        }
      }

      await new Promise<void>((resolve) => {
        resolveAbort = resolve;
        stream.onAbort(closeStream);
      });
    });
  },
);

/**
 * GET /api/v1/community/notifications/events
 * 社区通知 SSE 端点。
 *
 * 收到 notification:new 事件后前端应刷新通知列表和未读计数。
 * SSE 事件仅作触发器，不包含通知内容。
 */
sse.get("/community/notifications/events", (c) => {
  const userId = c.get("userId") as string;
  // 通知端点不启用兜底超时：订阅为常驻连接（与原实现一致）
  return createSseStream(
    c,
    async ({ stream, closed, close, onUnsubscribe }) => {
      onUnsubscribe(
        onEvent(
          Channels.user(userId),
          (_channel, message) => {
            if (closed) return;
            // 仅透传社区通知事件，避免与私信等同一用户通道事件交叉
            try {
              const payload = JSON.parse(message) as { type?: string };
              if (payload.type !== "notification:new") return;
            } catch {
              return;
            }
            stream.writeSSE({
              event: "notification:new",
              data: message,
            }).catch(() => {
              close();
            });
          },
        ),
      );

      // 重放缺失的通知事件
      const after = lastEventId(c);
      const missed = await replaySseEvents([Channels.user(userId)], after, 200);
      for (const ev of missed) {
        if (closed) return;
        const payload = ev.payload as { type?: string };
        if (payload.type !== "notification:new") continue;
        await stream.writeSSE({
          event: "notification:new",
          id: String(ev.id),
          data: JSON.stringify({ ...payload, seq: ev.id }),
        });
      }

      // 发送初始化事件，触发代理 flush 响应头
      await stream.writeSSE({ event: "connected", data: "" });
    },
    { safetyTimeoutMs: 0 },
  );
});

export default sse;
