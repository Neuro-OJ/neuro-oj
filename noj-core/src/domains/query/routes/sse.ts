import { type Context, Hono } from "hono";
import {
  type OptionalAuthEnv,
  optionalAuthMiddleware,
} from "../../identity/index.ts";
import {
  DEFAULT_DOMAIN_ID,
  ensureDefaultWorkspace,
} from "../../workspace/index.ts";
import { Channels } from "../../../shared/sse/event-bus.ts";
import { createSseStream } from "../../../shared/sse/sse-stream.ts";
import {
  lastEventId,
  subscribeToChannel,
} from "../../../shared/sse/server-helpers.ts";
import { replaySseEvents } from "../../../shared/sse/sse-events.ts";
import { getDomainSubmissionStats } from "../services/stats-cache.ts";
import {
  loadDomainQueryScope,
  PUBLIC_DEFAULT_QUERY_SCOPE,
} from "../services/domain-query.ts";

/** 每次实时推送和持久重放重新验证当前成员关系；只发送重算的允许统计字段。 */
export const domainStatsSse = new Hono<OptionalAuthEnv>();
const statsSse = new Hono<OptionalAuthEnv>();
async function handler(c: Context<OptionalAuthEnv>) {
  const explicitSlug = c.req.param("slug"), slug = explicitSlug ?? "main";
  if (!explicitSlug) await ensureDefaultWorkspace();
  const initialScope = await loadDomainQueryScope(slug, c.var.userId ?? null);
  const channel = initialScope.domainId === DEFAULT_DOMAIN_ID
    ? Channels.stats
    : `noj:events:domain:${initialScope.domainId}:stats`;
  c.header("Cache-Control", "no-store");
  return createSseStream(c, async (streamContext) => {
    const snapshot = async () => {
      const current = await loadDomainQueryScope(slug, c.var.userId ?? null);
      const scope = explicitSlug ? current : PUBLIC_DEFAULT_QUERY_SCOPE;
      const [total, today] = await Promise.all([
        getDomainSubmissionStats(scope),
        getDomainSubmissionStats(scope, true),
      ]);
      return { type: "stats:updated", total, today };
    };
    await streamContext.stream.writeSSE({
      event: "stats:updated",
      data: JSON.stringify(await snapshot()),
    });
    subscribeToChannel(
      streamContext.onUnsubscribe,
      channel,
      "stats:updated",
      streamContext.stream,
      () => streamContext.closed,
      streamContext.close,
      async () => {
        try {
          return JSON.stringify(await snapshot());
        } catch {
          streamContext.close();
          return null;
        }
      },
      (operation) => streamContext.run(operation),
    );
    const missed = await replaySseEvents([channel], lastEventId(c), 200);
    for (const event of missed) {
      if (streamContext.closed) return;
      try {
        await streamContext.stream.writeSSE({
          event: "stats:updated",
          id: String(event.id),
          data: JSON.stringify(await snapshot()),
        });
      } catch {
        streamContext.close();
        return;
      }
    }
  });
}
statsSse.get("/submissions/stats/events", optionalAuthMiddleware, handler);
domainStatsSse.get(
  "/domains/:slug/submissions/stats/events",
  optionalAuthMiddleware,
  handler,
);
export default statsSse;
