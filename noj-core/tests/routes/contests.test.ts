import { assertEquals, assertExists } from "jsr:@std/assert@^1";
import { eq, inArray } from "drizzle-orm";
import { createApp } from "../../src/app.ts";
import { getDb, resetDbForTest } from "../../src/db/connection.ts";
import { contests, problems, submissions, users } from "../../src/db/schema.ts";
import { signToken } from "../../src/lib/jwt.ts";
import { initRedisForTest, jsonRequest } from "../lib/helper.ts";

await resetDbForTest();
await initRedisForTest();

Deno.test({
  name: "contests routes: 公开访问、注册、题目、排名与管理端 CRUD",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const db = getDb();
    const adminId = crypto.randomUUID();
    const userId = crypto.randomUUID();
    const invitedId = crypto.randomUUID();
    const problemId = crypto.randomUUID();
    const otherProblemId = crypto.randomUUID();
    const unique = `${Date.now()}-${crypto.randomUUID().slice(0, 8)}`;
    const now = new Date().toISOString();
    const app = createApp();

    await db.insert(users).values([
      {
        id: adminId,
        username: `contest-admin-${unique}`,
        email: `contest-admin-${unique}@example.com`,
        password_hash: "hash",
        role: "admin",
        created_at: now,
        updated_at: now,
      },
      {
        id: userId,
        username: `contest-user-${unique}`,
        email: `contest-user-${unique}@example.com`,
        password_hash: "hash",
        role: "user",
        created_at: now,
        updated_at: now,
      },
      {
        id: invitedId,
        username: `contest-invited-${unique}`,
        email: `contest-invited-${unique}@example.com`,
        password_hash: "hash",
        role: "user",
        created_at: now,
        updated_at: now,
      },
    ]);
    await db.insert(problems).values([
      {
        id: problemId,
        title: "路由竞赛题 A",
        description: "测试题面 A",
        difficulty: "easy",
        runtime_config: {},
        number: 930001,
        owner_id: adminId,
        type: "P",
        created_at: now,
        updated_at: now,
      },
      {
        id: otherProblemId,
        title: "非竞赛题",
        description: "测试题面 B",
        difficulty: "easy",
        runtime_config: {},
        number: 930002,
        owner_id: adminId,
        type: "P",
        created_at: now,
        updated_at: now,
      },
    ]);

    const adminToken = await signToken({
      sub: adminId,
      role: "admin",
      is_admin: true,
    });
    const userToken = await signToken({ sub: userId, role: "user" });
    const invitedToken = await signToken({ sub: invitedId, role: "user" });
    let contestId: string | undefined;
    let privateContestId: string | undefined;
    let submissionId: string | undefined;

    try {
      const unauthorized = await jsonRequest(
        app,
        "/api/v1/admin/contests",
        { method: "POST", body: {}, token: userToken },
      );
      assertEquals(unauthorized.status, 403);

      const createResponse = await jsonRequest(
        app,
        "/api/v1/admin/contests",
        {
          method: "POST",
          token: adminToken,
          body: {
            title: "公开进行中竞赛",
            start_time: new Date(Date.now() - 60_000).toISOString(),
            end_time: new Date(Date.now() + 3_600_000).toISOString(),
            type: "icpc",
            problems: [{
              problem_id: problemId,
              label: "A",
              sort_order: 0,
            }],
          },
        },
      );
      assertEquals(createResponse.status, 201);
      const created = await createResponse.json();
      contestId = created.data.id;
      assertExists(contestId);

      const privateResponse = await jsonRequest(
        app,
        "/api/v1/admin/contests",
        {
          method: "POST",
          token: adminToken,
          body: {
            title: "邀请制竞赛",
            start_time: new Date(Date.now() + 60_000).toISOString(),
            end_time: new Date(Date.now() + 3_600_000).toISOString(),
            type: "oi",
            is_public: false,
            problems: [{
              problem_id: problemId,
              label: "A",
              sort_order: 0,
              score: 10000,
            }],
          },
        },
      );
      assertEquals(privateResponse.status, 201);
      privateContestId = (await privateResponse.json()).data.id;

      const publicList = await jsonRequest(app, "/api/v1/contests");
      assertEquals(publicList.status, 200);
      const publicListBody = await publicList.json();
      assertEquals(
        publicListBody.data.some((item: { id: string }) =>
          item.id === contestId
        ),
        true,
      );
      assertEquals(
        publicListBody.data.some((item: { id: string }) =>
          item.id === privateContestId
        ),
        false,
      );

      const hidden = await jsonRequest(
        app,
        `/api/v1/contests/${privateContestId}`,
        { token: userToken },
      );
      assertEquals(hidden.status, 404);

      const register = await jsonRequest(
        app,
        `/api/v1/contests/${contestId}/register`,
        { method: "POST", token: userToken },
      );
      assertEquals(register.status, 201);

      const detail = await jsonRequest(
        app,
        `/api/v1/contests/${contestId}`,
        { token: userToken },
      );
      assertEquals(detail.status, 200);
      assertEquals((await detail.json()).data.is_registered, true);

      const problemList = await jsonRequest(
        app,
        `/api/v1/contests/${contestId}/problems`,
        { token: userToken },
      );
      assertEquals(problemList.status, 200);
      assertEquals((await problemList.json()).data[0].label, "A");

      const problemDetail = await jsonRequest(
        app,
        `/api/v1/contests/${contestId}/problems/A`,
        { token: userToken },
      );
      assertEquals(problemDetail.status, 200);
      assertEquals((await problemDetail.json()).data.problem_id, problemId);

      const ranking = await jsonRequest(
        app,
        `/api/v1/contests/${contestId}/ranking`,
      );
      assertEquals(ranking.status, 200);
      assertEquals((await ranking.json()).data.length, 1);

      const invalidProblemSubmit = await jsonRequest(
        app,
        `/api/v1/contests/${contestId}/submit`,
        {
          method: "POST",
          token: userToken,
          body: {
            problem_id: otherProblemId,
            language: "python3",
            code: "print(1)",
          },
        },
      );
      assertEquals(invalidProblemSubmit.status, 400);

      const mySubmissions = await jsonRequest(
        app,
        `/api/v1/contests/${contestId}/my-submissions`,
        { token: userToken },
      );
      assertEquals(mySubmissions.status, 200);
      assertEquals((await mySubmissions.json()).data, []);

      const addParticipant = await jsonRequest(
        app,
        `/api/v1/admin/contests/${privateContestId}/participants`,
        { method: "POST", token: adminToken, body: [invitedId] },
      );
      assertEquals(addParticipant.status, 201);

      const invitedDetail = await jsonRequest(
        app,
        `/api/v1/contests/${privateContestId}`,
        { token: invitedToken },
      );
      assertEquals(invitedDetail.status, 200);

      const pendingProblems = await jsonRequest(
        app,
        `/api/v1/contests/${privateContestId}/problems`,
        { token: invitedToken },
      );
      assertEquals(pendingProblems.status, 403);

      const participants = await jsonRequest(
        app,
        `/api/v1/admin/contests/${privateContestId}/participants`,
        { token: adminToken },
      );
      assertEquals(participants.status, 200);
      assertEquals((await participants.json()).data.length, 1);

      const adminSubmissions = await jsonRequest(
        app,
        `/api/v1/admin/contests/${contestId}/submissions`,
        { token: adminToken },
      );
      assertEquals(adminSubmissions.status, 200);
      assertEquals((await adminSubmissions.json()).data, []);

      submissionId = crypto.randomUUID();
      await db.insert(submissions).values({
        id: submissionId,
        user_id: userId,
        problem_id: problemId,
        contest_id: contestId,
        language: "python3",
        code: "print(1)",
        status: "finished",
        created_at: now,
      });
      const statusResponse = await jsonRequest(
        app,
        `/api/v1/submissions/${submissionId}/status`,
        { token: invitedToken },
      );
      assertEquals(statusResponse.status, 200);
      assertEquals((await statusResponse.json()).contest_id, contestId);

      const update = await jsonRequest(
        app,
        `/api/v1/admin/contests/${contestId}`,
        {
          method: "PUT",
          token: adminToken,
          body: { announcement: "测试公告" },
        },
      );
      assertEquals(update.status, 200);
      assertEquals((await update.json()).data.announcement, "测试公告");
    } finally {
      if (submissionId) {
        await db.delete(submissions).where(eq(submissions.id, submissionId));
      }
      const ids = [contestId, privateContestId].filter(
        (id): id is string => id !== undefined,
      );
      if (ids.length > 0) {
        await db.delete(contests).where(inArray(contests.id, ids));
      }
      await db.delete(problems).where(inArray(
        problems.id,
        [problemId, otherProblemId],
      ));
      await db.delete(users).where(inArray(
        users.id,
        [adminId, userId, invitedId],
      ));
    }
  },
});

Deno.test({
  name: "contests routes: 不存在竞赛返回 404",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const response = await jsonRequest(
      createApp(),
      `/api/v1/contests/${crypto.randomUUID()}`,
    );
    assertEquals(response.status, 404);
    const body = await response.json();
    assertEquals(body.code, "NOT_FOUND");
  },
});
