import { assertEquals } from "jsr:@std/assert@^1";
import { eq } from "drizzle-orm";
import { getDb, resetDbForTest } from "../../../../shared/db/connection.ts";
import {
  contests,
  problems,
  submissions,
  userRoles,
  users,
} from "../../../../shared/db/schema.ts";
import { createApp } from "../../../../app.ts";
import { signToken } from "../../../identity/index.ts";
import { initRedisForTest, jsonRequest } from "../../../../../tests/helper.ts";
import {
  cleanupExpiredSubmissionClientIps,
  listContestIpGroups,
  listContestIpTimeline,
} from "../../index.ts";

await resetDbForTest();
Deno.env.set("JWT_SECRET", "anti-cheat-test-secret-012345678901234567890");

Deno.test({
  name: "contest anti-cheat: 同 IP 账号组、时间线与保留清理",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const db = getDb();
    const now = new Date().toISOString();
    const old = new Date(Date.now() - 200 * 86400 * 1000).toISOString();
    const contestId = crypto.randomUUID();
    const problemId = crypto.randomUUID();
    const userA = crypto.randomUUID();
    const userB = crypto.randomUUID();
    await db.insert(users).values([
      {
        id: userA,
        username: `anti-a-${userA.slice(0, 8)}`,
        email: `${userA}@example.com`,
        password_hash: "hash",
        created_at: now,
        updated_at: now,
      },
      {
        id: userB,
        username: `anti-b-${userB.slice(0, 8)}`,
        email: `${userB}@example.com`,
        password_hash: "hash",
        created_at: now,
        updated_at: now,
      },
    ]);
    await db.insert(userRoles).values({ user_id: userA, role_id: "admin" });
    await db.insert(problems).values({
      id: problemId,
      title: "风控测试题",
      description: "",
      difficulty: "easy",
      runtime_config: {},
      number: 980001,
      owner_id: userA,
      type: "P",
      created_at: now,
      updated_at: now,
    });
    await db.insert(contests).values({
      id: contestId,
      public_id: `ct-${contestId.slice(0, 8)}`,
      title: "风控测试赛",
      description: "",
      start_time: new Date(Date.now() - 1000).toISOString(),
      end_time: new Date(Date.now() + 3600000).toISOString(),
      type: "kaggle",
      config: {},
      is_public: true,
      password: null,
      affect_global_ranking: false,
      created_by: userA,
      announcement: "",
      created_at: now,
      updated_at: now,
    });
    await db.insert(submissions).values([
      {
        id: crypto.randomUUID(),
        public_id: `sub-${crypto.randomUUID().slice(0, 8)}`,
        user_id: userA,
        problem_id: problemId,
        contest_id: contestId,
        language: "python",
        code: "a",
        file_name: "main.py",
        status: "finished",
        created_at: old,
        client_ip: "203.0.113.10",
      },
      {
        id: crypto.randomUUID(),
        public_id: `sub-${crypto.randomUUID().slice(0, 8)}`,
        user_id: userB,
        problem_id: problemId,
        contest_id: contestId,
        language: "python",
        code: "b",
        file_name: "main.py",
        status: "finished",
        created_at: now,
        client_ip: "203.0.113.10",
      },
      {
        id: crypto.randomUUID(),
        public_id: `sub-${crypto.randomUUID().slice(0, 8)}`,
        user_id: userA,
        problem_id: problemId,
        contest_id: contestId,
        language: "python",
        code: "c",
        file_name: "main.py",
        status: "finished",
        created_at: now,
        client_ip: null,
      },
    ]);

    const groups = await listContestIpGroups(contestId, { minAccounts: 2 });
    assertEquals(groups.total, 1);
    assertEquals(groups.data[0]?.ip, "203.0.113.10");
    assertEquals(groups.data[0]?.account_count, 2);
    assertEquals(groups.data[0]?.submission_count, 2);

    const timeline = await listContestIpTimeline(contestId, "203.0.113.10");
    assertEquals(timeline.length, 2);
    assertEquals(timeline[0]?.username.startsWith("anti-a-"), true);
    assertEquals(
      "email" in (timeline[0] as unknown as Record<string, unknown>),
      false,
    );

    await initRedisForTest();
    const response = await jsonRequest(
      createApp(),
      `/api/v1/admin/contest/contests/${contestId}/anti-cheat/ip-groups`,
      { token: await signToken({ sub: userA, role: "admin" }) },
    );
    assertEquals(response.status, 200);
    const responseBody = await response.json();
    assertEquals(responseBody.data_policy.automated_penalty, false);

    const cleaned = await cleanupExpiredSubmissionClientIps(180);
    assertEquals(cleaned, 1);
    const remaining = await db.select({ client_ip: submissions.client_ip })
      .from(submissions).where(eq(submissions.contest_id, contestId));
    assertEquals(remaining.filter((row) => row.client_ip !== null).length, 1);
  },
});
