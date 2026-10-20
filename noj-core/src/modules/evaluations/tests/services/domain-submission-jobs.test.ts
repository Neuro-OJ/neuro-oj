import { assertEquals, assertRejects } from "jsr:@std/assert@^1";
import { eq } from "drizzle-orm";
import {
  AppError,
  ConflictError,
  NotFoundError,
} from "../../../../shared/base/errors.ts";
import { getDb } from "../../../../shared/db/connection.ts";
import {
  contestParticipants,
  contestProblems,
  contests,
  domainProblemBindings,
  problems,
  problemVersions,
  submissionJobs,
  submissions,
} from "../../../../shared/db/schema.ts";
import {
  setDomainProblemBindingPolicy,
  setDomainProblemSharing,
} from "../../../problems/index.ts";
import {
  DEFAULT_DOMAIN_ID,
  removeDomainMember,
  setMemberRoles,
} from "../../../../domains/workspace/index.ts";
import {
  acceptDomainSubmissionJob,
  cancelDomainSubmissionJob,
  getDomainSubmission,
  getDomainSubmissionJob,
  listDomainSubmissionJobItems,
  listDomainSubmissions,
} from "../../index.ts";
import { runSubmissionJobWorkerOnce } from "../../services/versioning/dispatch-job-item.ts";
import { fixture, withQueue } from "../_domain-execution-fixture.ts";
import { authorizeLegacyJobActorForTest } from "../_versioning-fixtures.ts";
import { acceptRejudgeJob } from "../../services/versioning/rejudge-jobs.ts";

async function source(
  f: Awaited<ReturnType<typeof fixture>>,
  school: "a" | "b" = "a",
  version = f.v1,
) {
  const id = crypto.randomUUID();
  await getDb().insert(submissions).values({
    id,
    public_id: `sub_${crypto.randomUUID()}`,
    domain_id: f[school].id,
    domain_problem_binding_id: school === "a" ? f.bindingA.id : f.bindingB.id,
    user_id: f.student,
    problem_id: f.problemId,
    language: "python3",
    code: "original",
    submitted_version_id: version,
    version_origin: "known",
    status: "finished",
    created_at: new Date().toISOString(),
  });
  return id;
}
const upgrade = (id: string) => ({
  kind: "upgrade" as const,
  submissions: [{ kind: "submission" as const, id }],
  context: "practice" as const,
});

Deno.test({
  name:
    "旧main批任务: 不带domain_slug也必须复查当前域角色，撤权与离域禁止新尝试",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const f = await fixture(), now = new Date().toISOString();
    await authorizeLegacyJobActorForTest(f.student);
    await setMemberRoles("main", "0", f.student, ["admin"]);
    const problem = "legacy-domain-guard-problem",
      version = "legacy-domain-guard-version",
      binding = "legacy-domain-guard-binding",
      submission = "legacy-domain-guard-submission";
    await f.db.insert(problems).values({
      id: problem,
      domain_id: DEFAULT_DOMAIN_ID,
      number: 42001,
      title: "main题",
      description: "",
      visibility: "public",
      owner_id: f.student,
      runtime_config: f.runtime,
      created_at: now,
      updated_at: now,
    });
    await f.db.insert(problemVersions).values({
      id: version,
      problem_id: problem,
      version: 1,
      published_at: now,
      content: {
        kind: "ai",
        title: "main题",
        description: "",
        samples: [],
        submission_mode: "code",
        runtime_config: f.runtime,
        template_content: "",
        artifact_max_size_mb: null,
        llm_config: null,
      },
    });
    await f.db.update(problems).set({ latest_version_id: version }).where(
      eq(problems.id, problem),
    );
    await f.db.insert(domainProblemBindings).values({
      id: binding,
      domain_id: DEFAULT_DOMAIN_ID,
      problem_id: problem,
      kind: "owned",
      visibility: "public",
      created_by: f.student,
      created_at: now,
      updated_at: now,
    });
    await f.db.insert(submissions).values({
      id: submission,
      domain_id: DEFAULT_DOMAIN_ID,
      domain_problem_binding_id: binding,
      user_id: f.student,
      problem_id: problem,
      language: "python3",
      code: "old",
      status: "finished",
      submitted_version_id: version,
      version_origin: "known",
      created_at: now,
    });
    const request = {
      kind: "rejudge" as const,
      scope: {
        type: "selected" as const,
        submissions: [{ kind: "submission" as const, id: submission }],
      },
      target: { mode: "latest" as const },
    };
    const first = await acceptRejudgeJob(
      f.student,
      request,
      "before-role-revoke",
    );
    const [stored] = await f.db.select().from(submissionJobs).where(
      eq(submissionJobs.id, first.job_id),
    );
    assertEquals(
      (stored.request as { domain_slug?: string }).domain_slug,
      undefined,
    );
    await setMemberRoles("main", "0", f.student, ["member"]);
    assertEquals(
      (await runSubmissionJobWorkerOnce("legacy-role-revoked", { limit: 1 }))
        .failed,
      1,
    );
    const rejected = await listDomainSubmissionJobItems(
      "main",
      f.student,
      first.job_id,
      { page: 1, perPage: 20 },
    );
    assertEquals(rejected.data[0].reason_code, "DOMAIN_PERMISSION_DENIED");
    assertEquals(rejected.data[0].attempt_id, null);
    await setMemberRoles("main", "0", f.student, ["admin"]);
    const second = await acceptRejudgeJob(
      f.student,
      request,
      "before-membership-revoke",
    );
    await removeDomainMember("main", "0", f.student);
    assertEquals(
      (await runSubmissionJobWorkerOnce("legacy-member-revoked", { limit: 1 }))
        .failed,
      1,
    );
    const cancelled = await listDomainSubmissionJobItems(
      "main",
      "0",
      second.job_id,
      { page: 1, perPage: 20 },
    );
    assertEquals(cancelled.data[0].attempt_id, null);
    const [original] = await f.db.select().from(submissions).where(
      eq(submissions.id, submission),
    );
    assertEquals(original.active_attempt_id, null);
    assertEquals(original.status, "finished");
  },
});

Deno.test({
  name:
    "域批任务: 同键按域隔离、错误域ID拒绝，升级使用本域当前作答版本并保留原提交",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const f = await fixture(), a = await source(f), b = await source(f, "b");
    const key = "same-workspace-operation";
    const first = await acceptDomainSubmissionJob(
      f.a.slug,
      f.student,
      upgrade(a),
      key,
    );
    assertEquals(
      (await acceptDomainSubmissionJob(f.a.slug, f.student, upgrade(a), key))
        .job_id,
      first.job_id,
    );
    const other = await acceptDomainSubmissionJob(
      f.b.slug,
      f.student,
      upgrade(b),
      key,
    );
    assertEquals(other.job_id === first.job_id, false);
    await assertRejects(
      () => getDomainSubmissionJob(f.b.slug, f.student, first.job_id),
      NotFoundError,
    );
    await assertRejects(
      () =>
        acceptDomainSubmissionJob(f.a.slug, f.student, upgrade(b), "foreign"),
      NotFoundError,
    );
    await setDomainProblemBindingPolicy(f.b.slug, f.ref, f.owner, 0, {
      mode: "exact",
      version_id: f.v1,
    }, "本域固定旧版");
    assertEquals(
      (await getDomainSubmission(f.b.slug, b, f.student)).is_latest,
      true,
    );
    assertEquals(
      (await listDomainSubmissions(f.b.slug, f.student, {
        page: 1,
        perPage: 20,
        upgradable: true,
      })).total,
      0,
    );
    const latestSource = await source(f, "b", f.v2);
    const fixed = await acceptDomainSubmissionJob(
      f.b.slug,
      f.student,
      upgrade(latestSource),
      "fixed-default",
    );
    const items = await listDomainSubmissionJobItems(
      f.b.slug,
      f.student,
      fixed.job_id,
      { page: 1, perPage: 20 },
    );
    assertEquals(items.data[0].target_version_id, f.v1);
    await cancelDomainSubmissionJob(f.b.slug, f.student, other.job_id);
    await cancelDomainSubmissionJob(f.b.slug, f.student, fixed.job_id);
    await withQueue(async () => {
      const outcome = await runSubmissionJobWorkerOnce("domain-upgrade", {
        limit: 1,
      });
      assertEquals(outcome.dispatched, 1);
    });
    const [original] = await f.db.select().from(submissions).where(
      eq(submissions.id, a),
    );
    const copies = await f.db.select().from(submissions).where(
      eq(submissions.upgraded_from_id, a),
    );
    assertEquals(original.submitted_version_id, f.v1);
    assertEquals(original.code, "original");
    assertEquals(copies.length, 1);
    assertEquals(copies[0].domain_id, f.a.id);
    assertEquals(copies[0].domain_problem_binding_id, f.bindingA.id);
    assertEquals(copies[0].submitted_version_id, f.v2);
    const completed = await listDomainSubmissionJobItems(
      f.a.slug,
      f.student,
      first.job_id,
      { page: 1, perPage: 20 },
    );
    assertEquals(completed.data[0].result_submission_id, copies[0].id);
    assertEquals(completed.data[0].domain_id, f.a.id);
    assertEquals(completed.data[0].domain_problem_binding_id, f.bindingA.id);
  },
});

Deno.test({
  name: "域原比赛升级: 普通参赛者不能受理，组织者权限撤销后不能首次执行",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const f = await fixture(),
      id = await source(f),
      now = new Date().toISOString(),
      contest = "domain-organizer-upgrade";
    await f.db.insert(contests).values({
      id: contest,
      domain_id: f.a.id,
      title: "组织升级",
      type: "kaggle",
      kind: "public",
      is_public: true,
      created_by: f.owner,
      start_time: new Date(Date.now() - 10000).toISOString(),
      end_time: new Date(Date.now() + 3600000).toISOString(),
      created_at: now,
      updated_at: now,
    });
    await f.db.insert(contestProblems).values({
      contest_id: contest,
      problem_id: f.problemId,
      domain_id: f.a.id,
      domain_problem_binding_id: f.bindingA.id,
      pinned_version_id: f.v2,
      label: "A",
      sort_order: 0,
      score: 10000,
    });
    await f.db.insert(contestParticipants).values({
      contest_id: contest,
      user_id: f.student,
      registered_at: now,
    });
    await f.db.update(submissions).set({ contest_id: contest }).where(
      eq(submissions.id, id),
    );
    const request = { ...upgrade(id), context: "source_contest" as const };
    const denied = await assertRejects(
      () =>
        acceptDomainSubmissionJob(
          f.a.slug,
          f.student,
          request,
          "contest-participant",
        ),
      AppError,
    );
    assertEquals(denied.statusCode, 403);
    await setMemberRoles(f.a.slug, f.owner, f.student, ["editor"]);
    await f.db.update(contests).set({ created_by: f.student }).where(
      eq(contests.id, contest),
    );
    const job = await acceptDomainSubmissionJob(
      f.a.slug,
      f.student,
      request,
      "contest-organizer",
    );
    await setMemberRoles(f.a.slug, f.owner, f.student, ["member"]);
    assertEquals(
      (await runSubmissionJobWorkerOnce("former-organizer", { limit: 1 }))
        .failed,
      1,
    );
    const items = await listDomainSubmissionJobItems(
      f.a.slug,
      f.student,
      job.job_id,
      { page: 1, perPage: 20 },
    );
    assertEquals(items.data[0].attempt_id, null);
    assertEquals(items.data[0].result_submission_id, null);
    assertEquals((await f.db.select().from(submissions)).length, 1);
  },
});

Deno.test({
  name: "域批任务: 共享撤销、原用户离域与取消都阻止新尝试，不改写原成绩",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const f = await fixture(), id = await source(f);
    const upgradeJob = await acceptDomainSubmissionJob(
      f.a.slug,
      f.student,
      upgrade(id),
      "student-upgrade",
    );
    const rejudgeJob = await acceptDomainSubmissionJob(f.a.slug, f.owner, {
      kind: "rejudge",
      scope: { type: "selected", submissions: [{ kind: "submission", id }] },
      target: { mode: "latest" },
    }, "teacher-rejudge");
    await removeDomainMember(f.a.slug, f.owner, f.student);
    const revoked = await runSubmissionJobWorkerOnce("revoked-upgrade", {
      limit: 1,
    });
    assertEquals(revoked.failed, 1);
    assertEquals(
      (await getDomainSubmissionJob(f.a.slug, f.owner, upgradeJob.job_id))
        .counts?.failed,
      1,
    );
    await setDomainProblemSharing(f.source.slug, "1001", f.owner, {
      expectedRevision: 1,
      enabled: false,
      scope: "all",
      targetDomainIds: [],
    });
    const unavailable = await runSubmissionJobWorkerOnce("withdrawn-source", {
      limit: 1,
    });
    assertEquals(unavailable.failed, 1);
    const rows = await listDomainSubmissionJobItems(
      f.a.slug,
      f.owner,
      rejudgeJob.job_id,
      { page: 1, perPage: 20 },
    );
    assertEquals(rows.data[0].reason_code, "RESOURCE_UNAVAILABLE");
    assertEquals(rows.data[0].attempt_id, null);
    await setDomainProblemSharing(f.source.slug, "1001", f.owner, {
      expectedRevision: 2,
      enabled: true,
      scope: "all",
      targetDomainIds: [],
    });
    const cancelled = await acceptDomainSubmissionJob(f.a.slug, f.owner, {
      kind: "rejudge",
      scope: { type: "problem", problem_id: f.problemId },
      target: { mode: "latest" },
    }, "cancel");
    assertEquals(
      (await cancelDomainSubmissionJob(f.a.slug, f.owner, cancelled.job_id))
        .cancel_requested,
      true,
    );
    assertEquals(
      (await runSubmissionJobWorkerOnce("cancelled", { limit: 10 })).claimed,
      0,
    );
    const [original] = await f.db.select().from(submissions).where(
      eq(submissions.id, id),
    );
    assertEquals(original.active_attempt_id, null);
    assertEquals(original.status, "finished");
  },
});

Deno.test({
  name:
    "域批任务: 重测策略变更与任务原子受理，revision冲突不产生任务，学生无权重测",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const f = await fixture(), id = await source(f);
    const request = {
      kind: "rejudge" as const,
      scope: {
        type: "selected" as const,
        submissions: [{ kind: "submission" as const, id }],
      },
      target: { mode: "submitted" as const },
      policy_changes: [{
        problem_id: f.problemId,
        policy: { mode: "exact" as const, version_id: f.v1 },
        expected_revision: 999,
        reason: "固定版本",
      }],
    };
    await assertRejects(
      () =>
        acceptDomainSubmissionJob(f.a.slug, f.student, request, "forbidden"),
      AppError,
    );
    await assertRejects(
      () => acceptDomainSubmissionJob(f.a.slug, f.owner, request, "conflict"),
      ConflictError,
    );
    assertEquals((await f.db.select().from(submissionJobs)).length, 0);
    request.policy_changes[0].expected_revision = 0;
    const created = await acceptDomainSubmissionJob(
      f.a.slug,
      f.owner,
      request,
      "change-policy",
    );
    const [binding] = await f.db.select().from(domainProblemBindings).where(
      eq(domainProblemBindings.id, f.bindingA.id),
    );
    assertEquals(binding.effective_version_mode, "exact");
    assertEquals(binding.required_version_id, f.v1);
    assertEquals(binding.revision, 1);
    assertEquals(
      (await getDomainSubmissionJob(f.a.slug, f.owner, created.job_id))
        .total_items,
      1,
    );
  },
});
