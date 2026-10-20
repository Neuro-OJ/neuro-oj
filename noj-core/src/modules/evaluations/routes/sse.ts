import { type Context, Hono } from "hono";
import {
  type AuthEnv,
  authMiddleware,
} from "../../../domains/identity/index.ts";
import { NotFoundError } from "../../../shared/base/errors.ts";
import { eq } from "drizzle-orm";
import { getDb } from "../../../shared/db/connection.ts";
import { submissions } from "../../../shared/db/schema.ts";
import { Channels } from "../../../shared/sse/event-bus.ts";
import { createSseStream } from "../../../shared/sse/sse-stream.ts";
import {
  lastEventId,
  subscribeToChannel,
} from "../../../shared/sse/server-helpers.ts";
import { replaySseEvents } from "../../../shared/sse/sse-events.ts";
import {
  DEFAULT_DOMAIN_SLUG,
  ensureDefaultWorkspace,
  loadWorkspace,
} from "../../../domains/workspace/index.ts";
import { getDomainSubmission } from "../services/domain-submission-read.ts";
import { getDomainSelfTest } from "../services/domain-self-test-read.ts";
import { assertActiveInstanceAccount } from "../../../domains/identity/index.ts";
import {
  INSTANCE_QUEUE_CHANNEL,
  queueEventChannel,
} from "../services/queue.ts";
import {
  getSubmission,
  resolveSubmissionId,
} from "../services/submissions/submissions.ts";

const sse = new Hono<AuthEnv>();
export const domainSubmissionSse = new Hono<AuthEnv>();
for (const path of ["/submissions/:id/events", "/queue/events"]) {
  sse.use(path, authMiddleware);
}
for (
  const path of [
    "/domains/:slug/submissions/:id/events",
    "/domains/:slug/self-tests/:id/events",
    "/domains/:slug/queue/events",
    "/instance/queue/events",
  ]
) {
  domainSubmissionSse.use(path, authMiddleware);
}

async function currentSubmission(
  c: Context<AuthEnv>,
  slug: string | undefined,
  reference: string,
) {
  if (slug) return await getDomainSubmission(slug, reference, c.var.userId);
  await ensureDefaultWorkspace();
  const workspace = await loadWorkspace(DEFAULT_DOMAIN_SLUG, c.var.userId);
  const stableId = await resolveSubmissionId(reference);
  const [record] = await getDb().select({ domain_id: submissions.domain_id })
    .from(submissions).where(eq(submissions.id, stableId));
  if (record?.domain_id) {
    return await getDomainSubmission(
      DEFAULT_DOMAIN_SLUG,
      stableId,
      c.var.userId,
    );
  }
  const detail = await getSubmission(
    stableId,
    c.var.userId,
    undefined,
    c,
  );
  const manager = workspace.platformAdmin ||
    workspace.context.domainPermissions.has("submission:read_all");
  if (detail.user_id !== c.var.userId && !manager) {
    throw new NotFoundError("提交不存在");
  }
  return {
    ...detail,
    domain_id: workspace.domain.id,
    resource_available: true,
    result_visibility: "result_visibility" in detail
      ? detail.result_visibility
      : "cases",
  };
}

/** SSE 只发送定位信号；源授权和比赛结果仍由重新读取的裁剪接口决定。 */
async function submissionEvents(c: Context<AuthEnv>, selfTest = false) {
  const slug = c.req.param("slug"), reference = c.req.param("id")!;
  const read = () =>
    selfTest
      ? getDomainSelfTest(slug!, reference, c.var.userId, c)
      : currentSubmission(c, slug, reference);
  const initial = await read(), id = String(initial.id);
  const channel = Channels.submission(id),
    event = selfTest ? "self-test:updated" : "submission:updated";
  c.header("Cache-Control", "no-store");
  return createSseStream(c, async (streamContext) => {
    const locator = async () => {
      const current = await read();
      return {
        type: event,
        id,
        domain_id: current.domain_id,
        resource_available: current.resource_available,
        result_visibility: "result_visibility" in current
          ? current.result_visibility
          : "cases",
      };
    };
    const initialLocator = await locator();
    await streamContext.stream.writeSSE({
      event,
      data: JSON.stringify(initialLocator),
    });
    if (
      initial.status === "finished" || initial.status === "error" ||
      initial.status === "cancelled"
    ) {
      streamContext.close();
      return;
    }
    subscribeToChannel(
      streamContext.onUnsubscribe,
      channel,
      event,
      streamContext.stream,
      () => streamContext.closed,
      streamContext.close,
      async () => {
        try {
          return JSON.stringify(await locator());
        } catch {
          streamContext.close();
          return null;
        }
      },
      (operation) => streamContext.run(operation),
    );
    for (
      const missed of await replaySseEvents([channel], lastEventId(c), 200)
    ) {
      if (streamContext.closed) return;
      try {
        await streamContext.stream.writeSSE({
          event,
          id: String(missed.id),
          data: JSON.stringify(await locator()),
        });
      } catch {
        streamContext.close();
        return;
      }
    }
  });
}
sse.get("/submissions/:id/events", (c) => submissionEvents(c));
domainSubmissionSse.get(
  "/domains/:slug/submissions/:id/events",
  (c) => submissionEvents(c),
);
domainSubmissionSse.get(
  "/domains/:slug/self-tests/:id/events",
  (c) => submissionEvents(c, true),
);

/** 队列连接时校准当前状态，后续推送重新验证域访问，只返回定位信号。 */
async function queueEvents(c: Context<AuthEnv>, instance = false) {
  const slug = c.req.param("slug") ?? DEFAULT_DOMAIN_SLUG;
  if (!instance && !c.req.param("slug")) await ensureDefaultWorkspace();
  const authorize = () =>
    instance
      ? assertActiveInstanceAccount(c.var.userId)
      : loadWorkspace(slug, c.var.userId);
  await authorize();
  const channel = instance
    ? INSTANCE_QUEUE_CHANNEL
    : queueEventChannel((await loadWorkspace(slug, c.var.userId)).domain.id);
  c.header("Cache-Control", "no-store");
  return createSseStream(c, async (streamContext) => {
    const locator = async () => {
      await authorize();
      return JSON.stringify({ type: "queue:changed" });
    };
    await streamContext.stream.writeSSE({
      event: "queue:changed",
      data: await locator(),
    });
    subscribeToChannel(
      streamContext.onUnsubscribe,
      channel,
      "queue:changed",
      streamContext.stream,
      () => streamContext.closed,
      streamContext.close,
      async () => {
        try {
          return await locator();
        } catch {
          streamContext.close();
          return null;
        }
      },
      (operation) => streamContext.run(operation),
    );
    // 每次连接已通知客户端读取完整当前队列，无需逐条重放历史失效信号。
    // 重放会让页面为同一当前状态连续发起最多 200 次 REST 请求。
  });
}
sse.get("/queue/events", (c) => queueEvents(c));
domainSubmissionSse.get("/domains/:slug/queue/events", (c) => queueEvents(c));
domainSubmissionSse.get("/instance/queue/events", (c) => queueEvents(c, true));
export default sse;
