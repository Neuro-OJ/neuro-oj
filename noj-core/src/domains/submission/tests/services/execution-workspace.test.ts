import { assertEquals, assertIsError, assertRejects } from "jsr:@std/assert@^1";
import { eq } from "drizzle-orm";
import { getDb, resetDbForTest } from "../../../../shared/db/connection.ts";
import {
  domainMemberRoles,
  domainProblemBindings,
  domains,
  objectiveSubmissions,
  submissionJobItems,
  submissionJobs,
  submissions,
  users,
} from "../../../../shared/db/schema.ts";
import {
  createProblem,
  publishProblemVersion,
  saveProblemDraft,
} from "../../../catalog/index.ts";
import {
  addDomainMember,
  createDomain,
  DEFAULT_DOMAIN_ID,
  ensureDefaultWorkspace,
} from "../../../workspace/index.ts";
import { updateSetting } from "../../../system/index.ts";
import { submitObjectivePaper } from "../../../objective/index.ts";
import { backfillExecutionWorkspaces } from "../../index.ts";
import { AppError } from "../../../../shared/base/errors.ts";

async function fixture() {
  await resetDbForTest();
  const db = getDb(),
    user = crypto.randomUUID(),
    now = new Date().toISOString();
  await db.insert(users).values({
    id: user,
    username: user,
    email: `${user}@example.com`,
    created_at: now,
    updated_at: now,
  });
  await ensureDefaultWorkspace();
  const member = await addDomainMember(db, DEFAULT_DOMAIN_ID, user);
  await db.insert(domainMemberRoles).values({
    membership_id: member.id,
    role: "editor",
  });
  const first = await createProblem(
    {
      title: "历史套卷",
      description: "卷面",
      is_objective: true,
      visibility: "public",
    },
    user,
    "user",
  );
  const [binding] = await db.select().from(domainProblemBindings).where(
    eq(domainProblemBindings.problem_id, first.id),
  );
  await updateSetting("domain_creation_policy", "open", "0");
  const other = await createDomain({
    slug: "execution-school",
    name: "学校",
    preset: "education",
  }, user);
  return { db, user, now, first, binding, other };
}

Deno.test("执行归属：源题相同也不能将其他域绑定写入默认域提交", async () => {
  const f = await fixture();
  const shared = crypto.randomUUID();
  await f.db.insert(domainProblemBindings).values({
    id: shared,
    domain_id: f.other.id,
    problem_id: f.first.id,
    kind: "shared",
    created_by: f.user,
    created_at: f.now,
    updated_at: f.now,
  });
  const error = await assertRejects(() =>
    f.db.transaction((tx) =>
      tx.insert(submissions).values({
        id: crypto.randomUUID(),
        domain_id: DEFAULT_DOMAIN_ID,
        domain_problem_binding_id: shared,
        user_id: f.user,
        problem_id: f.first.id,
        language: "python3",
        code: "original",
        created_at: f.now,
      })
    )
  );
  assertIsError(error);
  assertEquals((error.cause as { code: string }).code, "23503");
});

Deno.test("执行归属：任务幂等键包含域，条目不能放入另一域任务", async () => {
  const f = await fixture();
  const jobs = [crypto.randomUUID(), crypto.randomUUID()];
  await f.db.insert(submissionJobs).values(
    jobs.map((id, index) => ({
      id,
      domain_id: index ? f.other.id : DEFAULT_DOMAIN_ID,
      kind: "upgrade" as const,
      actor_id: f.user,
      idempotency_key: "same-key",
      request_hash: "same-hash",
      created_at: f.now,
    })),
  );
  assertEquals((await f.db.select().from(submissionJobs)).length, 2);
  const error = await assertRejects(() =>
    f.db.transaction((tx) =>
      tx.insert(submissionJobItems).values({
        id: crypto.randomUUID(),
        job_id: jobs[0],
        domain_id: f.other.id,
        ordinal: 0,
        source_kind: "submission",
        source_id: "historical",
        problem_id: f.first.id,
        created_at: f.now,
      })
    )
  );
  assertIsError(error);
  assertEquals((error.cause as { code: string }).code, "23503");
});

Deno.test("执行回填：保留 ID、代码、受理时间及未知版本，重复回填幂等", async () => {
  const f = await fixture(), id = crypto.randomUUID();
  await f.db.insert(submissions).values({
    id,
    user_id: f.user,
    problem_id: f.first.id,
    language: "python3",
    code: "immutable-code",
    created_at: f.now,
  });
  await backfillExecutionWorkspaces();
  await backfillExecutionWorkspaces();
  const [row] = await f.db.select().from(submissions).where(
    eq(submissions.id, id),
  );
  assertEquals([
    row.id,
    row.code,
    row.created_at,
    row.version_origin,
    row.submitted_version_id,
  ], [id, "immutable-code", f.now, "legacy_unknown", null]);
  assertEquals(row.domain_id, DEFAULT_DOMAIN_ID);
  assertEquals(row.domain_problem_binding_id, f.binding.id);
});

Deno.test("执行回填：无合法源题的 failed/skipped 条目保留原始引用和空绑定", async () => {
  const f = await fixture(), jobId = crypto.randomUUID();
  await f.db.insert(submissionJobs).values({
    id: jobId,
    actor_id: f.user,
    kind: "rejudge",
    idempotency_key: "terminal-history",
    request_hash: "history",
    status: "completed_with_errors",
    created_at: f.now,
  });
  await f.db.insert(submissionJobItems).values(
    ["failed", "skipped"].map((status, ordinal) => ({
      id: crypto.randomUUID(),
      job_id: jobId,
      ordinal,
      source_kind: "submission" as const,
      source_id: `deleted-source-${ordinal}`,
      problem_id: ordinal ? "" : "deleted-problem-reference",
      target_version_ref: "deleted-version-reference",
      status: status as "failed" | "skipped",
      created_at: f.now,
    })),
  );
  await backfillExecutionWorkspaces();
  const summaries = await backfillExecutionWorkspaces();
  assertEquals(summaries.find((row) => row.kind === "items")?.incomplete, 0);
  const items = await f.db.select().from(submissionJobItems).where(
    eq(submissionJobItems.job_id, jobId),
  ).orderBy(submissionJobItems.ordinal);
  assertEquals(
    items.map((item) => [
      item.domain_id,
      item.domain_problem_binding_id,
      item.problem_id,
      item.status,
      item.target_version_ref,
    ]),
    [
      [
        DEFAULT_DOMAIN_ID,
        null,
        "deleted-problem-reference",
        "failed",
        "deleted-version-reference",
      ],
      [DEFAULT_DOMAIN_ID, null, "", "skipped", "deleted-version-reference"],
    ],
  );
});

Deno.test("执行回填：空题目引用不能让无绑定 pending 条目通过核对，事务回滚", async () => {
  const f = await fixture(), jobId = crypto.randomUUID();
  await f.db.insert(submissionJobs).values({
    id: jobId,
    actor_id: f.user,
    kind: "rejudge",
    idempotency_key: "pending-history",
    request_hash: "history",
    created_at: f.now,
  });
  await f.db.insert(submissionJobItems).values({
    id: crypto.randomUUID(),
    job_id: jobId,
    ordinal: 0,
    source_kind: "submission",
    source_id: "deleted-source",
    problem_id: "",
    status: "pending",
    created_at: f.now,
  });
  const error = await assertRejects(
    () => backfillExecutionWorkspaces(),
    AppError,
  );
  assertEquals(error.code, "EXECUTION_BACKFILL_INCOMPLETE");
  const [job] = await f.db.select().from(submissionJobs).where(
    eq(submissionJobs.id, jobId),
  );
  assertEquals(job.domain_id, null);
});

Deno.test("执行写入：客观题使用服务端默认域，忽略客户端伪造归属", async () => {
  const f = await fixture();
  await saveProblemDraft(f.first.id, {
    actorId: f.user,
    expectedRevision: 1,
    content: {
      kind: "objective",
      title: "套卷",
      description: "题面",
      samples: [],
      questions: [{
        key: "sum",
        sort_order: 0,
        type: "single",
        prompt: "1+1=?",
        options: [{ key: "A", text: "2" }, { key: "B", text: "3" }],
        answer: ["A"],
        explanation: "加法",
      }],
    },
  });
  const published = await publishProblemVersion(f.first.id, {
    expectedRevision: 2,
    actorId: f.user,
  });
  const input = {
    answers: { sum: ["A"] },
    version_id: published.version_id,
    domain_id: f.other.id,
    domain_problem_binding_id: "forged",
  };
  const submitted = await submitObjectivePaper(f.first.id, input, f.user);
  const [row] = await f.db.select().from(objectiveSubmissions).where(
    eq(objectiveSubmissions.id, submitted.submission_id),
  );
  assertEquals(row.domain_id, DEFAULT_DOMAIN_ID);
  assertEquals(row.domain_problem_binding_id, f.binding.id);
  assertEquals(row.score, 10000);
  assertEquals((await f.db.select({ id: domains.id }).from(domains)).length, 2);
});
