import { assert, assertEquals } from "jsr:@std/assert@^1";
import { Hono } from "hono";
import { desc, eq } from "drizzle-orm";
import { accountNotificationRouter } from "../../../http/account-notifications.ts";
import {
  accountNotifications,
  sseEvents,
} from "../../../../shared/db/schema.ts";
import {
  _dispatchToLocalListenersForTest,
  Channels,
} from "../../../../shared/sse/event-bus.ts";
import { signToken } from "../../../access/identity/index.ts";
import { removeDomainMember } from "../../../access/workspace/index.ts";
import { createAssignment, publishAssignment } from "../../index.ts";
import { processEducationBatch } from "../../services/progress-worker.ts";
import { educationNotificationSse } from "../../routes/notification-sse.ts";
import { recordSseEvent } from "../../../../shared/sse/sse-events.ts";
import { assignmentFixture } from "../_assignment-fixture.ts";

Deno.test({
  name: "统一通知SSE：持久重放和当前权限校验，通知正文与伪造字段不转发",
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
    await publishAssignment(f.school.slug, task.id, f.teacher, 0, "publish");
    for (let i = 0; i < 20; i++) {
      if (!(await processEducationBatch()).length) break;
    }
    const [notice] = await f.db.select().from(accountNotifications).where(
      eq(accountNotifications.recipient_id, f.student),
    );
    const channel = Channels.user(f.student);
    const [logged] = await f.db.select().from(sseEvents).where(
      eq(sseEvents.channel, channel),
    ).orderBy(desc(sseEvents.id));
    const app = new Hono();
    app.route("/", accountNotificationRouter);
    const token = await signToken({ sub: f.student, role: "user" });
    const controller = new AbortController();
    const response = await app.request("/notifications/events", {
      headers: {
        Authorization: `Bearer ${token}`,
        "Last-Event-ID": String(logged.id - 1),
      },
      signal: controller.signal,
    });
    assertEquals(response.status, 200);
    const reader = response.body!.getReader(), decode = new TextDecoder();
    try {
      const replay = decode.decode((await reader.read()).value);
      assert(replay.includes(notice.id));
      assert(replay.includes("notification:new"));
      assert(!replay.includes("assignment_id"));
      assert(decode.decode((await reader.read()).value).includes("connected"));
      await removeDomainMember(f.school.slug, f.owner, f.student);
      const followId = crypto.randomUUID();
      await f.db.insert(accountNotifications).values({
        id: followId,
        recipient_id: f.student,
        actor_id: f.owner,
        type: "follow",
        created_at: new Date().toISOString(),
      });
      const pending = reader.read();
      _dispatchToLocalListenersForTest(
        channel,
        JSON.stringify({
          type: "notification:new",
          notification_id: notice.id,
          body: "private",
        }),
      );
      _dispatchToLocalListenersForTest(
        channel,
        JSON.stringify({
          type: "notification:new",
          notification_id: followId,
          score: 999999,
          body: "private",
        }),
      );
      const live = decode.decode((await pending).value);
      assert(live.includes(followId));
      assert(!live.includes(notice.id));
      assert(!live.includes("private"));
      assert(!live.includes("999999"));
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
      `/domains/${f.school.slug}/education/events`,
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
      const forbiddenScore = Number.MAX_SAFE_INTEGER;
      _dispatchToLocalListenersForTest(
        channel,
        JSON.stringify({
          type: "education:sync",
          domain_id: f.school.id,
          assignment_id: crypto.randomUUID(),
          score: forbiddenScore,
        }),
      );
      _dispatchToLocalListenersForTest(
        channel,
        JSON.stringify({
          type: "education:sync",
          domain_id: f.other.id,
          assignment_id: task.id,
          score: forbiddenScore,
        }),
      );
      _dispatchToLocalListenersForTest(
        channel,
        JSON.stringify({
          type: "education:sync",
          domain_id: f.school.id,
          assignment_id: task.id,
          score: forbiddenScore,
        }),
      );
      const live = decode.decode((await pending).value);
      assert(live.includes(task.id));
      assert(!live.includes(String(forbiddenScore)));
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
