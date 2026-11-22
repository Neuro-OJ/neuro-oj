import { assert, assertEquals } from "jsr:@std/assert@^1";
import { eq, inArray } from "drizzle-orm";
import { createApp } from "../../../../app.ts";
import { jsonRequest } from "../../../../../tests/helper.ts";
import {
  contestParticipants,
  contestProblems,
  contests,
  objectiveSubmissions,
  selfTests,
  submissions,
  users,
} from "../../../../shared/db/schema.ts";
import type { AssignmentSubmissionOrigin } from "../../../../shared/education-types.ts";
import { signToken } from "../../../access/identity/index.ts";
import { fixture, withQueue } from "../_domain-execution-fixture.ts";
import { saveV2ResultForTest } from "../_versioning-fixtures.ts";

type App = ReturnType<typeof createApp>;
type ExecutionFixture = Awaited<ReturnType<typeof fixture>>;

async function http<T>(
  app: App,
  token: string,
  path: string,
  status: number,
  options: {
    method?: string;
    body?: unknown;
    headers?: Record<string, string>;
  } = {},
): Promise<T> {
  const response = await jsonRequest(app, `/api/v1${path}`, {
    ...options,
    token,
  });
  const body = await response.json();
  assertEquals(response.status, status, `${path}: ${JSON.stringify(body)}`);
  return body as T;
}

async function setup(mode: "code" | "artifact" | "oi" = "code") {
  const f = await fixture(mode);
  await f.db.update(users).set({ email_verified: true }).where(
    inArray(users.id, [f.owner, f.student, f.outsider]),
  );
  const app = createApp();
  const ownerToken = await signToken({ sub: f.owner, role: "user" });
  const studentToken = await signToken({ sub: f.student, role: "user" });
  const room = await http<{ data: { id: string; revision: number } }>(
    app,
    ownerToken,
    `/domains/${f.a.slug}/classrooms`,
    201,
    { method: "POST", body: { name: "提交来源班级" } },
  );
  await http(
    app,
    ownerToken,
    `/domains/${f.a.slug}/classrooms/${room.data.id}/members/${f.student}`,
    200,
    {
      method: "PUT",
      body: { role: "student" },
      headers: { "If-Match": String(room.data.revision) },
    },
  );
  return { ...f, app, ownerToken, studentToken, classroomId: room.data.id };
}

type TeachingFixture = Awaited<ReturnType<typeof setup>>;

async function readOrigin(
  f: TeachingFixture,
  path: string,
  origin: AssignmentSubmissionOrigin | null,
) {
  const response = await http<{ data: Record<string, unknown> }>(
    f.app,
    f.studentToken,
    path,
    200,
  );
  assertEquals(response.data.assignment_origin, origin);
  return response.data;
}

async function task(f: TeachingFixture, bindingId = f.bindingA.id) {
  const draft = await http<{ data: { id: string; revision: number } }>(
    f.app,
    f.ownerToken,
    `/domains/${f.a.slug}/classrooms/${f.classroomId}/assignments`,
    201,
    {
      method: "POST",
      body: {
        title: "提交入口与自动成绩",
        items: [{
          binding_id: bindingId,
          requirement: "min_score",
          minimum_score: 6000,
        }],
      },
    },
  );
  await http(
    f.app,
    f.ownerToken,
    `/domains/${f.a.slug}/assignments/${draft.data.id}/publish`,
    200,
    {
      method: "POST",
      headers: {
        "If-Match": String(draft.data.revision),
        "Idempotency-Key": crypto.randomUUID(),
      },
    },
  );
  const published = await http<{ data: { items: { id: string }[] } }>(
    f.app,
    f.studentToken,
    `/domains/${f.a.slug}/assignments/${draft.data.id}`,
    200,
  );
  return {
    assignment_id: draft.data.id,
    assignment_item_id: published.data.items[0].id,
  };
}

async function cell(f: TeachingFixture, origin: AssignmentSubmissionOrigin) {
  const response = await http<{
    data: {
      updating: boolean;
      cells: {
        score: number | null;
        status: string;
        source_submission_id: string | null;
      }[];
    };
  }>(
    f.app,
    f.studentToken,
    `/domains/${f.a.slug}/assignments/${origin.assignment_id}/progress`,
    200,
  );
  assertEquals(response.data.updating, false);
  assertEquals(response.data.cells.length, 1);
  return response.data.cells[0];
}

function code(f: ExecutionFixture, mode: "code" | "oi" = "code") {
  return {
    problem_ref: f.ref,
    version_id: f.v2,
    language: mode === "oi" ? "cc" : "python3",
    code: mode === "oi" ? "int main() { return 0; }" : "print(1)",
  };
}

for (const mode of ["code", "oi"] as const) {
  Deno.test({
    name:
      `作业来源HTTP：${mode} 正式受理保存来源，自测不计入，一次成绩计入两作业`,
    sanitizeResources: false,
    sanitizeOps: false,
    fn: async () => {
      const f = await setup(mode);
      await withQueue(async () => {
        const first = await task(f), second = await task(f);
        const input = code(f, mode);
        const selfTest = await http<{ data: { id: string } }>(
          f.app,
          f.studentToken,
          `/domains/${f.a.slug}/problems/${f.ref}/self-tests`,
          201,
          {
            method: "POST",
            body: {
              ...input,
              ...first,
              ...(mode === "oi"
                ? {
                  cases: [{ id: "sample", input: "1", expected_output: "1" }],
                }
                : {}),
            },
          },
        );
        const [storedSelf] = await f.db.select().from(selfTests).where(
          eq(selfTests.id, selfTest.data.id),
        );
        assertEquals(storedSelf.assignment_id, first.assignment_id);
        assertEquals(storedSelf.assignment_item_id, first.assignment_item_id);
        await readOrigin(
          f,
          `/domains/${f.a.slug}/self-tests/${selfTest.data.id}`,
          first,
        );
        await saveV2ResultForTest({
          submission_id: selfTest.data.id,
          status: "finished",
          score: 10000,
          output: "自测成功",
          details: {},
        });
        assertEquals((await cell(f, first)).status, "not_started");
        assertEquals((await f.db.select().from(submissions)).length, 0);

        const submitted = await http<{ data: { id: string } }>(
          f.app,
          f.studentToken,
          `/domains/${f.a.slug}/submissions`,
          201,
          { method: "POST", body: { ...input, ...first } },
        );
        const [stored] = await f.db.select().from(submissions).where(
          eq(submissions.id, submitted.data.id),
        );
        assertEquals(stored.assignment_id, first.assignment_id);
        assertEquals(stored.assignment_item_id, first.assignment_item_id);
        assertEquals(stored.domain_id, f.a.id);
        await readOrigin(
          f,
          `/domains/${f.a.slug}/submissions/${submitted.data.id}`,
          first,
        );
        await saveV2ResultForTest({
          submission_id: submitted.data.id,
          status: "finished",
          score: 8000,
          output: "正式成绩",
          details: mode === "oi" ? { oi: { verdict: "WA" } } : {},
        });
        for (const origin of [first, second]) {
          const progress = await cell(f, origin);
          assertEquals(progress.score, 8000);
          assertEquals(progress.status, "achieved");
          assertEquals(progress.source_submission_id, submitted.data.id);
        }
      });
    },
  });
}

Deno.test({
  name:
    "作业来源HTTP：错误域、实际其他作业条目、缺少配对及无接收者均拒绝且无提交",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const f = await setup();
    await withQueue(async () => {
      const first = await task(f), second = await task(f), input = code(f);
      await http(
        f.app,
        f.studentToken,
        `/domains/${f.b.slug}/submissions`,
        404,
        {
          method: "POST",
          body: { ...input, ...first },
        },
      );
      await http(
        f.app,
        f.studentToken,
        `/domains/${f.a.slug}/submissions`,
        404,
        {
          method: "POST",
          body: {
            ...input,
            ...first,
            assignment_item_id: second.assignment_item_id,
          },
        },
      );
      await http(
        f.app,
        f.studentToken,
        `/domains/${f.a.slug}/submissions`,
        400,
        {
          method: "POST",
          body: { ...input, assignment_id: first.assignment_id },
        },
      );
      await http(f.app, f.ownerToken, `/domains/${f.a.slug}/submissions`, 404, {
        method: "POST",
        body: { ...input, ...first },
      });
      await http(
        f.app,
        f.studentToken,
        `/domains/${f.a.slug}/problems/${f.ref}/self-tests`,
        400,
        {
          method: "POST",
          body: { ...input, assignment_item_id: first.assignment_item_id },
        },
      );
      assertEquals((await f.db.select().from(submissions)).length, 0);
      assertEquals((await f.db.select().from(selfTests)).length, 0);
      const plain = await http<{ data: { id: string } }>(
        f.app,
        f.studentToken,
        `/domains/${f.a.slug}/submissions`,
        201,
        { method: "POST", body: input },
      );
      const [stored] = await f.db.select().from(submissions).where(
        eq(submissions.id, plain.data.id),
      );
      assertEquals(stored.assignment_id, null);
      assertEquals(stored.assignment_item_id, null);
      await readOrigin(
        f,
        `/domains/${f.a.slug}/submissions/${plain.data.id}`,
        null,
      );
      await saveV2ResultForTest({
        submission_id: plain.data.id,
        status: "finished",
        score: 9000,
        output: "",
        details: {},
      });
      assertEquals((await cell(f, first)).score, 9000);
      assertEquals((await cell(f, second)).source_submission_id, plain.data.id);
    });
  },
});

Deno.test({
  name:
    "作业来源HTTP：客观题入口保存可信来源，缺少配对拒绝且同域自动计入其他作业",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const f = await setup();
    await withQueue(async () => {
      const created = await http<
        { problem_id: string; number: number; draft_revision: number }
      >(
        f.app,
        f.ownerToken,
        `/domains/${f.source.slug}/problems`,
        201,
        {
          method: "POST",
          body: {
            number: 1002,
            title: "客观题来源",
            description: "选择 A",
            is_objective: true,
            visibility: "public",
          },
        },
      );
      const sourcePath = `/domains/${f.source.slug}/problems/${created.number}`;
      const draft = await http<{ revision: number }>(
        f.app,
        f.ownerToken,
        `${sourcePath}/draft`,
        200,
        {
          method: "PUT",
          headers: { "If-Match": String(created.draft_revision) },
          body: {
            content: {
              kind: "objective",
              title: "客观题来源",
              description: "选择 A",
              samples: [],
              questions: [{
                key: "q1",
                sort_order: 0,
                type: "single",
                prompt: "选择 A",
                options: [{ key: "A", text: "A" }, { key: "B", text: "B" }],
                answer: ["A"],
                explanation: "A 正确",
              }],
            },
          },
        },
      );
      await http<{ version_id: string }>(
        f.app,
        f.ownerToken,
        `${sourcePath}/publish`,
        200,
        {
          method: "POST",
          headers: { "If-Match": String(draft.revision) },
          body: { change_note: "HTTP 来源夹具" },
        },
      );
      const imported = await http<
        {
          data: {
            binding: { id: string };
            reference: { display_ref: string };
            version_id: string;
          };
        }
      >(
        f.app,
        f.ownerToken,
        `/domains/${f.a.slug}/problem-bindings`,
        201,
        {
          method: "POST",
          body: { source_ref: `${f.source.slug}:${created.number}` },
        },
      );
      const first = await task(f, imported.data.binding.id),
        second = await task(f, imported.data.binding.id);
      const path =
        `/domains/${f.a.slug}/problems/${imported.data.reference.display_ref}/objective-submissions`;
      const input = {
        version_id: imported.data.version_id,
        answers: { q1: ["A"] },
      };
      await http(f.app, f.studentToken, path, 400, {
        method: "POST",
        body: { ...input, assignment_id: first.assignment_id },
      });
      assertEquals((await f.db.select().from(objectiveSubmissions)).length, 0);
      const submitted = await http<
        { data: { submission_id: string; score: number } }
      >(
        f.app,
        f.studentToken,
        path,
        201,
        { method: "POST", body: { ...input, ...first } },
      );
      assertEquals(submitted.data.score, 100);
      const [stored] = await f.db.select().from(objectiveSubmissions).where(
        eq(objectiveSubmissions.id, submitted.data.submission_id),
      );
      assertEquals(stored.assignment_id, first.assignment_id);
      assertEquals(stored.assignment_item_id, first.assignment_item_id);
      const historyPath =
        `/domains/${f.a.slug}/objective-submissions/${submitted.data.submission_id}`;
      await readOrigin(f, historyPath, first);
      for (const origin of [first, second]) {
        const progress = await cell(f, origin);
        assertEquals(progress.status, "achieved");
        assertEquals(progress.score, 10000);
        assertEquals(
          progress.source_submission_id,
          submitted.data.submission_id,
        );
      }
      await http(
        f.app,
        f.ownerToken,
        `/domains/${f.a.slug}/problems/${imported.data.reference.display_ref}/state`,
        200,
        {
          method: "POST",
          headers: { "If-Match": "0" },
          body: { disabled: true, reason: "本域独立下架" },
        },
      );
      const withdrawnHistory = await readOrigin(f, historyPath, first);
      assertEquals(withdrawnHistory.resource_available, false);
      await http(
        f.app,
        f.studentToken,
        `/domains/${f.a.slug}/problems/${imported.data.reference.display_ref}`,
        404,
      );
    });
  },
});

function artifactForm(f: ExecutionFixture) {
  const form = new FormData();
  form.append("problem_ref", f.ref);
  form.append("version_id", f.v2);
  // 合法空 ZIP，真实流式解析与存储路径均执行。
  const zip = new Uint8Array([0x50, 0x4b, 0x05, 0x06, ...Array(18).fill(0)]);
  form.append(
    "file",
    new File([zip], "answer.zip", { type: "application/zip" }),
  );
  return form;
}

Deno.test({
  name: "作业来源HTTP：流式产物从query读取配对来源，实际其他条目拒绝且不写记录",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const f = await setup("artifact");
    await withQueue(async () => {
      const first = await task(f), second = await task(f);
      const path = `/api/v1/domains/${f.a.slug}/submissions`;
      const headers = { Authorization: `Bearer ${f.studentToken}` };
      for (
        const [query, status] of [
          [`assignment_id=${first.assignment_id}`, 400],
          [
            new URLSearchParams({
              ...first,
              assignment_item_id: second.assignment_item_id,
            }).toString(),
            404,
          ],
        ] as const
      ) {
        const response = await f.app.fetch(
          new Request(`http://localhost${path}?${query}`, {
            method: "POST",
            headers,
            body: artifactForm(f),
          }),
        );
        assertEquals(
          response.status,
          status,
          JSON.stringify(await response.json()),
        );
        assertEquals((await f.db.select().from(submissions)).length, 0);
      }
      const response = await f.app.fetch(
        new Request(`http://localhost${path}?${new URLSearchParams(first)}`, {
          method: "POST",
          headers,
          body: artifactForm(f),
        }),
      );
      const body = await response.json();
      assertEquals(response.status, 201, JSON.stringify(body));
      const [stored] = await f.db.select().from(submissions).where(
        eq(submissions.id, body.data.id),
      );
      assertEquals(stored.assignment_id, first.assignment_id);
      assertEquals(stored.assignment_item_id, first.assignment_item_id);
      assertEquals(stored.domain_id, f.a.id);
      assert(stored.artifact_storage_url?.startsWith("noj-storage://"));
      await readOrigin(
        f,
        `/domains/${f.a.slug}/submissions/${body.data.id}`,
        first,
      );
    });
  },
});

Deno.test({
  name: "作业来源HTTP：比赛与作业上下文可共存，OI成绩仍隐藏且学情不泄露",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const f = await setup("oi");
    await withQueue(async () => {
      const origin = await task(f),
        contestId = crypto.randomUUID(),
        now = Date.now();
      await f.db.insert(contests).values({
        id: contestId,
        domain_id: f.a.id,
        type: "oi",
        kind: "invite",
        title: "作业入口 OI 比赛",
        created_by: f.owner,
        start_time: new Date(now - 60_000).toISOString(),
        end_time: new Date(now + 3_600_000).toISOString(),
        created_at: new Date(now).toISOString(),
        updated_at: new Date(now).toISOString(),
      });
      await f.db.insert(contestProblems).values({
        contest_id: contestId,
        domain_id: f.a.id,
        domain_problem_binding_id: f.bindingA.id,
        problem_id: f.problemId,
        label: "A",
        score: 10000,
        pinned_version_id: f.v1,
      });
      await f.db.insert(contestParticipants).values({
        contest_id: contestId,
        user_id: f.student,
        registered_at: new Date(now).toISOString(),
      });
      const submitted = await http<{ data: { id: string } }>(
        f.app,
        f.studentToken,
        `/domains/${f.a.slug}/contests/${contestId}/problems/A/submissions`,
        201,
        {
          method: "POST",
          body: {
            ...code(f, "oi"),
            problem_ref: "A",
            version_id: f.v1,
            ...origin,
          },
        },
      );
      const [stored] = await f.db.select().from(submissions).where(
        eq(submissions.id, submitted.data.id),
      );
      assertEquals(stored.assignment_id, origin.assignment_id);
      assertEquals(stored.assignment_item_id, origin.assignment_item_id);
      assertEquals(stored.contest_id, contestId);
      await saveV2ResultForTest({
        submission_id: submitted.data.id,
        status: "finished",
        score: 10000,
        output: "PRIVATE_EVALUATOR_OUTPUT",
        details: { oi: { verdict: "AC" } },
      });
      const read = await http<{ data: Record<string, unknown> }>(
        f.app,
        f.studentToken,
        `/domains/${f.a.slug}/submissions/${submitted.data.id}`,
        200,
      );
      assertEquals(read.data.result_visibility, "hidden");
      assertEquals(read.data.status, "submitted");
      assertEquals(read.data.assignment_origin, origin);
      for (
        const key of [
          "result",
          "score",
          "is_accepted",
          "is_valid",
          "details",
          "output",
          "attempts",
          "version_results",
          "progress",
        ]
      ) {
        assertEquals(key in read.data, false, `OI 赛中泄露 ${key}`);
      }
      assert(!JSON.stringify(read).includes("PRIVATE_EVALUATOR_OUTPUT"));
      const progress = await cell(f, origin);
      assertEquals(progress.status, "not_started");
      assertEquals(progress.score, null);
      assertEquals(progress.source_submission_id, null);
    });
  },
});
