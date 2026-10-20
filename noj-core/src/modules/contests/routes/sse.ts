import { Hono } from "hono";
import type { OptionalAuthEnv } from "../../../domains/identity/index.ts";
import {
  getUserPermissions,
  optionalAuthMiddleware,
} from "../../../domains/identity/index.ts";
import { Channels, onEvent } from "../../../shared/sse/event-bus.ts";
import { lastEventId } from "../../../shared/sse/server-helpers.ts";
import { createSseStream } from "../../../shared/sse/sse-stream.ts";
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

      return createSseStream(c, async (ctx) => {
        let rankingTimer: ReturnType<typeof setTimeout> | undefined;
        let rankingInFlight = false;
        let lastRankingPushAt = 0;
        let currentView: "live" | "frozen" | "official" = "live";
        // 非 live 视图（frozen / official）或已到达封榜时刻/已完赛，都不应再向普通用户推送实时提交事件。
        const isCurrentlyFrozen = () => {
          return isContestFrozen(getContestFreezeWindow(contest)) ||
            (Date.now() >= Date.parse(contest.end_time));
        };
        const isNonLiveView = () =>
          currentView !== "live" || isCurrentlyFrozen();

        // 定时器清理与每个事件订阅都独立登记；即使流在某个订阅创建前已关闭，
        // onUnsubscribe 也会立即执行该退订，不会留下悬挂监听器。
        ctx.onUnsubscribe(() => {
          if (rankingTimer !== undefined) {
            clearTimeout(rankingTimer);
            rankingTimer = undefined;
          }
        });

        /**
         * 向当前竞赛 SSE 流推送最新榜单数据。
         *
         * 带节流与去重：若流已关闭或已有推送在进行中则直接返回；距上次推送
         * 不足 5 秒时安排定时器延迟推送，否则立即拉取最新榜单并写入 SSE 事件。
         * 拉取或写入失败时关闭流。
         */
        async function pushRanking(event: string): Promise<void> {
          if (ctx.closed || rankingInFlight) return;
          const waitMs = 5_000 - (Date.now() - lastRankingPushAt);
          if (waitMs > 0) {
            if (rankingTimer === undefined) {
              rankingTimer = setTimeout(() => {
                rankingTimer = undefined;
                // 延迟推送同样纳入流作用域：关闭后不会开始，关闭时会被等待。
                void ctx.run(() => pushRanking("contest:ranking:updated"));
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
            await ctx.stream.writeSSE({
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
            ctx.close();
          } finally {
            rankingInFlight = false;
          }
        }

        await ctx.run(() => pushRanking("contest:ranking:snapshot"));
        if (ctx.closed) return;

        ctx.onUnsubscribe(
          onEvent(
            Channels.contestRanking(contestId),
            () => {
              void ctx.run(() => pushRanking("contest:ranking:updated"));
            },
          ),
        );
        async function pushSubmission(message: string, sequence?: number) {
          if (ctx.closed) return;
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
          await ctx.stream.writeSSE({
            event: "contest:submission:created",
            data: JSON.stringify(locator),
            ...(sequence === undefined ? {} : { id: String(sequence) }),
          });
        }
        if (canReceiveSubmissions) {
          ctx.onUnsubscribe(
            onEvent(
              Channels.contestSubmission(contestId),
              (_channel, message) => {
                // 权限重查与写入整体交给 run；失败由 run 关闭并观察。
                void ctx.run(() => pushSubmission(message));
              },
            ),
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
          if (ctx.closed) return;
          const payload = ev.payload as { type?: string };
          if (payload.type === "contest:submission:created") {
            if (!canReceiveSubmissions) continue;
            try {
              await ctx.run(() =>
                pushSubmission(JSON.stringify(payload), ev.id)
              );
            } catch {
              ctx.close();
              return;
            }
          } else {
            // ranking 变更事件：走 pushRanking 拉取最新榜单
            void ctx.run(() => pushRanking("contest:ranking:updated"));
          }
        }
      });
    },
  );
}

export default contestSse;
