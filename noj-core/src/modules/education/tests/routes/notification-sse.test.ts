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
import { signToken } from "../../../access/identity/index.ts";
import { removeDomainMember } from "../../../access/workspace/index.ts";
import {
  createAssignment,
  createAssignmentFeedback,
  publishAssignment,
} from "../../index.ts";
import { processEducationBatch } from "../../services/progress-worker.ts";
import { educationNotificationSse } from "../../routes/notification-sse.ts";
import { recordSseEvent } from "../../../../shared/sse/sse-events.ts";
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

Deno.test({
  name: "教学进度SSE：物化后持久提示教师重读，重放及推送不含成绩，撤权后停止",
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
      "progress-sse",
    );
    for (let i = 0; i < 10; i++) {
      if (!(await processEducationBatch()).length) break;
    }
    const channel = Channels.education(f.school.id);
    const [logged] = await f.db.select().from(sseEvents).where(
      eq(sseEvents.channel, channel),
    ).orderBy(desc(sseEvents.id));
    assertEquals(logged.payload, {
      type: "education:sync",
      domain_id: f.school.id,
      assignment_id: task.id,
    });
    // 将进度提示放到现有通知之后，单独验收本频道的断线重放。
    const replayId = await recordSseEvent(channel, logged.payload);
    const app = new Hono();
    app.route("/", educationNotificationSse);
    const token = await signToken({ sub: f.teacher, role: "user" });
    const controller = new AbortController();
    const response = await app.request(
      `/domains/${f.school.slug}/notifications/events`,
      {
        headers: {
          Authorization: `Bearer ${token}`,
          "Last-Event-ID": String(replayId - 1),
        },
        signal: controller.signal,
      },
    );
    const reader = response.body!.getReader(), decode = new TextDecoder();
    try {
      assertEquals(response.status, 200);
      assert(
        decode.decode((await reader.read()).value).includes("education:sync"),
      );
      const replay = decode.decode((await reader.read()).value);
      assert(replay.includes(task.id));
      assert(!replay.includes("score"));
      const pending = reader.read();
      _dispatchToLocalListenersForTest(
        channel,
        JSON.stringify({
          type: "education:sync",
          domain_id: f.school.id,
          assignment_id: crypto.randomUUID(),
          score: 12345,
        }),
      );
      _dispatchToLocalListenersForTest(
        channel,
        JSON.stringify({
          type: "education:sync",
          domain_id: f.other.id,
          assignment_id: task.id,
          score: 12345,
        }),
      );
      _dispatchToLocalListenersForTest(
        channel,
        JSON.stringify({
          type: "education:sync",
          domain_id: f.school.id,
          assignment_id: task.id,
          score: 12345,
        }),
      );
      const live = decode.decode((await pending).value);
      assert(live.includes(task.id));
      assert(!live.includes("12345"));
      await removeDomainMember(f.school.slug, f.owner, f.teacher);
      const closed = reader.read();
      _dispatchToLocalListenersForTest(
        channel,
        JSON.stringify({
          type: "education:sync",
          domain_id: f.school.id,
          assignment_id: task.id,
        }),
      );
      assertEquals((await closed).done, true);
    } finally {
      controller.abort();
      await reader.cancel();
    }
  },
});
