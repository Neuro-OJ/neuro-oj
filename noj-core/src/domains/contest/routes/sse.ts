import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import type { OptionalAuthEnv } from "../../identity/index.ts";
import {
  getUserPermissions,
  optionalAuthMiddleware,
} from "../../identity/index.ts";
import { Channels, onEvent } from "../../../shared/sse/event-bus.ts";
import { lastEventId } from "../../../shared/sse/server-helpers.ts";
import { replaySseEvents } from "../../../shared/sse/sse-events.ts";
import { NotFoundError } from "../../../shared/base/errors.ts";
import { getContest } from "../services/contests.ts";
import { resolveDefaultContestAccess } from "../services/default-access.ts";
import { loadDomainContest } from "../services/domain-access.ts";
import {
  getContestFreezeWindow,
  getContestRankingView,
  isContestFrozen,
} from "../services/contest-ranking.ts";

/**
 * contest 域竞赛 SSE 路由。
 *
 * 挂载在 `/api/v1` 前缀下。
 */
/** 竞赛事件 SSE 端点（公开赛可匿名，OI 进行中由服务层强制认证）。 */
const contestSse = new Hono<OptionalAuthEnv>();
/** 域比赛长连接与普通读取使用相同的即时成员及组织者权限。 */
export const domainContestSseRouter = new Hono<OptionalAuthEnv>();

for (
  const [router, path] of [[contestSse, "/contests/:id/events"], [
    domainContestSseRouter,
    "/domains/:slug/contests/:id/events",
  ]] as const
) {
  router.get(
    path,
    optionalAuthMiddleware,
    async (c) => {
      const viewerId = c.var.userId;
      const slug = c.req.param("slug"), reference = c.req.param("id")!;
      async function loadAccess() {
        if (slug) {
          const access = await loadDomainContest(
            slug,
            reference,
            viewerId ?? null,
          );
          return {
            contest: await getContest(access.contest.id, viewerId),
            admin: access.organizer,
          };
        }
        const id = await resolveDefaultContestAccess(
          reference,
          viewerId ?? null,
        );
        const permissions = viewerId
          ? await getUserPermissions(viewerId)
          : new Set<string>();
        const contest = await getContest(id, viewerId),
          admin = permissions.has("admin:full_access") ||
            permissions.has("contest:manage");
        if (
          !contest.is_public && !admin && !contest.is_registered
        ) throw new NotFoundError("竞赛不存在");
        return { contest, admin };
      }
      const initial = await loadAccess();
      let contest = initial.contest, isAdmin = initial.admin;
      const contestId = contest.id;
      // 非成员（含公开赛未报名用户）不得接收竞赛提交事件；榜单仍按既有规则。
      const canReceiveSubmissions = isAdmin || contest.is_registered === true;

      return streamSSE(c, async (stream) => {
        let streamClosed = false;
        let resolveAbort: (() => void) | null = null;
        let rankingTimer: ReturnType<typeof setTimeout> | undefined;
        let rankingInFlight = false;
        let lastRankingPushAt = 0;
        let unsubscribeRanking = () => {};
        let unsubscribeSubmission = () => {};
        let currentView: "live" | "frozen" | "official" = "live";
        // 非 live 视图（frozen / official）或已到达封榜时刻/已完赛，都不应再向普通用户推送实时提交事件。
        const isCurrentlyFrozen = () => {
          return isContestFrozen(getContestFreezeWindow(contest)) ||
            (Date.now() >= Date.parse(contest.end_time));
        };
        const isNonLiveView = () =>
          currentView !== "live" || isCurrentlyFrozen();

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
            const access = await loadAccess();
            contest = access.contest;
            isAdmin = access.admin;
            const result = await getContestRankingView(
              contestId,
              contest.type,
              isAdmin,
              viewerId,
            );
            currentView = result.view;
            await stream.writeSSE({
              event,
              data: JSON.stringify({
                type: event,
                contest_id: contestId,
                data: result.rows,
                view: result.view,
                ranking_visibility: result.ranking_visibility,
                freeze_start_time: result.freeze_start_time,
                freeze_end_time: result.freeze_end_time,
                settlement_pending: result.settlement_pending,
                admin_live: isAdmin && result.view === "live",
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
        async function pushSubmission(message: string, sequence?: number) {
          if (streamClosed) return;
          const access = await loadAccess();
          contest = access.contest;
          isAdmin = access.admin;
          if (!isAdmin && (!contest.is_registered || isNonLiveView())) return;
          const event = JSON.parse(message) as Record<string, unknown>;
          const locator = {
            type: "contest:submission:created",
            contest_id: contestId,
            problem_id: event.problem_id,
            created_at: event.created_at,
            ...(sequence === undefined ? {} : { seq: sequence }),
            ...(isAdmin
              ? { user_id: event.user_id, submission_id: event.submission_id }
              : {}),
          };
          await stream.writeSSE({
            event: "contest:submission:created",
            data: JSON.stringify(locator),
            ...(sequence === undefined ? {} : { id: String(sequence) }),
          });
        }
        if (canReceiveSubmissions) {
          unsubscribeSubmission = onEvent(
            Channels.contestSubmission(contestId),
            (_channel, message) => {
              void pushSubmission(message).catch(closeStream);
            },
          );
        }

        // 重放缺失事件（先订阅后重放，避免竞态）
        const after = lastEventId(c);
        const replayChannels = canReceiveSubmissions
          ? [
            Channels.contestRanking(contestId),
            Channels.contestSubmission(contestId),
          ]
          : [Channels.contestRanking(contestId)];
        const missed = await replaySseEvents(
          replayChannels,
          after,
          200,
        );
        for (const ev of missed) {
          if (streamClosed) return;
          const payload = ev.payload as { type?: string };
          if (payload.type === "contest:submission:created") {
            if (!canReceiveSubmissions) continue;
            try {
              await pushSubmission(JSON.stringify(payload), ev.id);
            } catch {
              closeStream();
              return;
            }
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
}

export default contestSse;
