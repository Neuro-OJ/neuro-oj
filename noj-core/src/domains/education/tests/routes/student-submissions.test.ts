import { assertEquals } from "jsr:@std/assert@^1";
import { createApp } from "../../../../app.ts";
import { signToken } from "../../../identity/index.ts";
import { initRedisForTest, jsonRequest } from "../../../../../tests/helper.ts";
import { submissions } from "../../../../shared/db/schema.ts";
import { educationRouter } from "../../routes/index.ts";
import { assignmentFixture } from "../_assignment-fixture.ts";

Deno.test("教学提交 API：父路由执行认证、禁用缓存和独立源码能力", async () => {
  const f = await assignmentFixture(), id = crypto.randomUUID();
  await initRedisForTest();
  await f.db.insert(submissions).values({
    id,
    domain_id: f.school.id,
    domain_problem_binding_id: f.bindingId,
    user_id: f.student,
    problem_id: f.problemId,
    language: "python",
    code: "student source",
    submitted_version_id: f.versionId,
    version_origin: "known",
    created_at: new Date().toISOString(),
  });
  const teacher = await signToken({ sub: f.teacher, role: "user" }),
    student = await signToken({ sub: f.student, role: "user" });
  const app = createApp();
  app.route("/api/v1", educationRouter);
  const base = `/api/v1/domains/${f.school.slug}/classrooms/${f.classroom.id}`;
  const path = `${base}/submissions/submission/${id}`;
  const detail = await jsonRequest(app, path, { token: teacher });
  assertEquals(detail.status, 200);
  assertEquals(detail.headers.get("Cache-Control"), "no-store");
  assertEquals((await detail.json()).data.code, "student source");
  assertEquals((await jsonRequest(app, path, { token: student })).status, 403);
  assertEquals((await jsonRequest(app, path)).status, 401);
  assertEquals(
    (await jsonRequest(app, path.replace(f.school.slug, f.other.slug), {
      token: teacher,
    })).status,
    404,
  );
  const listing = await jsonRequest(
    app,
    `${base}/students/${f.student}/submissions`,
    { token: teacher },
  );
  assertEquals(listing.status, 200);
  assertEquals((await listing.json()).data.total, 1);
});
