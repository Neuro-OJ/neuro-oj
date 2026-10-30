import { assert, assertEquals, assertRejects } from "jsr:@std/assert@^1";
import { Hono } from "hono";
import { signToken } from "../../../../access/identity/index.ts";
import { domainStatsSse } from "../../routes/sse.ts";
import { recordSseEvent } from "../../../../../shared/sse/sse-events.ts";
import { _dispatchToLocalListenersForTest } from "../../../../../shared/sse/event-bus.ts";
import { eq, sql } from "drizzle-orm";
import { getDb } from "../../../../../shared/db/connection.ts";
import { resetDbForTest } from "../../../../../../tests/helpers/db.ts";
import {
  contests,
  domainMemberships,
  domainProblemBindings,
  domains,
  evaluationAttempts,
  problems,
  submissions,
  users,
} from "../../../../../shared/db/schema.ts";
import { publishAllProblemsForTest } from "../../../../../../tests/helper.ts";
import {
  DEFAULT_DOMAIN_ID,
  ensureDefaultWorkspace,
  presetConfiguration,
} from "../../../../access/workspace/index.ts";
import {
  domainProblemProgressWhere,
  getDomainProblemSummaries,
  getDomainRankingRows,
  getDomainRecentSubmissions,
  getDomainStats,
  loadDomainQueryScope,
  PUBLIC_DEFAULT_QUERY_SCOPE,
} from "../../services/domain-query.ts";
import { getDomainSubmissionStats } from "../../services/stats-cache.ts";
import { getGlobalRankings } from "../../services/rankings.ts";
import { NotFoundError } from "../../../../../shared/base/errors.ts";

export async function fixture() {
  await resetDbForTest();
  const db = getDb(), now = new Date().toISOString(), actor = "query-student";
  await db.insert(users).values({
    id: actor,
    username: actor,
    email: `${actor}@example.com`,
    created_at: now,
    updated_at: now,
  });
  await ensureDefaultWorkspace();
  await db.insert(domains).values(
    ["school-query-a", "school-query-b"].map((id) => ({
      id,
      slug: id,
      name: id,
      owner_id: actor,
      preset: "education" as const,
      configuration: presetConfiguration("education"),
      created_at: now,
      updated_at: now,
    })),
  );
  await db.insert(domainMemberships).values(
    ["school-query-a", "school-query-b"].map((domain_id) => ({
      id: `member-${domain_id}`,
      domain_id,
      user_id: actor,
      status: "active" as const,
      joined_at: now,
    })),
  );
  const domainIds = [DEFAULT_DOMAIN_ID, "school-query-a", "school-query-b"];
  const problemId = (domainId: string) =>
    domainId === DEFAULT_DOMAIN_ID
      ? "query-source"
      : `query-source-${domainId}`;
  await db.insert(problems).values(domainIds.map((domain_id) => ({
    id: problemId(domain_id),
    domain_id,
    number: 997001,
    title: "独立题目",
    description: "题面",
    owner_id: actor,
    visibility: "public" as const,
    created_at: now,
    updated_at: now,
  })));
  await db.insert(domainProblemBindings).values(domainIds.map((domain_id) => ({
    id: `binding-${domain_id}`,
    domain_id,
    problem_id: problemId(domain_id),
    kind: "owned" as const,
    visibility: "public" as const,
    created_by: actor,
    created_at: now,
    updated_at: now,
  })));
  await publishAllProblemsForTest();
  await db.insert(submissions).values(
    [DEFAULT_DOMAIN_ID, "school-query-a", "school-query-b"].map(
      (domain_id) => ({
        id: `submit-${domain_id}`,
        domain_id,
        domain_problem_binding_id: `binding-${domain_id}`,
        problem_id: problemId(domain_id),
        user_id: actor,
        language: "python3",
        code: "print(1)",
        version_origin: "legacy_unknown" as const,
        is_valid: true,
        is_accepted: domain_id !== "school-query-b",
        status: "finished" as const,
        created_at: now,
      }),
    ),
  );
  return { db, actor, now };
}

Deno.test("域首页评测：只展示当前域可用练习，下架副本立即隐藏且不返回代码", async () => {
  const { db, actor } = await fixture();
  await db.insert(evaluationAttempts).values({
    id: "home-graded",
    submission_id: "submit-school-query-a",
    problem_id: "query-source-school-query-a",
    sequence: 0,
    source: "initial",
    state: "finished",
    result_kind: "graded",
    result_status: "finished",
    score: 7500,
    accepted: false,
    time_ms: 42,
    memory_kb: 1024,
    created_at: new Date().toISOString(),
  });
  await db.update(submissions).set({
    effective_attempt_id: "home-graded",
    latest_attempt_id: "home-graded",
  }).where(eq(submissions.id, "submit-school-query-a"));
  const a = await loadDomainQueryScope("school-query-a", actor);
  const rows = await getDomainRecentSubmissions(a, actor);
  assertEquals(rows.map((row) => row.id), ["submit-school-query-a"]);
  assertEquals(rows[0].result, {
    status: "finished",
    score: 7500,
    time_ms: 42,
    memory_kb: 1024,
  });
  assertEquals(
    Object.keys(rows[0]).sort(),
    [
      "id",
      "public_id",
      "problem_id",
      "status",
      "created_at",
      "problem",
      "result",
    ].sort(),
  );
  assertEquals(
    (await getDomainRecentSubmissions(PUBLIC_DEFAULT_QUERY_SCOPE, null)).map(
      (row) => row.id,
    ),
    [`submit-${DEFAULT_DOMAIN_ID}`],
  );
  assertEquals((await getDomainRecentSubmissions(a, "other-user")).length, 0);
  await db.update(domainProblemBindings).set({
    disabled_at: new Date().toISOString(),
  }).where(eq(domainProblemBindings.id, "binding-school-query-a"));
  assertEquals((await getDomainRecentSubmissions(a, actor)).length, 0);
});

Deno.test("本人题库状态：不计全站排行的已结束比赛仍显示通过，赛中与全站榜继续排除", async () => {
  const { db, actor, now } = await fixture();
  await db.insert(contests).values({
    id: "main-unranked",
    domain_id: DEFAULT_DOMAIN_ID,
    title: "不计全站排行",
    created_by: actor,
    type: "oi",
    kind: "invite",
    description: "",
    affect_global_ranking: false,
    start_time: new Date(Date.now() - 60000).toISOString(),
    end_time: new Date(Date.now() + 60000).toISOString(),
    created_at: now,
    updated_at: now,
  });
  await db.update(submissions).set({
    contest_id: "main-unranked",
    is_accepted: true,
  }).where(eq(submissions.id, `submit-${DEFAULT_DOMAIN_ID}`));
  const scope = await loadDomainQueryScope("main", actor);
  assertEquals(
    (await getDomainProblemSummaries(scope, ["query-source"], actor)).length,
    0,
  );
  await db.update(contests).set({
    end_time: new Date(Date.now() - 1000).toISOString(),
  }).where(eq(contests.id, "main-unranked"));
  const summary =
    (await getDomainProblemSummaries(scope, ["query-source"], actor))[0];
  assertEquals(summary.solved, true);
  assertEquals(summary.submit_count, 1);
  const matched = await db.select({ id: problems.id }).from(problems).where(
    domainProblemProgressWhere(scope, sql`${problems.id}`, actor, "solved"),
  );
  assertEquals(matched.map((row) => row.id), ["query-source"]);
  assertEquals((await getGlobalRankings({ page: 1 })).total, 0);
});

Deno.test("域统计与榜单：三个域独立副本、下架副本即时去除候选", async () => {
  const { db, actor } = await fixture();
  const a = await loadDomainQueryScope("school-query-a", actor),
    b = await loadDomainQueryScope("school-query-b", actor);
  assertEquals((await getDomainStats(a)).submissions, 1);
  assertEquals((await getDomainStats(a)).problems, 1);
  assertEquals(
    (await getDomainRankingRows(a, { page: 1 })).data[0].solved_count,
    1,
  );
  assertEquals((await getDomainRankingRows(b, { page: 1 })).total, 0);
  assertEquals(
    (await getGlobalRankings({ page: 1 })).data[0].total_submissions,
    1,
  );
  await db.update(domainProblemBindings).set({
    disabled_at: new Date().toISOString(),
  }).where(eq(domainProblemBindings.id, "binding-school-query-a"));
  assertEquals((await getDomainStats(a)).submissions, 0);
  assertEquals((await getDomainStats(a)).problems, 0);
  assertEquals((await getDomainRankingRows(a, { page: 1 })).total, 0);
  assertEquals((await getDomainSubmissionStats(a)).total, 0);
  assertEquals(
    (await getDomainStats(PUBLIC_DEFAULT_QUERY_SCOPE)).submissions,
    1,
  );
});
Deno.test({
  name: "域统计SSE：重放只含重算统计，移除成员后停止私有推送",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const { db, actor } = await fixture(),
      channel = "noj:events:domain:school-query-a:stats";
    const seq = await recordSseEvent(channel, {
      type: "stats:updated",
      score: 9999,
      code: "never forward",
    });
    const app = new Hono();
    app.route("/", domainStatsSse);
    const controller = new AbortController(),
      token = await signToken({ sub: actor, role: "user" });
    const response = await app.request(
      "/domains/school-query-a/submissions/stats/events",
      {
        headers: {
          Authorization: `Bearer ${token}`,
          "Last-Event-ID": String(seq - 1),
        },
        signal: controller.signal,
      },
    );
    assertEquals(response.status, 200);
    const reader = response.body!.getReader(), decoder = new TextDecoder();
    try {
      const initial = decoder.decode((await reader.read()).value);
      assert(initial.includes('"total":1'));
      const replay = decoder.decode((await reader.read()).value);
      assert(replay.includes(`id: ${seq}`));
      assert(!replay.includes("9999"));
      assert(!replay.includes("never forward"));
      await db.update(domainMemberships).set({ status: "removed" }).where(
        eq(domainMemberships.id, "member-school-query-a"),
      );
      const closed = reader.read();
      _dispatchToLocalListenersForTest(
        channel,
        JSON.stringify({ type: "stats:updated", score: 8888 }),
      );
      assertEquals((await closed).done, true);
    } finally {
      controller.abort();
      await reader.cancel();
    }
  },
});
Deno.test("域统计权限：非成员、移除成员与停用域重新解析拒绝", async () => {
  const { db, actor } = await fixture();
  await assertRejects(
    () => loadDomainQueryScope("school-query-a", null),
    NotFoundError,
  );
  await db.update(domainMemberships).set({ status: "removed" }).where(
    eq(domainMemberships.id, "member-school-query-a"),
  );
  await assertRejects(
    () => loadDomainQueryScope("school-query-a", actor),
    NotFoundError,
  );
});
Deno.test("域统计比赛保密：赛中最后提交不进入计数和域榜，结束后纳入", async () => {
  const { db, actor, now } = await fixture();
  await db.insert(contests).values({
    id: "query-hidden-contest",
    domain_id: "school-query-a",
    title: "OI",
    type: "oi",
    kind: "public",
    is_public: true,
    created_by: actor,
    start_time: now,
    end_time: new Date(Date.now() + 3600000).toISOString(),
    created_at: now,
    updated_at: now,
  });
  await db.update(submissions).set({ contest_id: "query-hidden-contest" })
    .where(eq(submissions.id, "submit-school-query-a"));
  const scope = await loadDomainQueryScope("school-query-a", actor);
  assertEquals((await getDomainStats(scope)).accepted, 0);
  assertEquals((await getDomainStats(scope)).submissions, 0);
  assertEquals((await getDomainRankingRows(scope, { page: 1 })).total, 0);
  await db.update(contests).set({
    start_time: new Date(Date.now() - 10000).toISOString(),
    end_time: new Date(Date.now() - 1000).toISOString(),
  }).where(eq(contests.id, "query-hidden-contest"));
  assertEquals((await getDomainStats(scope)).accepted, 1);
});
