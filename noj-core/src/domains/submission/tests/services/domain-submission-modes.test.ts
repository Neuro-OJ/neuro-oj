import { assertEquals, assertRejects } from "jsr:@std/assert@^1";
import { eq } from "drizzle-orm";
import {
  AppError,
  ForbiddenError,
  NotFoundError,
} from "../../../../shared/base/errors.ts";
import {
  contestParticipants,
  contestProblems,
  contests,
  domainProblemBindings,
  evaluationAttempts,
  objectiveSubmissions,
  problems,
  problemVersions,
  selfTests,
  submissions,
} from "../../../../shared/db/schema.ts";
import {
  importDomainProblem,
  setDomainProblemSharing,
} from "../../../catalog/index.ts";
import {
  getObjectiveSubmission,
  listObjectiveSubmissions,
  submitDomainObjectivePaper,
} from "../../../objective/index.ts";
import {
  createDomainArtifactSubmission,
  createDomainSelfTest,
  createDomainSubmission,
} from "../../index.ts";
import { fixture, withQueue } from "../_domain-execution-fixture.ts";

function zipStream() {
  // 合法的空 ZIP：终止记录及四个零计数；上传仍经过原流式存储路径。
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(
        new Uint8Array([0x50, 0x4b, 0x05, 0x06, ...Array(18).fill(0)]),
      );
      controller.close();
    },
  });
}

Deno.test({
  name: "域产物：流式上传归学校绑定，未授权及撤销不产生提交",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const f = await fixture("artifact");
    await assertRejects(
      () =>
        createDomainArtifactSubmission(f.a.slug, f.ref, f.outsider, {
          version_id: f.v2,
          file_name: "answer.zip",
          file_stream: zipStream(),
        }),
      NotFoundError,
    );
    await withQueue(async () => {
      const created = await createDomainArtifactSubmission(
        f.a.slug,
        f.ref,
        f.student,
        { version_id: f.v2, file_name: "answer.zip", file_stream: zipStream() },
      );
      const [stored] = await f.db.select().from(submissions).where(
        eq(submissions.id, created.id),
      );
      assertEquals(stored.domain_id, f.a.id);
      assertEquals(stored.domain_problem_binding_id, f.bindingA.id);
      assertEquals(stored.submitted_version_id, f.v2);
      assertEquals(
        stored.artifact_storage_url?.startsWith("noj-storage://"),
        true,
      );
      const [attempt] = await f.db.select().from(evaluationAttempts).where(
        eq(evaluationAttempts.submission_id, created.id),
      );
      assertEquals(
        (attempt.task_snapshot as Record<string, unknown>).submission_mode,
        "artifact",
      );
    });
    await setDomainProblemSharing(f.source.slug, "1001", f.owner, {
      expectedRevision: 1,
      enabled: false,
      scope: "all",
      targetDomainIds: [],
    });
    await assertRejects(
      () =>
        createDomainArtifactSubmission(f.a.slug, f.ref, f.student, {
          version_id: f.v2,
          file_name: "answer.zip",
          file_stream: zipStream(),
        }),
      NotFoundError,
    );
    assertEquals((await f.db.select().from(submissions)).length, 1);
  },
});

Deno.test({
  name: "域自测：独立域与版本记录，不产生正式提交或评测尝试",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const f = await fixture();
    await withQueue(async () => {
      const created = await createDomainSelfTest(f.a.slug, f.ref, f.student, {
        version_id: f.v2,
        language: "python3",
        code: "print(1)",
      });
      const [stored] = await f.db.select().from(selfTests).where(
        eq(selfTests.id, created.id),
      );
      assertEquals(stored.domain_id, f.a.id);
      assertEquals(stored.domain_problem_binding_id, f.bindingA.id);
      assertEquals(stored.problem_version_id, f.v2);
      assertEquals(typeof stored.judge_run_id, "string");
      assertEquals((await f.db.select().from(submissions)).length, 0);
      assertEquals((await f.db.select().from(evaluationAttempts)).length, 0);
    });
  },
});

Deno.test({
  name: "域 OI 提交：复用原编译评测封套，保留使用域绑定",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const f = await fixture("oi");
    await withQueue(async () => {
      const created = await createDomainSubmission(f.a.slug, f.ref, f.student, {
        version_id: f.v2,
        language: "cc",
        code: "int main() { return 0; }",
      });
      const [stored] = await f.db.select().from(submissions).where(
        eq(submissions.id, created.id),
      );
      const [attempt] = await f.db.select().from(evaluationAttempts).where(
        eq(evaluationAttempts.submission_id, created.id),
      );
      assertEquals(stored.domain_id, f.a.id);
      assertEquals(stored.domain_problem_binding_id, f.bindingA.id);
      assertEquals(
        (attempt.task_snapshot as Record<string, unknown>).judge_type,
        "oi",
      );
      const wrong = await assertRejects(
        () =>
          createDomainSubmission(f.a.slug, f.ref, f.student, {
            version_id: f.v2,
            language: "python3",
            code: "print(1)",
          }),
        AppError,
      );
      assertEquals(wrong.code, "LANGUAGE_NOT_SUPPORTED");
    });
  },
});

async function objectiveFixture() {
  const f = await fixture(),
    paper = crypto.randomUUID(),
    version = crypto.randomUUID(),
    now = new Date().toISOString();
  await f.db.insert(problems).values({
    id: paper,
    domain_id: f.source.id,
    number: 1002,
    type: "P",
    title: "客观题",
    description: "",
    is_objective: true,
    visibility: "public",
    owner_id: f.owner,
    created_at: now,
    updated_at: now,
  });
  await f.db.insert(problemVersions).values({
    id: version,
    problem_id: paper,
    version: 1,
    content: {
      kind: "objective",
      title: "客观题",
      description: "",
      samples: [],
      questions: [{
        key: "q1",
        type: "single",
        sort_order: 0,
        prompt: "选择 A",
        options: [{ key: "A", text: "A" }, { key: "B", text: "B" }],
        answer: ["A"],
        explanation: "解析",
      }],
    },
    published_at: now,
  });
  await f.db.update(problems).set({ latest_version_id: version }).where(
    eq(problems.id, paper),
  );
  await f.db.insert(domainProblemBindings).values({
    id: crypto.randomUUID(),
    domain_id: f.source.id,
    problem_id: paper,
    kind: "owned",
    visibility: "public",
    created_by: f.owner,
    created_at: now,
    updated_at: now,
  });
  await setDomainProblemSharing(f.source.slug, "1002", f.owner, {
    expectedRevision: 0,
    enabled: true,
    scope: "all",
    targetDomainIds: [],
  });
  const ref = `${f.source.slug}:1002`;
  const { binding } = await importDomainProblem(f.a.slug, ref, f.owner);
  return { ...f, paper, version, objectiveRef: ref, objectiveBinding: binding };
}

Deno.test({
  name: "域客观题：交卷、即时判定与有效成绩同事务归学校，旧列表与最高分排除",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const f = await objectiveFixture();
    const created = await submitDomainObjectivePaper(
      f.a.slug,
      f.objectiveRef,
      f.student,
      { version_id: f.version, answers: { q1: ["A"] } },
    );
    assertEquals(created.contest_mode, false);
    if (!created.contest_mode) assertEquals(created.score_db, 10000);
    const [stored] = await f.db.select().from(objectiveSubmissions).where(
      eq(objectiveSubmissions.id, created.submission_id),
    );
    assertEquals(stored.domain_id, f.a.id);
    assertEquals(stored.domain_problem_binding_id, f.objectiveBinding.id);
    assertEquals(stored.submitted_version_id, f.version);
    assertEquals(stored.is_valid, true);
    assertEquals(stored.is_accepted, true);
    await assertRejects(
      () => getObjectiveSubmission(created.submission_id, f.student, "admin"),
      NotFoundError,
    );
    const listed = await listObjectiveSubmissions({
      viewerId: f.student,
      paperId: f.paper,
      page: 1,
      perPage: 20,
    });
    assertEquals(listed.total, 0);
    assertEquals(listed.best_score, null);
    await setDomainProblemSharing(f.source.slug, "1002", f.owner, {
      expectedRevision: 1,
      enabled: false,
      scope: "all",
      targetDomainIds: [],
    });
    await assertRejects(
      () =>
        submitDomainObjectivePaper(f.a.slug, f.objectiveRef, f.student, {
          version_id: f.version,
          answers: { q1: ["A"] },
        }),
      NotFoundError,
    );
    assertEquals((await f.db.select().from(objectiveSubmissions)).length, 1);
  },
});

Deno.test({
  name: "域练习旁路：同域参赛学生的产物、自测和客观题均被拒绝",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const f = await objectiveFixture(),
      id = crypto.randomUUID(),
      now = Date.now();
    await f.db.insert(contests).values({
      id,
      domain_id: f.a.id,
      title: "学校赛",
      type: "oi",
      kind: "invite",
      created_by: f.owner,
      start_time: new Date(now - 60000).toISOString(),
      end_time: new Date(now + 60000).toISOString(),
      created_at: new Date(now).toISOString(),
      updated_at: new Date(now).toISOString(),
    });
    await f.db.insert(contestProblems).values([{
      contest_id: id,
      problem_id: f.problemId,
      pinned_version_id: f.v2,
      label: "A",
      score: 10000,
    }, {
      contest_id: id,
      problem_id: f.paper,
      pinned_version_id: f.version,
      label: "B",
      score: 10000,
      sort_order: 1,
    }]);
    await f.db.insert(contestParticipants).values({
      contest_id: id,
      user_id: f.student,
      registered_at: new Date(now).toISOString(),
    });
    for (
      const attempt of [
        () =>
          createDomainSelfTest(f.a.slug, f.ref, f.student, {
            version_id: f.v2,
            language: "python3",
            code: "print(1)",
          }),
        () =>
          createDomainArtifactSubmission(f.a.slug, f.ref, f.student, {
            version_id: f.v2,
            file_name: "answer.zip",
            file_stream: zipStream(),
          }),
        () =>
          submitDomainObjectivePaper(f.a.slug, f.objectiveRef, f.student, {
            version_id: f.version,
            answers: { q1: ["A"] },
          }),
      ]
    ) {
      const rejected = await assertRejects(attempt, ForbiddenError);
      assertEquals(rejected.code, "CONTEST_PRACTICE_BLOCKED");
    }
    assertEquals((await f.db.select().from(submissions)).length, 0);
    assertEquals((await f.db.select().from(selfTests)).length, 0);
    assertEquals((await f.db.select().from(objectiveSubmissions)).length, 0);
  },
});
