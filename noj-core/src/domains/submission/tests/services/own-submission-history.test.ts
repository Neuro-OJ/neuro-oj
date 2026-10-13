import { assert, assertEquals, assertRejects } from "jsr:@std/assert@^1";
import { Hono } from "hono";
import { eq } from "drizzle-orm";
import { getDb } from "../../../../shared/db/connection.ts";
import {
  contests,
  domainProblemBindings,
  evaluationAttempts,
  objectiveSubmissions,
  problems,
  problemVersions,
} from "../../../../shared/db/schema.ts";
import { AppError, NotFoundError } from "../../../../shared/base/errors.ts";
import { setDomainProblemSharing } from "../../../catalog/index.ts";
import { removeDomainMember } from "../../../workspace/index.ts";
import { signToken } from "../../../identity/index.ts";
import {
  createDomainSubmission,
  getOwnSubmissionHistory,
  listOwnSubmissionHistory,
} from "../../index.ts";
import { ownSubmissionHistoryRouter } from "../../routes/own-submission-history.ts";
import { fixture, withQueue } from "../_domain-execution-fixture.ts";
import { saveV2ResultForTest } from "../_versioning-fixtures.ts";

Deno.test({
  name: "本人跨域历史：同源提交各保留归属，离域与撤销共享只保留原代码成绩",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const f = await fixture();
    await withQueue(async () => {
      const a = await createDomainSubmission(f.a.slug, f.ref, f.student, {
        language: "python3",
        code: "student a",
        version_id: f.v2,
      });
      const b = await createDomainSubmission(f.b.slug, f.ref, f.student, {
        language: "python3",
        code: "student b",
        version_id: f.v2,
      });
      await saveV2ResultForTest({
        submission_id: a.id,
        status: "finished",
        score: 7000,
        output: "grader secret",
        details: {
          oi: { verdict: "任意评测正文不能出现在摘要" },
          arbitrary: "never expose",
          cases: [{ input: "hidden data" }],
        },
      });
      const list = await listOwnSubmissionHistory(f.student, 1, 20);
      assertEquals(list.total, 2);
      const scoped = await listOwnSubmissionHistory(f.student, 1, 1, {
        domainId: f.a.id,
        kind: "submission",
        problemId: f.problemId,
      });
      assertEquals(scoped.total, 1);
      assertEquals(scoped.data[0].id, a.id);
      assertEquals(
        new Set(list.data.map((r) => r.domain.id)),
        new Set([f.a.id, f.b.id]),
      );
      assert(
        list.data.every((r) => r.code === undefined && r.answers === undefined),
      );
      await assertRejects(
        () => getOwnSubmissionHistory(f.owner, "submission", a.id),
        NotFoundError,
      );
      await setDomainProblemSharing(f.source.slug, "1001", f.owner, {
        expectedRevision: 1,
        enabled: false,
        scope: "all",
        targetDomainIds: [],
      });
      const withdrawn = await getOwnSubmissionHistory(
        f.student,
        "submission",
        a.id,
      );
      assertEquals(withdrawn.resource_available, false);
      assertEquals(withdrawn.code, "student a");
      assertEquals(withdrawn.result?.score, 7000);
      await removeDomainMember(f.a.slug, f.owner, f.student);
      const historical = await getOwnSubmissionHistory(
        f.student,
        "submission",
        a.id,
      );
      assertEquals(historical.domain.accessible, false);
      assertEquals(historical.problem.title, "资源不可用");
      assertEquals(historical.code, "student a");
      assertEquals(historical.result?.score, 7000);
      const serialized = JSON.stringify(historical);
      assert(!serialized.includes("grader secret"));
      assert(!serialized.includes("never expose"));
      assert(!serialized.includes("hidden data"));
      assert(!serialized.includes("任意评测正文"));
      await setDomainProblemSharing(f.source.slug, "1001", f.owner, {
        expectedRevision: 2,
        enabled: true,
        scope: "all",
        targetDomainIds: [],
      });
      assertEquals(
        (await getOwnSubmissionHistory(f.student, "submission", a.id))
          .resource_available,
        false,
      );
      assertEquals(
        (await getOwnSubmissionHistory(f.student, "submission", b.id))
          .resource_available,
        true,
      );
      const app = new Hono();
      app.onError((e, c) =>
        c.json(
          { error: e.message },
          e instanceof AppError ? e.statusCode as 404 : 500,
        )
      );
      app.route("/", ownSubmissionHistoryRouter);
      const token = await signToken({ sub: f.student, role: "user" });
      const response = await app.request(`/me/submissions/submission/${a.id}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      assertEquals(response.status, 200);
      assertEquals((await response.json()).data.code, "student a");
    });
  },
});
Deno.test({
  name:
    "本人跨域客观题历史：原答案可读，OI赛中仍隐藏成绩与标准答案，赛后离域保留摘要",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const f = await fixture(), db = getDb(), now = new Date().toISOString();
    const paper = "history-private-paper", version = "history-private-version";
    await db.insert(problems).values({
      id: paper,
      domain_id: f.a.id,
      number: 1001,
      type: "P",
      is_objective: true,
      title: "秘密客观卷",
      description: "秘密题面",
      visibility: "public",
      owner_id: f.owner,
      created_at: now,
      updated_at: now,
    });
    await db.insert(problemVersions).values({
      id: version,
      problem_id: paper,
      version: 1,
      published_at: now,
      content: {
        kind: "objective",
        title: "秘密客观卷",
        description: "秘密题面",
        samples: [],
        questions: [{
          key: "q",
          sort_order: 0,
          type: "single",
          prompt: "秘密小题",
          options: [{ key: "A", content: "A" }, { key: "B", content: "B" }],
          answer: ["B"],
          explanation: "秘密解析",
        }],
      },
    });
    await db.update(problems).set({ latest_version_id: version }).where(
      eq(problems.id, paper),
    );
    await db.insert(domainProblemBindings).values({
      id: "history-paper-binding",
      domain_id: f.a.id,
      problem_id: paper,
      kind: "owned",
      visibility: "members",
      created_by: f.owner,
      created_at: now,
      updated_at: now,
    });
    await db.insert(contests).values({
      id: "history-oi",
      domain_id: f.a.id,
      title: "OI",
      type: "oi",
      kind: "public",
      is_public: true,
      created_by: f.owner,
      start_time: new Date(Date.now() - 1000).toISOString(),
      end_time: new Date(Date.now() + 3600000).toISOString(),
      created_at: now,
      updated_at: now,
    });
    await db.insert(objectiveSubmissions).values({
      id: "history-objective",
      domain_id: f.a.id,
      domain_problem_binding_id: "history-paper-binding",
      paper_id: paper,
      user_id: f.student,
      contest_id: "history-oi",
      submission_type: "contest",
      answers: { q: ["A"] },
      score: 7000,
      status: "finished",
      submitted_version_id: version,
      version_origin: "known",
      created_at: now,
    });
    await db.insert(evaluationAttempts).values({
      id: "history-objective-grade",
      objective_submission_id: "history-objective",
      problem_id: paper,
      problem_version_id: version,
      sequence: 0,
      source: "initial",
      state: "finished",
      result_kind: "graded",
      result_status: "finished",
      score: 7000,
      accepted: false,
      details: { q: { expected: ["B"], given: ["A"] } },
      created_at: now,
    });
    await db.update(objectiveSubmissions).set({
      effective_attempt_id: "history-objective-grade",
      is_valid: true,
    }).where(eq(objectiveSubmissions.id, "history-objective"));
    const hidden = await getOwnSubmissionHistory(
      f.student,
      "objective",
      "history-objective",
    );
    assertEquals(hidden.answers, { q: ["A"] });
    assertEquals(hidden.result_visibility, "hidden");
    assertEquals(hidden.result, undefined);
    assertEquals(hidden.is_valid, undefined);
    assertEquals(hidden.status, "submitted");
    assertEquals(
      (await listOwnSubmissionHistory(f.student, 1, 20, {
        domainId: f.b.id,
        kind: "objective",
      })).total,
      0,
    );
    await removeDomainMember(f.a.slug, f.owner, f.student);
    assertEquals(
      (await getOwnSubmissionHistory(
        f.student,
        "objective",
        "history-objective",
      )).result,
      undefined,
    );
    await db.update(contests).set({
      start_time: new Date(Date.now() - 10000).toISOString(),
      end_time: new Date(Date.now() - 1000).toISOString(),
    }).where(eq(contests.id, "history-oi"));
    const ended = await getOwnSubmissionHistory(
      f.student,
      "objective",
      "history-objective",
    );
    assertEquals(ended.domain.accessible, false);
    assertEquals(ended.problem.title, "资源不可用");
    assertEquals(ended.answers, { q: ["A"] });
    assertEquals(ended.result?.score, 7000);
    assert(!JSON.stringify(ended).includes("秘密题面"));
    assert(!JSON.stringify(ended).includes("秘密小题"));
    assert(!JSON.stringify(ended).includes("expected"));
    assert(!JSON.stringify(ended).includes('["B"]'));
    assertEquals(
      (await listOwnSubmissionHistory(f.student, 1, 20)).data[0].kind,
      "objective",
    );
  },
});
