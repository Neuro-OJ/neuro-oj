import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import type { OptionalAuthEnv } from "../../identity/index.ts";
import {
  checkPermission,
  optionalAuthMiddleware,
} from "../../identity/index.ts";
import { Channels, onEvent } from "../../../shared/sse/event-bus.ts";
import { lastEventId } from "../../../shared/sse/server-helpers.ts";
import { replaySseEvents } from "../../../shared/sse/sse-events.ts";
import { NotFoundError } from "../../../shared/base/errors.ts";
import { getContest } from "../services/contests.ts";
import { getContestRanking } from "../services/contest-ranking.ts";

/**
 * contest 域竞赛 SSE 路由。
 *
 * 挂载在 `/api/v1` 前缀下。
 */
/** 竞赛事件 SSE 端点（公开赛可匿名，OI 进行中由服务层强制认证）。 */
const contestSse = new Hono<OptionalAuthEnv>();

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

      /**
       * 关闭当前竞赛 SSE 流。
       *
       * 幂等：若流已关闭则直接返回。负责清理心跳定时器、安全兜底定时器、
       * 待执行的榜单推送定时器，并取消榜单与提交事件的订阅，最后触发
       * abort 解析以结束常驻连接。
       *
       * @returns 无返回值。
       */
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

      /**
       * 向当前竞赛 SSE 流推送最新榜单数据。
       *
       * 带节流与去重：若流已关闭或已有推送在进行中则直接返回；距上次推送
       * 不足 5 秒时安排定时器延迟推送，否则立即拉取最新榜单并写入 SSE 事件。
       * 拉取或写入失败时关闭流。
       *
       * @param event - 推送的 SSE 事件名（如 `contest:ranking:snapshot` /
       *   `contest:ranking:updated`）。
       * @returns 无返回值；推送完成后 Promise 解析。
       * @throws 不向外抛出——内部捕获异常并调用 `closeStream()` 关闭流。
       */
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

export default contestSse;
