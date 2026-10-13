import { assert, assertEquals } from "jsr:@std/assert@^1";
import { Hono } from "hono";
import { desc, eq } from "drizzle-orm";
import { AppError } from "../../../../shared/base/errors.ts";
import {
  educationNotifications,
  sseEvents,
} from "../../../../shared/db/schema.ts";
import {
  _dispatchToLocalListenersForTest,
  Channels,
} from "../../../../shared/sse/event-bus.ts";
import { signToken } from "../../../identity/index.ts";
import { removeDomainMember } from "../../../workspace/index.ts";
import {
  createAssignment,
  createAssignmentFeedback,
  publishAssignment,
} from "../../index.ts";
import { processEducationBatch } from "../../services/progress-worker.ts";
import { educationNotificationSse } from "../../routes/notification-sse.ts";
import { assignmentFixture } from "../_assignment-fixture.ts";

Deno.test({
  name: "教学SSE：Redis通知丢失仍重放定位、不同域不串流、长连接撤权停止发送",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const f = await assignmentFixture();
    const task = await createAssignment(
      f.school.slug,
      f.classroom.id,
      f.teacher,
      f.input,
    );
    await publishAssignment(
      f.school.slug,
      task.id,
      f.teacher,
      0,
      "sse-publish",
    );
    for (let i = 0; i < 10; i++) {
      if (!(await processEducationBatch()).length) break;
    }
    await createAssignmentFeedback(
      f.school.slug,
      task.id,
      f.teacher,
      "sse-feedback",
      { body: "private body never broadcast", target_user_id: f.student },
    );
    for (let i = 0; i < 10; i++) {
      if (!(await processEducationBatch()).length) break;
    }
    const [notice] = await f.db.select().from(educationNotifications).where(
      eq(educationNotifications.user_id, f.student),
    ).orderBy(desc(educationNotifications.created_at));
    const channel = Channels.user(f.student);
    const [logged] = await f.db.select().from(sseEvents).where(
      eq(sseEvents.channel, channel),
    ).orderBy(desc(sseEvents.id));
    assertEquals(
      (logged.payload as { notification_id: string }).notification_id,
      notice.id,
    );
    assert(!JSON.stringify(logged.payload).includes("private body"));
    const app = new Hono();
    app.onError((error, c) =>
      c.json(
        { error: error.message },
        error instanceof AppError ? error.statusCode as 404 : 500,
      )
    );
    app.route("/", educationNotificationSse);
    const token = await signToken({ sub: f.student, role: "user" });
    const headers = {
      Authorization: `Bearer ${token}`,
      "Last-Event-ID": String(logged.id - 1),
    };
    const controller = new AbortController();
    const response = await app.request(
      `/domains/${f.school.slug}/notifications/events`,
      { headers, signal: controller.signal },
    );
    const reader = response.body!.getReader(), decode = new TextDecoder();
    try {
      assertEquals(response.status, 200);
      assert(
        decode.decode((await reader.read()).value).includes("education:sync"),
      );
      const replay = decode.decode((await reader.read()).value);
      assert(replay.includes(`id: ${logged.id}`));
      assert(replay.includes(notice.id));
      assert(!replay.includes("private body"));
      const pending = reader.read();
      _dispatchToLocalListenersForTest(
        channel,
        JSON.stringify({
          type: "education:notification",
          domain_id: f.other.id,
          notification_id: notice.id,
          score: 9999,
          body: "never forward",
        }),
      );
      _dispatchToLocalListenersForTest(
        channel,
        JSON.stringify({
          type: "education:notification",
          domain_id: f.school.id,
          notification_id: notice.id,
          seq: logged.id,
          score: 9999,
          body: "never forward",
        }),
      );
      const live = decode.decode((await pending).value);
      assert(live.includes(`id: ${logged.id}`));
      assert(live.includes(notice.id));
      assert(!live.includes("9999"));
      assert(!live.includes("never forward"));
      await removeDomainMember(f.school.slug, f.owner, f.student);
      const closed = reader.read();
      _dispatchToLocalListenersForTest(
        channel,
        JSON.stringify({
          type: "education:notification",
          domain_id: f.school.id,
          notification_id: notice.id,
        }),
      );
      assertEquals((await closed).done, true);
      assertEquals(
        (await app.request(`/domains/${f.school.slug}/notifications/events`, {
          headers,
        })).status,
        404,
      );
    } finally {
      controller.abort();
      await reader.cancel();
    }
  },
});
