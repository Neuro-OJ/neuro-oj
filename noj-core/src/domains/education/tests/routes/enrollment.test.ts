import { assertEquals } from "jsr:@std/assert@^1";
import { createApp } from "../../../../app.ts";
import { signToken } from "../../../identity/index.ts";
import { initRedisForTest, jsonRequest } from "../../../../../tests/helper.ts";
import { educationRouter } from "../../routes/index.ts";
import { educationFixture } from "../_fixtures.ts";

Deno.test("入班 API：申请、预览、If-Match、幂等及父路由认证和无缓存", async () => {
  const f = await educationFixture();
  await initRedisForTest();
  const teacher = await signToken({ sub: f.teacher, role: "user" }),
    owner = await signToken({ sub: f.owner, role: "user" }),
    student = await signToken({ sub: f.student, role: "user" });
  const app = createApp();
  app.route("/api/v1", educationRouter);
  const base = `/api/v1/domains/${f.school.slug}/classrooms/${f.classroom.id}`;
  assertEquals((await jsonRequest(app, `${base}/join`)).status, 401);
  const view = await jsonRequest(app, `${base}/join`, { token: student });
  assertEquals(view.status, 200);
  assertEquals(view.headers.get("Cache-Control"), "no-store");
  const request = await jsonRequest(app, `${base}/join`, {
    token: student,
    method: "POST",
    body: { reason: "申请" },
  });
  const id = (await request.json()).data.id;
  assertEquals(
    (await jsonRequest(app, `${base}/join-requests/${id}/review`, {
      token: teacher,
      method: "POST",
      body: { decision: "approve" },
      headers: { "Idempotency-Key": "review" },
    })).status,
    428,
  );
  assertEquals(
    (await jsonRequest(app, `${base}/join-requests/${id}/review`, {
      token: teacher,
      method: "POST",
      body: { decision: "approve" },
      headers: { "Idempotency-Key": "review", "If-Match": "0" },
    })).status,
    200,
  );
  const csv = "email\nnew@example.com";
  const preview = await jsonRequest(app, `${base}/imports/preview`, {
    token: owner,
    method: "POST",
    body: { csv },
  });
  const data = (await preview.json()).data;
  const executed = await jsonRequest(app, `${base}/imports/execute`, {
    token: owner,
    method: "POST",
    body: { csv, preview_hash: data.preview_hash },
    headers: { "If-Match": String(data.revision), "Idempotency-Key": "batch" },
  });
  assertEquals(executed.status, 200);
  assertEquals(executed.headers.get("Cache-Control"), "no-store");
  assertEquals((await executed.json()).data.rows[0].token.length, 72);
  assertEquals(
    (await jsonRequest(app, `${base}/imports/preview`, {
      token: student,
      method: "POST",
      body: { csv },
    })).status,
    403,
  );
  assertEquals(
    (await jsonRequest(
      app,
      `${base}/join`.replace(f.school.slug, f.other.slug),
      { token: student },
    )).status,
    404,
  );
});
