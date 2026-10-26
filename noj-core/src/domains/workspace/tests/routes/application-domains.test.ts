import { assertEquals } from "jsr:@std/assert@^1";
import { createApp } from "../../../../app.ts";
import { getDb, resetDbForTest } from "../../../../shared/db/connection.ts";
import { contests, submissions } from "../../../../shared/db/schema.ts";
import { initRedisForTest, jsonRequest } from "../../../../../tests/helper.ts";
import { signToken } from "../../../identity/index.ts";
import { createAssignment, createClassroom } from "../../../education/index.ts";
import { assignmentFixture } from "../../../education/tests/_assignment-fixture.ts";
import { account } from "../../../education/tests/_fixtures.ts";
import {
  ensureDefaultWorkspace,
  removeDomainMember,
  setMemberRoles,
} from "../../index.ts";

await resetDbForTest();
await initRedisForTest();

Deno.test({
  name: "应用组合：公开域读取不被其他模块认证拦截，幂等请求允许跨源预检",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await resetDbForTest();
    await ensureDefaultWorkspace();
    const app = createApp();
    for (
      const path of [
        "/api/v1/instance",
        "/api/v1/auth/register-status",
        "/api/v1/judge-images",
        "/api/v1/domains/main/problems",
        "/api/v1/domains/main/trainings",
        "/api/v1/domains/main/contests",
        "/api/v1/domains/main/community/config",
        "/api/v1/domains/main/stats",
        "/api/v1/domains/main/rankings",
        "/api/v1/domains/main/search?q=absent&types=problem",
      ]
    ) {
      const response = await jsonRequest(app, path);
      assertEquals(response.status, 200, `${path}: ${await response.text()}`);
    }
    assertEquals(
      (await jsonRequest(app, "/api/v1/me/submissions")).status,
      401,
    );
    const preflight = await app.fetch(
      new Request(
        "http://localhost/api/v1/domains/main/submission-jobs",
        {
          method: "OPTIONS",
          headers: {
            Origin: "http://localhost:3000",
            "Access-Control-Request-Method": "POST",
            "Access-Control-Request-Headers": "Idempotency-Key,If-Match",
          },
        },
      ),
    );
    assertEquals(preflight.status, 204);
    assertEquals(
      preflight.headers.get("Access-Control-Allow-Headers")?.includes(
        "Idempotency-Key",
      ),
      true,
    );
  },
});

Deno.test({
  name: "应用组合：双域教学身份、错误路径、旧入口与撤权后的本人历史",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const f = await assignmentFixture();
    const outsider = await account();
    const token = await signToken({ sub: f.student, role: "user" });
    const stranger = await signToken({ sub: outsider, role: "user" });
    const teacher = await signToken({ sub: f.teacher, role: "user" });
    await setMemberRoles(f.other.slug, f.owner, f.student, ["educator"]);
    const otherClass = await createClassroom(f.other.slug, f.student, {
      name: "另一域教练班级",
    });
    const assignment = await createAssignment(
      f.school.slug,
      f.classroom.id,
      f.teacher,
      f.input,
    );
    const now = new Date().toISOString(),
      submissionId = crypto.randomUUID(),
      contestId = crypto.randomUUID();
    await getDb().insert(submissions).values({
      id: submissionId,
      domain_id: f.school.id,
      domain_problem_binding_id: f.bindingId,
      problem_id: f.problemId,
      user_id: f.student,
      submitted_version_id: f.versionId,
      version_origin: "known",
      language: "python3",
      code: "print('private answer')",
      status: "finished",
      created_at: now,
    });
    await getDb().insert(contests).values({
      id: contestId,
      domain_id: f.school.id,
      type: "kaggle",
      title: "私有域比赛",
      kind: "public",
      created_by: f.owner,
      start_time: new Date(Date.now() + 60000).toISOString(),
      end_time: new Date(Date.now() + 120000).toISOString(),
      created_at: now,
      updated_at: now,
    });
    const app = createApp(), prefix = `/api/v1/domains/${f.school.slug}`;
    for (
      const path of [
        `${prefix}/problems/1001`,
        `${prefix}/classrooms/${f.classroom.id}`,
        `${prefix}/submissions/${submissionId}`,
        `${prefix}/contests/${contestId}`,
        `${prefix}/stats`,
        `${prefix}/search?q=private&types=problem`,
      ]
    ) {
      const response = await jsonRequest(app, path, { token: stranger });
      assertEquals(response.status, 404, `${path}: ${await response.text()}`);
    }
    assertEquals(
      (await jsonRequest(app, `${prefix}/problems/1001`, { token })).status,
      200,
    );
    assertEquals(
      (await jsonRequest(app, `${prefix}/submissions/${submissionId}`, {
        token,
      })).status,
      200,
    );
    assertEquals(
      (await jsonRequest(app, `${prefix}/assignments/${assignment.id}`, {
        token: teacher,
      })).status,
      200,
    );
    assertEquals(
      (await jsonRequest(
        app,
        `/api/v1/domains/${f.other.slug}/classrooms/${otherClass.id}`,
        { token },
      )).status,
      200,
    );
    for (
      const path of [
        `/api/v1/problems/${f.problemId}`,
        `/api/v1/submissions/${submissionId}`,
        `/api/v1/contests/${contestId}`,
        `/api/v1/domains/${f.other.slug}/submissions/${submissionId}`,
        `/api/v1/domains/${f.other.slug}/assignments/${assignment.id}`,
        `/api/v1/domains/${f.other.slug}/contests/${contestId}`,
        `/api/v1/domains/${f.other.slug}/submissions/${submissionId}/events`,
      ]
    ) {
      const response = await jsonRequest(app, path, { token });
      assertEquals(response.status, 404, `${path}: ${await response.text()}`);
    }
    await removeDomainMember(f.school.slug, f.owner, f.student);
    assertEquals(
      (await jsonRequest(app, `${prefix}/problems/1001`, { token })).status,
      404,
    );
    assertEquals(
      (await jsonRequest(app, `${prefix}/submissions/${submissionId}`, {
        token,
      })).status,
      404,
    );
    const history = await jsonRequest(
      app,
      `/api/v1/me/submissions/submission/${submissionId}`,
      { token },
    );
    assertEquals(history.status, 200);
    const result = await history.json();
    assertEquals(result.data.domain.id, f.school.id);
    assertEquals(result.data.code, "print('private answer')");
    assertEquals(result.data.domain.accessible, false);
    assertEquals(result.data.resource_available, false);
    assertEquals(result.data.problem.title, "资源不可用");
    assertEquals(
      (await jsonRequest(
        app,
        `/api/v1/me/submissions/submission/${submissionId}`,
        { token: teacher },
      )).status,
      404,
    );
  },
});
