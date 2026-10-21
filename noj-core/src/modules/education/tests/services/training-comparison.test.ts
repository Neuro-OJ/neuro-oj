import { assert, assertEquals, assertRejects } from "jsr:@std/assert@^1";
import { eq } from "drizzle-orm";
import {
  BadRequestError,
  ForbiddenError,
  NotFoundError,
} from "../../../../shared/base/errors.ts";
import {
  auditLogs,
  contestParticipants,
  contestProblems,
  contests,
  domainProblemBindings,
  domains,
  evaluationAttempts,
  objectiveSubmissions,
  problems,
  problemVersions,
  submissions,
  submissionVersionResults,
  userRoles,
} from "../../../../shared/db/schema.ts";
import {
  importDomainProblem,
  setDomainProblemBindingPolicy,
  setDomainProblemSharing,
} from "../../../problems/index.ts";
import { createAssignment, publishAssignment } from "../../index.ts";
import { setClassroomMember } from "../../index.ts";
import { createApp } from "../../../../app.ts";
import { signToken, verifyToken } from "../../../access/identity/index.ts";
import {
  createUserToken,
  initRedisForTest,
  jsonRequest,
} from "../../../../../tests/helper.ts";
import { getTrainingComparison } from "../../services/training-comparison.ts";
import { assignmentFixture } from "../_assignment-fixture.ts";

const windows = {
  before_start: "2026-10-01T00:00:00.000Z",
  before_end: "2026-10-02T00:00:00.000Z",
  after_start: "2026-10-02T00:00:00.000Z",
  after_end: "2026-10-03T00:00:00.000Z",
};

async function fixture(objective = false) {
  const f = await assignmentFixture();
  if (objective) {
    const now = new Date().toISOString();
    f.problemId = crypto.randomUUID();
    f.versionId = crypto.randomUUID();
    f.bindingId = crypto.randomUUID();
    await f.db.insert(problems).values({
      id: f.problemId,
      number: 1002,
      domain_id: f.school.id,
      owner_id: f.owner,
      is_objective: true,
      title: "客观训练",
      description: "题面",
      created_at: now,
      updated_at: now,
    });
    await f.db.insert(problemVersions).values({
      id: f.versionId,
      problem_id: f.problemId,
      version: 1,
      published_at: now,
      content: {
        kind: "objective",
        title: "客观训练",
        description: "题面",
        samples: [],
        questions: Array.from({ length: 10 }, (_, index) => ({
          key: `truth${index}`,
          type: "judge",
          prompt: "正确？",
          options: [{ key: "true", text: "正确" }, {
            key: "false",
            text: "错误",
          }],
          answer: [true],
          explanation: "答案",
          sort_order: index,
        })),
      },
    });
    await f.db.update(problems).set({ latest_version_id: f.versionId }).where(
      eq(problems.id, f.problemId),
    );
    await f.db.insert(domainProblemBindings).values({
      id: f.bindingId,
      domain_id: f.school.id,
      problem_id: f.problemId,
      kind: "owned",
      visibility: "members",
      created_by: f.owner,
      created_at: now,
      updated_at: now,
    });
  }
  const task = await createAssignment(
    f.school.slug,
    f.classroom.id,
    f.teacher,
    {
      title: "通过训练",
      items: [{ binding_id: f.bindingId, requirement: "accepted" }],
    },
  );
  await publishAssignment(
    f.school.slug,
    task.id,
    f.teacher,
    0,
    "comparison-publish",
  );
  return { ...f, task };
}

async function grade(
  f: Awaited<ReturnType<typeof fixture>>,
  input: {
    at: string;
    score: number;
    accepted?: boolean;
    domainId?: string;
    bindingId?: string;
    contestId?: string;
    objective?: boolean;
    pending?: boolean;
  },
) {
  const id = crypto.randomUUID(),
    attempt = crypto.randomUUID(),
    now = new Date().toISOString();
  const source = {
    id,
    domain_id: input.domainId ?? f.school.id,
    domain_problem_binding_id: input.bindingId ?? f.bindingId,
    user_id: f.student,
    submitted_version_id: f.versionId,
    created_at: input.at,
    status: input.pending ? "pending" as const : "finished" as const,
    contest_id: input.contestId,
  };
  if (input.objective) {
    await f.db.insert(objectiveSubmissions).values({
      ...source,
      paper_id: f.problemId,
      answers: Object.fromEntries(
        Array.from(
          { length: 10 },
          (_, index) => [`truth${index}`, [index < 8]],
        ),
      ),
      submission_type: "practice",
      version_origin: "known",
    });
  } else {await f.db.insert(submissions).values({
      ...source,
      problem_id: f.problemId,
      language: "python3",
      code: "private code excluded",
      version_origin: "known",
    });}
  await f.db.insert(evaluationAttempts).values({
    id: attempt,
    ...(input.objective
      ? { objective_submission_id: id }
      : { submission_id: id }),
    problem_id: f.problemId,
    problem_version_id: f.versionId,
    sequence: 0,
    source: "initial",
    state: input.pending ? "queued" : "finished",
    result_kind: input.pending ? null : "graded",
    score: input.pending ? null : input.score,
    accepted: input.accepted ?? false,
    created_at: now,
  });
  if (input.pending) {
    await f.db.update(submissions).set({ active_attempt_id: attempt }).where(
      eq(submissions.id, id),
    );
  } else {await f.db.insert(submissionVersionResults).values({
      id: crypto.randomUUID(),
      ...(input.objective
        ? { objective_submission_id: id }
        : { submission_id: id }),
      problem_id: f.problemId,
      problem_version_id: f.versionId,
      current_attempt_id: attempt,
      updated_at: now,
    });}
  return { id, attempt };
}

Deno.test("训练比较：明确半开窗、同域候选和权威通过，缺失成绩不当零分，无代码正文", async () => {
  const f = await fixture();
  const before = await grade(f, {
    at: "2026-10-01T12:00:00.000Z",
    score: 10000,
    accepted: false,
  });
  await grade(f, { at: windows.before_end, score: 2000 });
  const after = await grade(f, {
    at: "2026-10-02T12:00:00.000Z",
    score: 7000,
    accepted: true,
  });
  await grade(f, { at: windows.after_end, score: 10000, accepted: true });
  await grade(f, { at: "2026-10-02T18:00:00.000Z", score: 0, pending: true });
  const result = await getTrainingComparison(
    f.school.slug,
    f.task.id,
    f.student,
    f.teacher,
    windows,
  );
  const item = result.items[0];
  assertEquals(result.interval, "[start,end)");
  assertEquals(item.before.submitted_count, 1);
  assertEquals(item.before.candidate_count, 1);
  assertEquals(item.before.score, 10000);
  assertEquals(item.before.accepted, false);
  assertEquals(item.before.achieved, false);
  assertEquals(item.after.submitted_count, 3);
  assertEquals(item.after.candidate_count, 2);
  assertEquals(item.after.pending_count, 1);
  assertEquals(item.after.score, 7000);
  assertEquals(item.after.accepted, true);
  assertEquals(item.before.best?.submission_id, before.id);
  assertEquals(item.after.passed?.attempt_id, after.attempt);
  assertEquals(item.score_change, -3000);
  assertEquals(result.before.accepted_items, 0);
  assertEquals(result.after.accepted_items, 1);
  assert(!JSON.stringify(result).includes("private code"));
  await assertRejects(
    () =>
      getTrainingComparison(
        f.other.slug,
        f.task.id,
        f.student,
        f.teacher,
        windows,
      ),
    NotFoundError,
  );
  await assertRejects(
    () =>
      getTrainingComparison(
        f.school.slug,
        f.task.id,
        f.student,
        f.assistant,
        windows,
      ),
    NotFoundError,
  );
  await assertRejects(
    () =>
      getTrainingComparison(
        f.school.slug,
        f.task.id,
        f.teacher,
        f.student,
        windows,
      ),
    ForbiddenError,
  );
  assertEquals(
    (await getTrainingComparison(
      f.school.slug,
      f.task.id,
      f.student,
      f.student,
      windows,
    )).after.accepted_items,
    1,
  );
  await setClassroomMember(
    f.school.slug,
    f.classroom.id,
    f.teacher,
    f.assistant,
    1,
    { role: "assistant", capabilities: ["progress:read"] },
  );
  assertEquals(
    (await getTrainingComparison(
      f.school.slug,
      f.task.id,
      f.student,
      f.assistant,
      windows,
    )).after.accepted_items,
    1,
  );
  await initRedisForTest();
  const token = await signToken({ sub: f.teacher, role: "user" });
  const app = createApp();
  const path =
    `/api/v1/domains/${f.school.slug}/assignments/${f.task.id}/students/${f.student}/training-comparison`;
  const response = await jsonRequest(
    app,
    `${path}?${new URLSearchParams(windows)}`,
    { token },
  );
  assertEquals(response.status, 200, await response.clone().text());
  assertEquals(response.headers.get("Cache-Control"), "no-store");
  assertEquals((await response.json()).data.items[0].after.score, 7000);
  assertEquals((await jsonRequest(app, path, { token })).status, 400);
  assertEquals(
    (await jsonRequest(
      app,
      `${path.replace(f.school.slug, f.other.slug)}?${new URLSearchParams(
        windows,
      )}`,
      { token },
    )).status,
    404,
  );
  const admin = await verifyToken(await createUserToken("admin"));
  assertEquals(
    (await getTrainingComparison(
      f.school.slug,
      f.task.id,
      f.student,
      admin.sub,
      windows,
    )).after.accepted_items,
    1,
  );
  const [audit] = await f.db.select().from(auditLogs).where(
    eq(auditLogs.admin_id, admin.sub),
  );
  assertEquals(
    (audit.detail as { operation: string }).operation,
    "training.comparison.read",
  );
  assertEquals((audit.detail as { student_id: string }).student_id, f.student);
  await f.db.delete(userRoles).where(eq(userRoles.user_id, admin.sub));
  await assertRejects(
    () =>
      getTrainingComparison(
        f.school.slug,
        f.task.id,
        f.student,
        admin.sub,
        windows,
      ),
    NotFoundError,
  );
});

Deno.test("训练比较：相同源题跨域记录和未结束比赛排除，策略变化使用当前版本结果并说明依据", async () => {
  const f = await fixture();
  await f.db.update(domains).set({
    configuration: { ...f.school.configuration, access: "public" },
  }).where(eq(domains.id, f.school.id));
  await f.db.update(domainProblemBindings).set({ visibility: "public" }).where(
    eq(domainProblemBindings.id, f.bindingId),
  );
  await setDomainProblemSharing(f.school.slug, "1001", f.owner, {
    enabled: true,
    scope: "all",
    targetDomainIds: [],
    expectedRevision: 0,
  });
  const imported = await importDomainProblem(
    f.other.slug,
    `${f.school.slug}:1001`,
    f.owner,
  );
  await grade(f, { at: "2026-10-01T12:00:00.000Z", score: 1000 });
  await grade(f, { at: "2026-10-02T12:00:00.000Z", score: 6000 });
  await grade(f, {
    at: "2026-10-02T14:00:00.000Z",
    score: 10000,
    accepted: true,
    domainId: f.other.id,
    bindingId: imported.binding.id,
  });
  const contestId = crypto.randomUUID(), now = new Date().toISOString();
  await f.db.insert(contests).values({
    id: contestId,
    domain_id: f.school.id,
    title: "进行中练习赛",
    type: "kaggle",
    kind: "invite",
    created_by: f.owner,
    start_time: windows.before_start,
    end_time: new Date(Date.now() + 60000).toISOString(),
    created_at: now,
    updated_at: now,
  });
  await f.db.insert(contestProblems).values({
    contest_id: contestId,
    domain_id: f.school.id,
    domain_problem_binding_id: f.bindingId,
    problem_id: f.problemId,
    label: "A",
    score: 10000,
    pinned_version_id: f.versionId,
  });
  await f.db.insert(contestParticipants).values({
    contest_id: contestId,
    user_id: f.student,
    registered_at: now,
  });
  await grade(f, {
    at: "2026-10-02T15:00:00.000Z",
    score: 10000,
    accepted: true,
    contestId,
  });
  let result = await getTrainingComparison(
    f.school.slug,
    f.task.id,
    f.student,
    f.teacher,
    windows,
  );
  assertEquals(result.items[0].after.score, 6000);
  assertEquals(result.items[0].after.submitted_count, 1);
  const version2 = crypto.randomUUID();
  await f.db.insert(problemVersions).values({
    id: version2,
    problem_id: f.problemId,
    version: 2,
    content: { kind: "ai", title: "教学题v2", description: "新版本" },
    published_at: now,
  });
  await setDomainProblemBindingPolicy(f.school.slug, "1001", f.owner, 0, {
    mode: "exact",
    version_id: version2,
  }, "比较当前策略");
  result = await getTrainingComparison(
    f.school.slug,
    f.task.id,
    f.student,
    f.teacher,
    windows,
  );
  assertEquals(result.items[0].policy.mode, "exact");
  assertEquals(result.items[0].policy.revision, 1);
  assertEquals(result.items[0].policy.answer_version_id, version2);
  assertEquals(result.items[0].before.score, null);
  assertEquals(result.items[0].after.score, null);
  assertEquals(result.items[0].after.version_mismatch_count, 1);
  assertEquals(result.items[0].score_change, null);
});

Deno.test("训练比较：客观题正式结果使用相同分值口径，错误时间窗不进入查询", async () => {
  const f = await fixture(true);
  await grade(f, {
    at: "2026-10-02T12:00:00.000Z",
    score: 8000,
    accepted: false,
    objective: true,
  });
  const result = await getTrainingComparison(
    f.school.slug,
    f.task.id,
    f.student,
    f.teacher,
    windows,
  );
  assertEquals(result.items[0].after.best?.source_kind, "objective");
  assertEquals(result.items[0].after.score, 8000);
  assertEquals(result.items[0].after.accepted, false);
  assertEquals(result.items[0].before.score, null);
  await assertRejects(
    () =>
      getTrainingComparison(f.school.slug, f.task.id, f.student, f.teacher, {
        ...windows,
        after_start: windows.before_start,
      }),
    BadRequestError,
  );
  await assertRejects(
    () =>
      getTrainingComparison(f.school.slug, f.task.id, f.student, f.teacher, {
        ...windows,
        before_start: "2026-10-01T00:00:00",
      }),
    BadRequestError,
  );
});
