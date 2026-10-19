import { assert, assertEquals } from "jsr:@std/assert@^1";
import { Hono } from "hono";
import { getDb, resetDbForTest } from "../../../../shared/db/connection.ts";
import { AppError } from "../../../../shared/base/errors.ts";
import {
  domainProblemBindings,
  problems,
  problemVersions,
  users,
} from "../../../../shared/db/schema.ts";
import {
  consumeDomainInvitation,
  createDomain,
  createDomainInvitation,
  removeDomainMember,
  transferDomain,
} from "../../../workspace/index.ts";
import { signToken } from "../../../identity/index.ts";
import {
  addDomainContestParticipants,
  createDomainContest,
} from "../../index.ts";
import { domainContestRouter } from "../../routes/domain-contests.ts";
import {
  _dispatchToLocalListenersForTest,
  Channels,
} from "../../../../shared/sse/event-bus.ts";
import { jsonRequest } from "../../../../../tests/helper.ts";
import { recordSseEvent } from "../../../../shared/sse/sse-events.ts";

function app() {
  const app = new Hono();
  app.route("/api/v1", domainContestRouter);
  app.onError((error, c) => {
    if (error instanceof AppError) {
      return c.json(
        { error: error.message, code: error.code },
        error.statusCode as 400,
      );
    }
    throw error;
  });
  return app;
}
async function fixture(slug: string, running = false) {
  await resetDbForTest();
  const db = getDb(),
    owner = crypto.randomUUID(),
    student = crypto.randomUUID(),
    now = new Date().toISOString();
  await db.insert(users).values(
    [owner, student].map((id) => ({
      id,
      username: id,
      email: `${id}@example.com`,
      created_at: now,
      updated_at: now,
    })),
  );
  const domain = await createDomain(
    { slug, name: slug, preset: "team" },
    owner,
    { approved: true },
  );
  const invite = await createDomainInvitation(
    slug,
    owner,
    `${student}@example.com`,
  );
  await consumeDomainInvitation(invite.token, student);
  const p = crypto.randomUUID(), version = crypto.randomUUID();
  await db.insert(problems).values({
    id: p,
    domain_id: domain.id,
    number: 1001,
    title: "OI",
    description: "description",
    owner_id: owner,
    judge_type: "oi",
    created_at: now,
    updated_at: now,
  });
  await db.insert(problemVersions).values({
    id: version,
    problem_id: p,
    version: 1,
    content: { kind: "oi", title: "OI", description: "statement" },
    published_at: now,
  });
  await db.update(problems).set({ latest_version_id: version }).where(
    (await import("drizzle-orm")).eq(problems.id, p),
  );
  await db.insert(domainProblemBindings).values({
    id: crypto.randomUUID(),
    domain_id: domain.id,
    problem_id: p,
    kind: "owned",
    created_by: owner,
    created_at: now,
    updated_at: now,
  });
  const contest = await createDomainContest(slug, owner, {
    title: "school contest",
    type: "ioi",
    start_time: new Date(Date.now() + (running ? -60_000 : 60_000))
      .toISOString(),
    end_time: new Date(Date.now() + 7_200_000).toISOString(),
    freeze_duration_seconds: 0,
    problems: [{ problem_id: p, label: "A", sort_order: 0, score: 10000 }],
  });
  return {
    owner,
    student,
    domain,
    contest,
    problem: p,
    ownerToken: await signToken({ sub: owner, role: "user" }),
    studentToken: await signToken({ sub: student, role: "user" }),
  };
}

Deno.test({
  name: "域比赛 HTTP：revision、来源题号、范围404与组织者端点",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const f = await fixture("contest-http"),
      application = app(),
      path = `/api/v1/domains/${f.domain.slug}/contests/${f.contest.id}`;
    const detail = await jsonRequest(application, path, {
      token: f.studentToken,
    });
    assertEquals(detail.status, 200);
    assertEquals(detail.headers.get("Cache-Control"), "no-store");
    assertEquals(
      (await jsonRequest(application, path, {
        token: f.ownerToken,
        method: "PATCH",
        body: { title: "changed" },
      })).status,
      428,
    );
    const updated = await jsonRequest(application, path, {
      token: f.ownerToken,
      method: "PATCH",
      body: { title: "changed" },
      headers: { "If-Match": "0" },
    });
    assertEquals(updated.status, 200);
    assertEquals((await updated.json()).data.revision, 1);
    assertEquals(
      (await jsonRequest(application, path, {
        token: f.ownerToken,
        method: "PATCH",
        body: { title: "stale" },
        headers: { "If-Match": "0" },
      })).status,
      409,
    );
    const problem = await jsonRequest(application, `${path}/problems/A`, {
      token: f.ownerToken,
    });
    assertEquals(problem.status, 200);
    assertEquals((await problem.json()).data.display_id, "1001");
    assertEquals(
      (await jsonRequest(application, `${path}/settlement`, {
        token: f.studentToken,
      })).status,
      403,
    );
    assertEquals(
      (await jsonRequest(application, `${path}/register`, {
        token: f.studentToken,
        method: "POST",
        body: {},
      })).status,
      201,
    );
    const other = await createDomain(
      { slug: "contest-other-http", name: "other", preset: "team" },
      f.owner,
      { approved: true },
    );
    assertEquals(
      (await jsonRequest(
        application,
        `/api/v1/domains/${other.slug}/contests/${f.contest.id}`,
        { token: f.ownerToken },
      )).status,
      404,
    );
    assertEquals(
      (await jsonRequest(
        application,
        `/api/v1/domains/${other.slug}/contests/${f.contest.id}/events`,
        { token: f.ownerToken },
      )).status,
      404,
    );
  },
});

Deno.test({
  name: "域比赛 SSE：提交事件允许字段列表与成员撤销后长连接停推",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const f = await fixture("contest-sse-scope", true), application = app();
    await addDomainContestParticipants(f.domain.slug, f.contest.id, f.owner, [
      f.student,
    ]);
    const controller = new AbortController();
    const response = await application.request(
      `/api/v1/domains/${f.domain.slug}/contests/${f.contest.id}/events`,
      {
        headers: { Authorization: `Bearer ${f.studentToken}` },
        signal: controller.signal,
      },
    );
    const reader = response.body!.getReader(), decoder = new TextDecoder();
    try {
      const snapshot = decoder.decode((await reader.read()).value);
      assert(snapshot.includes("contest:ranking:snapshot"));
      // writeSSE 已写初始快照；下一轮事件循环让监听及重放注册完成。
      await new Promise((resolve) => setTimeout(resolve, 0));
      const received = reader.read();
      _dispatchToLocalListenersForTest(
        Channels.contestSubmission(f.contest.id),
        JSON.stringify({
          type: "contest:submission:created",
          problem_id: f.problem,
          user_id: "other-student",
          submission_id: "private-id",
          score: 9999,
          output: "secret output",
          details: { hidden: "secret case" },
        }),
      );
      const notice = decoder.decode((await received).value);
      assert(notice.includes(f.problem));
      assert(!notice.includes("private-id"));
      assert(!notice.includes("secret"));
      assert(!notice.includes("9999"));
      await removeDomainMember(f.domain.slug, f.owner, f.student);
      const closed = reader.read();
      _dispatchToLocalListenersForTest(
        Channels.contestSubmission(f.contest.id),
        JSON.stringify({ problem_id: f.problem }),
      );
      assertEquals((await closed).done, true);
    } finally {
      controller.abort();
      await reader.cancel();
    }
  },
});

Deno.test({
  name: "域比赛 SSE：持久事件重放裁剪与组织权限降级立即生效",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const f = await fixture("contest-sse-replay", true), application = app();
    await addDomainContestParticipants(f.domain.slug, f.contest.id, f.owner, [
      f.student,
    ]);
    const cursor = await recordSseEvent(
      Channels.contestSubmission(f.contest.id),
      {
        type: "contest:submission:created",
        problem_id: f.problem,
        submission_id: "earlier-private-id",
        user_id: "another-student",
        output: "earlier secret",
      },
    );
    const controller = new AbortController();
    const response = await application.request(
      `/api/v1/domains/${f.domain.slug}/contests/${f.contest.id}/events`,
      {
        headers: {
          Authorization: `Bearer ${f.studentToken}`,
          "Last-Event-ID": String(cursor - 1),
        },
        signal: controller.signal,
      },
    );
    const reader = response.body!.getReader(), decoder = new TextDecoder();
    try {
      const snapshot = decoder.decode((await reader.read()).value);
      assert(snapshot.includes("contest:ranking:snapshot"));
      const replay = decoder.decode((await reader.read()).value);
      assert(replay.includes(`id: ${cursor}`));
      assert(replay.includes(f.problem));
      assert(!replay.includes("earlier-private-id"));
      assert(!replay.includes("another-student"));
      assert(!replay.includes("secret"));
      await transferDomain(f.domain.slug, f.owner, f.student);
      const asOrganizer = reader.read();
      _dispatchToLocalListenersForTest(
        Channels.contestSubmission(f.contest.id),
        JSON.stringify({
          problem_id: f.problem,
          submission_id: "organizer-visible-id",
          user_id: f.student,
        }),
      );
      assert(
        decoder.decode((await asOrganizer).value).includes(
          "organizer-visible-id",
        ),
      );
      await transferDomain(f.domain.slug, f.student, f.owner);
      const downgraded = reader.read();
      _dispatchToLocalListenersForTest(
        Channels.contestSubmission(f.contest.id),
        JSON.stringify({
          problem_id: f.problem,
          submission_id: "now-private-id",
          user_id: f.student,
        }),
      );
      const notice = decoder.decode((await downgraded).value);
      assert(notice.includes(f.problem));
      assert(!notice.includes("now-private-id"));
      assert(!notice.includes(f.student));
    } finally {
      controller.abort();
      await reader.cancel();
    }
  },
});
