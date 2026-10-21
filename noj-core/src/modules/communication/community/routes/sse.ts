import { Hono } from "hono";
import { assertActiveInstanceAccount } from "../../../access/contracts/cross-module/identity_services_security_account-access.ts";
import { authMiddleware } from "../../../access/identity/middleware/auth.ts";
import { type AuthEnv } from "../../../../shared/http/hono-env.ts";
import { Channels, onEvent } from "../../../../shared/sse/event-bus.ts";
import { createSseStream } from "../../../../shared/sse/sse-stream.ts";
import { lastEventId } from "../../../../shared/sse/server-helpers.ts";
import { replaySseEvents } from "../../../../shared/sse/sse-events.ts";
import { NotFoundError } from "../../../../shared/base/errors.ts";
import { getNotification } from "../services/community/community-feed.ts";
import { loadCommunityScope } from "../services/community/community-scope.ts";
import { DEFAULT_DOMAIN_SLUG } from "../../../../shared/workspace/types.ts";
import { loadWorkspace } from "../../../access/contracts/cross-module/workspace_services_access.ts";

/**
 * community 域社区通知 SSE 路由。
 *
 * 需要登录认证，挂载在 `/api/v1` 前缀下。
 */
const communitySse = new Hono<AuthEnv>();

/** 域社区通知每次推送及持久重放重新授权，不广播原始事件载荷。 */
export const domainCommunitySse = new Hono<AuthEnv>();
for (
  const [router, path] of [[communitySse, "/community/notifications/events"], [
    domainCommunitySse,
    "/domains/:slug/community/notifications/events",
  ]] as const
) {
  router.get(path, authMiddleware, async (c) => {
    const actorId = c.var.userId, slug = c.req.param("slug");
    if (slug) await loadCommunityScope(slug, actorId);
    else await assertActiveInstanceAccount(actorId);
    return createSseStream(c, async (ctx) => {
      async function push(payload: unknown, sequence?: number) {
        if (ctx.closed) return;
        const scope = slug
          ? await loadCommunityScope(slug, actorId)
          : undefined;
        if (!slug) await assertActiveInstanceAccount(actorId);
        const event = payload as { type?: string; notification_id?: string };
        if (
          event.type !== "notification:new" ||
          typeof event.notification_id !== "string"
        ) return;
        let notification;
        try {
          notification = await getNotification(
            actorId,
            event.notification_id,
            scope,
          );
        } catch (error) {
          if (error instanceof NotFoundError) return;
          throw error;
        }
        if (!slug && notification.notification.domain_id) {
          await loadWorkspace(DEFAULT_DOMAIN_SLUG, actorId);
        }
        await ctx.stream.writeSSE({
          event: "notification:new",
          data: JSON.stringify({
            type: "notification:new",
            notification_id: event.notification_id,
            ...(sequence === undefined ? {} : { seq: sequence }),
          }),
          ...(sequence === undefined ? {} : { id: String(sequence) }),
        });
      }
      ctx.onUnsubscribe(onEvent(Channels.user(actorId), (_channel, message) => {
        let payload: unknown;
        try {
          payload = JSON.parse(message);
        } catch {
          return;
        }
        void ctx.run(() => push(payload));
      }));
      for (
        const event of await replaySseEvents(
          [Channels.user(actorId)],
          lastEventId(c),
          200,
        )
      ) {
        try {
          await push(event.payload, event.id);
        } catch {
          ctx.close();
          return;
        }
        if (ctx.closed) return;
      }
      await ctx.stream.writeSSE({ event: "connected", data: "" });
    });
  });
}

export default communitySse;
