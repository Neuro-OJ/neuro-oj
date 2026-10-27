import { Hono } from "hono";
import { AppError } from "../../../shared/base/errors.ts";
import { authMiddleware } from "../../access/identity/middleware/auth.ts";
import { type AuthEnv } from "../../../shared/http/hono-env.ts";
import { loadWorkspace } from "../../access/contracts/cross-module/workspace_services_access.ts";
import { createSseStream } from "../../../shared/sse/sse-stream.ts";
import { Channels, onEvent } from "../../../shared/sse/event-bus.ts";
import { lastEventId } from "../../../shared/sse/server-helpers.ts";
import { replaySseEvents } from "../../../shared/sse/sse-events.ts";
import { loadAssignment } from "../services/assignment-access.ts";

/** 用户通道上的教学定位提示，实时和断线重放均验证当前资源授权。 */
export const educationNotificationSse = new Hono<AuthEnv>();
educationNotificationSse.get(
  "/domains/:slug/education/events",
  authMiddleware,
  async (c) => {
    const slug = c.req.param("slug")!, actorId = c.var.userId;
    const initial = await loadWorkspace(slug, actorId);
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
        return null;
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
      ctx.onUnsubscribe(onEvent(progressChannel, (_channel, message) => {
        void ctx.run(() => deliver(message));
      }));
      await ctx.stream.writeSSE({
        event: "education:sync",
        data: JSON.stringify({ domain_id: initial.domain.id }),
      });
      for (
        const event of await replaySseEvents(
          [progressChannel],
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
