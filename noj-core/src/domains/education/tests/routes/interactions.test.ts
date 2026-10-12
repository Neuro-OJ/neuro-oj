import { assertEquals } from "jsr:@std/assert@^1";
import { createApp } from "../../../../app.ts";
import { signToken } from "../../../identity/index.ts";
import { initRedisForTest, jsonRequest } from "../../../../../tests/helper.ts";
import { createAssignment, publishAssignment } from "../../index.ts";
import { educationRouter } from "../../routes/index.ts";
import { processEducationBatch } from "../../services/progress-worker.ts";
import { assignmentFixture } from "../_assignment-fixture.ts";

Deno.test("教学互动 API：反馈、求助、通知认证及跨域错误，消息点击重新授权", async () => {
  const f = await assignmentFixture();
  await initRedisForTest();
  const task = await createAssignment(
    f.school.slug,
    f.classroom.id,
    f.teacher,
    f.input,
  );
  await publishAssignment(f.school.slug, task.id, f.teacher, 0, "publish");
  const teacher = await signToken({ sub: f.teacher, role: "user" }),
    student = await signToken({ sub: f.student, role: "user" });
  const app = createApp();
  app.route("/api/v1", educationRouter);
  const base = `/api/v1/domains/${f.school.slug}/assignments/${task.id}`;
  const feedback = await jsonRequest(app, `${base}/feedback`, {
    token: teacher,
    method: "POST",
    body: { body: "个人反馈", target_user_id: f.student },
    headers: { "Idempotency-Key": "feedback" },
  });
  assertEquals(feedback.status, 201);
  const record = (await feedback.json()).data;
  const own = await jsonRequest(app, `${base}/feedback/${record.id}`, {
    token: student,
  });
  assertEquals(own.status, 200);
  assertEquals(own.headers.get("Cache-Control"), "no-store");
  assertEquals(
    (await jsonRequest(app, `${base}/feedback/${record.id}`, {
      method: "PATCH",
      token: teacher,
      body: { body: "改动" },
    })).status,
    428,
  );
  const help = await jsonRequest(app, `${base}/help-requests`, {
    token: student,
    method: "POST",
    body: { body: "我需要帮助" },
    headers: { "Idempotency-Key": "help" },
  });
  assertEquals(help.status, 201);
  const request = (await help.json()).data;
  const reply = await jsonRequest(
    app,
    `${base}/help-requests/${request.id}/replies`,
    {
      token: teacher,
      method: "POST",
      body: { body: "解释", resolve: true },
      headers: { "Idempotency-Key": "reply" },
    },
  );
  assertEquals(reply.status, 201);
  assertEquals(
    (await (await jsonRequest(app, `${base}/help-requests/${request.id}`, {
      token: student,
    })).json()).data.state,
    "resolved",
  );
  const notifications = `/api/v1/domains/${f.school.slug}/notifications`;
  assertEquals((await jsonRequest(app, notifications)).status, 401);
  assertEquals(
    (await jsonRequest(app, `${notifications}/missing/read`, {
      method: "POST",
    })).status,
    401,
  );
  for (let i = 0; i < 30; i++) {
    if (!(await processEducationBatch()).length) break;
  }
  const notices = await jsonRequest(app, notifications, { token: student });
  assertEquals(notices.status, 200);
  const listing = (await notices.json()).data;
  assertEquals(listing.total, 2);
  assertEquals(
    (await jsonRequest(app, `${notifications}/${listing.data[0].id}/read`, {
      token: student,
      method: "POST",
    })).status,
    200,
  );
  assertEquals(
    (await jsonRequest(
      app,
      `${base.replace(f.school.slug, f.other.slug)}/feedback/${record.id}`,
      { token: student },
    )).status,
    404,
  );
});
