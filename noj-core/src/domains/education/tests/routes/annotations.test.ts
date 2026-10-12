import { assertEquals } from "jsr:@std/assert@^1";
import { createApp } from "../../../../app.ts";
import { submissions } from "../../../../shared/db/schema.ts";
import { signToken } from "../../../identity/index.ts";
import { initRedisForTest, jsonRequest } from "../../../../../tests/helper.ts";
import { educationRouter } from "../../routes/index.ts";
import { assignmentFixture } from "../_assignment-fixture.ts";

Deno.test("批注 API：原提交文本、本人只读、幂等与前置版本、不缓存和错域拒绝", async () => {
  const f = await assignmentFixture(), id = crypto.randomUUID();
  await initRedisForTest();
  await f.db.insert(submissions).values({
    id,
    domain_id: f.school.id,
    domain_problem_binding_id: f.bindingId,
    user_id: f.student,
    problem_id: f.problemId,
    language: "python",
    code: "print(1)",
    file_name: "main.py",
    submitted_version_id: f.versionId,
    version_origin: "known",
    created_at: new Date().toISOString(),
  });
  const teacher = await signToken({ sub: f.teacher, role: "user" }),
    student = await signToken({ sub: f.student, role: "user" });
  const app = createApp();
  app.route("/api/v1", educationRouter);
  const base =
    `/api/v1/domains/${f.school.slug}/classrooms/${f.classroom.id}/submissions/submission/${id}`;
  assertEquals(
    (await jsonRequest(app, `${base}/text?file=main.py`)).status,
    401,
  );
  const textResponse = await jsonRequest(app, `${base}/text?file=main.py`, {
    token: teacher,
  });
  assertEquals(textResponse.status, 200);
  assertEquals(textResponse.headers.get("Cache-Control"), "no-store");
  const text = (await textResponse.json()).data;
  assertEquals(text.text, "print(1)");
  const input = {
    file_name: "main.py",
    source_hash: text.source_hash,
    start_line: 1,
    end_line: 1,
    body: "解释输出",
  };
  const created = await jsonRequest(app, `${base}/annotations`, {
    method: "POST",
    token: teacher,
    body: input,
    headers: { "Idempotency-Key": "annotation" },
  });
  assertEquals(created.status, 201);
  const annotation = (await created.json()).data;
  const own = await jsonRequest(app, `${base}/annotations`, { token: student });
  assertEquals(own.status, 200);
  assertEquals((await own.json()).data.total, 1);
  assertEquals(
    (await jsonRequest(app, `${base}/annotations`, {
      method: "POST",
      token: student,
      body: input,
      headers: { "Idempotency-Key": "student" },
    })).status,
    403,
  );
  assertEquals(
    (await jsonRequest(app, `${base}/annotations/${annotation.id}`, {
      method: "PATCH",
      token: teacher,
      body: { body: "补充" },
    })).status,
    428,
  );
  assertEquals(
    (await jsonRequest(app, `${base}/annotations/${annotation.id}`, {
      method: "PATCH",
      token: teacher,
      headers: { "If-Match": '"0"' },
      body: { body: "补充" },
    })).status,
    200,
  );
  assertEquals(
    (await jsonRequest(app, `${base}/annotations`, {
      token: teacher,
      headers: {},
    })).status,
    200,
  );
  assertEquals(
    (await jsonRequest(
      app,
      `${base}/annotations`.replace(f.school.slug, f.other.slug),
      { token: teacher },
    )).status,
    404,
  );
});
