import { assert, assertEquals } from "jsr:@std/assert@^1";
import { Hono } from "hono";
import { getDb } from "../../../../shared/db/connection.ts";
import { resetDbForTest } from "../../../../../tests/helpers/db.ts";
import { AppError } from "../../../../shared/base/errors.ts";
import {
  classroomMemberships,
  classrooms,
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
  setMemberRoles,
} from "../../../access/workspace/index.ts";
import { signToken } from "../../../access/identity/index.ts";
import {
  addDomainContestParticipants,
  createDomainContest,
} from "../../index.ts";
import { setContestClassrooms } from "../../services/classroom-contests.ts";
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
      await setMemberRoles(f.domain.slug, f.owner, f.student, ["admin"]);
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
      await setMemberRoles(f.domain.slug, f.owner, f.student, ["member"]);
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

Deno.test({
  name: "域比赛 SSE：榜单载荷带班级分区且筛选参数与 REST 同源",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const f = await fixture("contest-sse-classroom", true), application = app();
    /**
     * 直接插入班级与成员行，而不是走 `createClassroom`：本夹具的域 preset 是 `team`，
     * 教学模块在该 preset 下被停用，接口会返回「此模块已停用」。本用例验证的是
     * **SSE 载荷的分区形状**，与教学模块开关无关，用最小数据构造即可。
     */
    const room = { id: crypto.randomUUID(), name: "一班" };
    const now = new Date().toISOString();
    await getDb().insert(classrooms).values({
      id: room.id,
      domain_id: f.domain.id,
      name: room.name,
      created_at: now,
      updated_at: now,
    });
    await getDb().insert(classroomMemberships).values({
      id: crypto.randomUUID(),
      domain_id: f.domain.id,
      classroom_id: room.id,
      user_id: f.student,
      role: "student",
      status: "active",
      joined_at: now,
      appointed_at: now,
    });
    await getDb().transaction((tx) =>
      setContestClassrooms(tx, f.domain.id, f.contest.id, f.owner, [room.id])
    );

    /** 读一次流首帧（`contest:ranking:snapshot`）并解析成 JSON。 */
    async function readSnapshot(query: string) {
      const controller = new AbortController();
      const response = await application.request(
        `/api/v1/domains/${f.domain.slug}/contests/${f.contest.id}/events${query}`,
        {
          headers: { Authorization: `Bearer ${f.ownerToken}` },
          signal: controller.signal,
        },
      );
      const reader = response.body!.getReader(), decoder = new TextDecoder();
      try {
        const chunk = decoder.decode((await reader.read()).value);
        const line = chunk.split("\n").find((l) => l.startsWith("data: "));
        assert(line !== undefined, chunk);
        return JSON.parse(line!.slice("data: ".length));
      } finally {
        controller.abort();
        await reader.cancel();
      }
    }

    const unfiltered = await readSnapshot("");
    assert(Array.isArray(unfiltered.classrooms), "载荷必须带 classrooms");
    assertEquals(unfiltered.classrooms.map((r: { id: string }) => r.id), [
      room.id,
    ]);
    assert(Array.isArray(unfiltered.classroom_rows));
    assert(Array.isArray(unfiltered.other_rows));
    assertEquals(unfiltered.classroom_id, null);

    const filtered = await readSnapshot(`?classroom_id=${room.id}`);
    assertEquals(filtered.classroom_id, room.id);
    assert(Array.isArray(filtered.classroom_rows));

    // 非关联班级的筛选不能静默返回全部：首帧推送抛 BadRequestError 后流被关闭，
    // 因此读端拿不到 `contest:ranking:snapshot`。这与 REST 的 400 是同一口径。
    const controller = new AbortController();
    const rejected = await application.request(
      `/api/v1/domains/${f.domain.slug}/contests/${f.contest.id}/events?classroom_id=${crypto.randomUUID()}`,
      {
        headers: { Authorization: `Bearer ${f.ownerToken}` },
        signal: controller.signal,
      },
    );
    const rejectedReader = rejected.body!.getReader(),
      decoder = new TextDecoder();
    try {
      let text = "";
      while (true) {
        const { value, done } = await rejectedReader.read();
        if (done) break;
        text += decoder.decode(value);
      }
      assert(
        !text.includes("contest:ranking:snapshot"),
        `非关联班级不应拿到榜单快照：${text}`,
      );
    } finally {
      controller.abort();
      await rejectedReader.cancel();
    }
  },
});
