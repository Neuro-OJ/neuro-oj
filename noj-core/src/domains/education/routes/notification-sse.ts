import { Hono } from "hono";
import { AppError } from "../../../shared/base/errors.ts";
import { type AuthEnv, authMiddleware } from "../../identity/index.ts";
import { loadWorkspace } from "../../workspace/index.ts";
import { createSseStream } from "../../../shared/sse/sse-stream.ts";
import { Channels, onEvent } from "../../../shared/sse/event-bus.ts";
import { lastEventId } from "../../../shared/sse/server-helpers.ts";
import { replaySseEvents } from "../../../shared/sse/sse-events.ts";
import { getEducationNotification } from "../services/notifications.ts";
import { loadAssignment } from "../services/assignment-access.ts";

/** 用户通道上的教学定位提示，实时和断线重放均验证当前资源授权。 */
export const educationNotificationSse = new Hono<AuthEnv>();
educationNotificationSse.get(
  "/domains/:slug/notifications/events",
  authMiddleware,
  async (c) => {
    const slug = c.req.param("slug")!, actorId = c.var.userId;
    const initial = await loadWorkspace(slug, actorId);
    const channel = Channels.user(actorId);
    const progressChannel = Channels.education(initial.domain.id);
    c.header("Cache-Control", "no-store");
    return createSseStream(c, async (ctx) => {
      const currentPayload = async (payload: unknown) => {
        if (!payload || typeof payload !== "object") return null;
        const event = payload as Record<string, unknown>;
        if (event.domain_id !== initial.domain.id) return null;
        if (
          event.type === "education:sync" &&
          typeof event.assignment_id === "string"
        ) {
          try {
            await loadWorkspace(slug, actorId);
          } catch (error) {
            if (
              error instanceof AppError &&
              [401, 403, 404].includes(error.statusCode)
            ) {
              ctx.close();
              return null;
            }
            throw error;
          }
          try {
            await loadAssignment(slug, event.assignment_id, actorId);
            return {
              type: "education:sync",
              domain_id: initial.domain.id,
              assignment_id: event.assignment_id,
            };
          } catch (error) {
            if (
              error instanceof AppError &&
              [401, 403, 404].includes(error.statusCode)
            ) return null;
            throw error;
          }
        }
        if (
          event.type !== "education:notification" ||
          event.domain_id !== initial.domain.id ||
          typeof event.notification_id !== "string"
        ) return null;
        try {
          const notice = await getEducationNotification(
            slug,
            actorId,
            event.notification_id,
          );
          return {
            type: "education:notification",
            notification_id: notice.id,
            domain_id: notice.domain_id,
            assignment_id: notice.assignment_id,
          };
        } catch (error) {
          if (
            error instanceof AppError &&
            [401, 403, 404].includes(error.statusCode)
          ) {
            ctx.close();
            return null;
          }
          throw error;
        }
      };
      const deliver = async (message: string) => {
        if (ctx.closed) return;
        const event = JSON.parse(message);
        const payload = await currentPayload(event);
        if (payload && !ctx.closed) {
          await ctx.stream.writeSSE({
            event: payload.type,
            id: typeof event.seq === "number" ? String(event.seq) : undefined,
            data: JSON.stringify(payload),
          });
        }
      };
      ctx.onUnsubscribe(onEvent(channel, (_channel, message) => {
        void deliver(message).catch(() => ctx.close());
      }));
      ctx.onUnsubscribe(onEvent(progressChannel, (_channel, message) => {
        void deliver(message).catch(() => ctx.close());
      }));
      await ctx.stream.writeSSE({
        event: "education:sync",
        data: JSON.stringify({ domain_id: initial.domain.id }),
      });
      for (
        const event of await replaySseEvents(
          [channel, progressChannel],
          lastEventId(c),
          200,
        )
      ) {
        if (ctx.closed) return;
        const payload = await currentPayload(event.payload);
        if (payload && !ctx.closed) {
          await ctx.stream.writeSSE({
            event: payload.type,
            id: String(event.id),
            data: JSON.stringify(payload),
          });
        }
      }
    });
  },
);
