import { Hono } from "hono";
import { and, eq, or } from "drizzle-orm";
import type { AuthEnv } from "../../shared/http/hono-env.ts";
import { accountNotifications } from "../../shared/db/schema.ts";
import { authMiddleware } from "../access/identity/middleware/auth.ts";
import { assertActiveInstanceAccount } from "../access/contracts/cross-module/identity_services_security_account-access.ts";
import { getUserPermissions } from "../access/identity/services/security/permissions.ts";
import { parsePagination } from "../../shared/http/pagination.ts";
import { NotFoundError } from "../../shared/base/errors.ts";
import {
  getAccountNotification,
  listAccountNotifications,
  readAccountNotifications,
} from "../communication/account-notifications.ts";
import { communityNotificationVisibleWhere } from "../communication/community/services/notification-access.ts";
import { educationNotificationVisibleWhere } from "../education/services/notifications.ts";
import { contestNotificationVisibleWhere } from "../contests/services/notification-access.ts";
import { Channels, onEvent } from "../../shared/sse/event-bus.ts";
import { createSseStream } from "../../shared/sse/sse-stream.ts";
import { replaySseEvents } from "../../shared/sse/sse-events.ts";
import { lastEventId } from "../../shared/sse/server-helpers.ts";

/** HTTP 组合根组合各业务资源授权，通知模块不依赖教学模块。 */
export const accountNotificationRouter = new Hono<AuthEnv>();
accountNotificationRouter.use("/notifications", authMiddleware);
accountNotificationRouter.use("/notifications/*", authMiddleware);
async function visible(actorId: string, domainId?: string) {
  await assertActiveInstanceAccount(actorId);
  const admin = (await getUserPermissions(actorId)).has("admin:full_access");
  return and(
    eq(accountNotifications.recipient_id, actorId),
    domainId ? eq(accountNotifications.domain_id, domainId) : undefined,
    or(
      communityNotificationVisibleWhere(actorId, admin),
      educationNotificationVisibleWhere(actorId, admin),
      contestNotificationVisibleWhere(actorId, admin),
    ),
  )!;
}
accountNotificationRouter.get("/notifications", async (c) => {
  c.header("Cache-Control", "no-store");
  const pagination = parsePagination(c, {
    defaultPerPage: 30,
    maxPerPage: 100,
  });
  return c.json(
    await listAccountNotifications(
      await visible(c.var.userId, c.req.query("domain_id")),
      pagination.page,
      pagination.perPage,
    ),
  );
});
accountNotificationRouter.get("/notifications/events", async (c) => {
  const actorId = c.var.userId, domainId = c.req.query("domain_id");
  await visible(actorId, domainId);
  return createSseStream(c, async (ctx) => {
    async function push(payload: unknown, sequence?: number) {
      const event = payload as { type?: string; notification_id?: string };
      if (
        event?.type !== "notification:new" ||
        typeof event.notification_id !== "string"
      ) return;
      try {
        await getAccountNotification(
          await visible(actorId, domainId),
          event.notification_id,
        );
      } catch (error) {
        if (error instanceof NotFoundError) return;
        throw error;
      }
      await ctx.stream.writeSSE({
        event: "notification:new",
        data: JSON.stringify({ notification_id: event.notification_id }),
        ...(sequence === undefined ? {} : { id: String(sequence) }),
      });
    }
    ctx.onUnsubscribe(onEvent(Channels.user(actorId), (_channel, message) => {
      void ctx.run(() => push(JSON.parse(message)));
    }));
    for (
      const event of await replaySseEvents(
        [Channels.user(actorId)],
        lastEventId(c),
        200,
      )
    ) {
      await push(event.payload, event.id);
      if (ctx.closed) return;
    }
    await ctx.stream.writeSSE({ event: "connected", data: "" });
  });
});
accountNotificationRouter.get("/notifications/:id", async (c) => {
  c.header("Cache-Control", "no-store");
  return c.json({
    data: await getAccountNotification(
      await visible(c.var.userId),
      c.req.param("id"),
    ),
  });
});
accountNotificationRouter.post("/notifications/read", async (c) => {
  await readAccountNotifications(
    await visible(c.var.userId, c.req.query("domain_id")),
  );
  return c.body(null, 204);
});
accountNotificationRouter.post("/notifications/:id/read", async (c) => {
  await readAccountNotifications(
    await visible(c.var.userId),
    c.req.param("id"),
  );
  return c.body(null, 204);
});
