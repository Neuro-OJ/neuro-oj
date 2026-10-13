import { assertEquals } from "jsr:@std/assert@^1";
import { createApp } from "../../../../app.ts";
import { assignments } from "../../../../shared/db/schema.ts";
import { getRedis } from "../../../../shared/mq/connection.ts";
import { signToken } from "../../../identity/index.ts";
import { createAssignment, publishAssignment } from "../../index.ts";
import { initRedisForTest, jsonRequest } from "../../../../../tests/helper.ts";
import { assignmentFixture } from "../_assignment-fixture.ts";

Deno.test({
  name:
    "教学写限流 HTTP：作业与互动共用窗口，读取不扣、拒绝副作用、学生求助与跨域独立",
  ignore: !Deno.env.get("REDIS_URL"),
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const f = await assignmentFixture();
    await initRedisForTest();
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
      "rate-gate-publish",
    );
    const teacher = await signToken({ sub: f.teacher, role: "user" }),
      student = await signToken({ sub: f.student, role: "user" });
    const app = createApp(),
      redis = getRedis(),
      previous = Deno.env.get("RATE_LIMIT_ENABLED");
    const key =
      `ratelimit:hardening:education-write:${f.school.slug}:${f.teacher}`;
    const studentKey =
      `ratelimit:hardening:education-write:${f.school.slug}:${f.student}`;
    const otherKey =
      `ratelimit:hardening:education-write:${f.other.slug}:${f.teacher}`;
    const base = `/api/v1/domains/${f.school.slug}/assignments/${task.id}`;
    await redis.set(key, "119", "EX", 60);
    Deno.env.set("RATE_LIMIT_ENABLED", "true");
    try {
      for (const method of ["GET", "HEAD"]) {
        assertEquals(
          (await jsonRequest(app, base, { token: teacher, method })).status,
          200,
        );
      }
      assertEquals(await redis.get(key), "119");
      const feedback = await jsonRequest(app, `${base}/feedback`, {
        token: teacher,
        method: "POST",
        body: { body: "窗口内最后一次", target_user_id: f.student },
        headers: { "Idempotency-Key": "rate-feedback" },
      });
      assertEquals(feedback.status, 201);
      assertEquals(await redis.get(key), "120", "同一个互动请求只扣一次");
      const rejected = await jsonRequest(
        app,
        `/api/v1/domains/${f.school.slug}/classrooms/${f.classroom.id}/assignments`,
        { token: teacher, method: "POST", body: f.input },
      );
      assertEquals(rejected.status, 429);
      assertEquals((await rejected.json()).code, "RATE_LIMITED");
      assertEquals(rejected.headers.get("X-RateLimit-Limit"), "120");
      assertEquals(Number(rejected.headers.get("Retry-After")) > 0, true);
      assertEquals(
        (await f.db.select().from(assignments)).length,
        1,
        "429不创建另一份作业",
      );
      assertEquals(
        (await jsonRequest(app, `${base}/feedback`, { token: teacher })).status,
        200,
      );
      assertEquals(await redis.get(key), "121");
      const help = await jsonRequest(app, `${base}/help-requests`, {
        token: student,
        method: "POST",
        body: { body: "学生独立求助" },
        headers: { "Idempotency-Key": "rate-help" },
      });
      assertEquals(help.status, 201);
      assertEquals(await redis.get(studentKey), "1");
      assertEquals(
        (await jsonRequest(
          app,
          `${base.replace(f.school.slug, f.other.slug)}/remediation-preview`,
          { token: teacher, method: "POST", body: {} },
        )).status,
        404,
      );
      assertEquals(await redis.get(otherKey), "1", "其他域不共享原域耗尽窗口");
      const helpId = (await help.json()).data.id;
      await redis.set(studentKey, "120", "EX", 60);
      const studentBlocked = await jsonRequest(
        app,
        `${base}/help-requests/${helpId}/replies`,
        {
          token: student,
          method: "POST",
          body: { body: "超限回复" },
          headers: { "Idempotency-Key": "rate-blocked-reply" },
        },
      );
      assertEquals(studentBlocked.status, 429);
    } finally {
      await redis.del(key, studentKey, otherKey);
      if (previous === undefined) Deno.env.delete("RATE_LIMIT_ENABLED");
      else Deno.env.set("RATE_LIMIT_ENABLED", previous);
    }
  },
});
