import { assertEquals, assertRejects } from "jsr:@std/assert@^1";
import { eq } from "drizzle-orm";
import {
  AppError,
  ForbiddenError,
  NotFoundError,
} from "../../../../shared/base/errors.ts";
import { getDb, resetDbForTest } from "../../../../shared/db/connection.ts";
import {
  contestParticipants,
  contestProblems,
  contests,
  domainProblemBindings,
  evaluationAttempts,
  problems,
  problemVersions,
  submissions,
  users,
} from "../../../../shared/db/schema.ts";
import {
  getRedis,
  resetRedisForTest,
} from "../../../../shared/mq/connection.ts";
import {
  importDomainProblem,
  readDomainProblem,
  setDomainProblemBindingPolicy,
  setDomainProblemSharing,
} from "../../../catalog/index.ts";
import {
  consumeDomainInvitation,
  createDomain,
  createDomainInvitation,
  removeDomainMember,
  setDomainStatus,
} from "../../../workspace/index.ts";
import { updateSetting } from "../../../system/index.ts";
import {
  createDomainSubmission,
  getSubmission,
  getSubmissionQueueStatus,
  listSubmissions,
} from "../../index.ts";
import {
  lockDomainExecution,
  resolveDomainExecution,
} from "../../services/workspace-execution.ts";
import { startFakeRedis } from "../_fake-redis.ts";
import { saveV2ResultForTest } from "../_versioning-fixtures.ts";

async function account() {
  const id = crypto.randomUUID(), now = new Date().toISOString();
  await getDb().insert(users).values({
    id,
    username: id,
    email: `${id}@example.com`,
    created_at: now,
    updated_at: now,
  });
  return id;
}

async function fixture() {
  await resetDbForTest();
  const owner = await account(),
    student = await account(),
    outsider = await account();
  await updateSetting("domain_creation_policy", "open", "0");
  const source = await createDomain({
    slug: "submit-public",
    name: "公共源题",
    preset: "community",
  }, owner);
  const a = await createDomain({
    slug: "submit-school-a",
    name: "学校 A",
    preset: "education",
  }, owner);
  const b = await createDomain({
    slug: "submit-school-b",
    name: "学校 B",
    preset: "education",
  }, owner);
  for (const school of [a, b]) {
    const invitation = await createDomainInvitation(
      school.slug,
      owner,
      `${student}@example.com`,
    );
    await consumeDomainInvitation(invitation.token, student);
  }
  const now = new Date().toISOString(), problemId = crypto.randomUUID();
  await getDb().insert(problems).values({
    id: problemId,
    domain_id: source.id,
    number: 1001,
    type: "P",
    title: "共享题",
    description: "题面",
    owner_id: owner,
    visibility: "public",
    created_at: now,
    updated_at: now,
  });
  const v1 = crypto.randomUUID(), v2 = crypto.randomUUID();
  const runtime = {
    evaluator: {
      image: "noj-evaluator-python",
      command: "python3 evaluate.py",
      time_limit_ms: 5000,
      memory_limit_mb: 512,
    },
    solution: {
      image: "noj-solution-python",
      call_timeout_ms: 2000,
      memory_limit_mb: 512,
    },
  };
  for (const [index, id] of [v1, v2].entries()) {
    await getDb().insert(problemVersions).values({
      id,
      problem_id: problemId,
      version: index + 1,
      content: {
        kind: "ai",
        title: "共享题",
        description: "题面",
        samples: [],
        submission_mode: "code",
        runtime_config: runtime,
        template_content: "",
        artifact_max_size_mb: null,
        llm_config: null,
      },
      published_at: now,
    });
  }
  await getDb().update(problems).set({ latest_version_id: v2 }).where(
    eq(problems.id, problemId),
  );
  await getDb().insert(domainProblemBindings).values({
    id: crypto.randomUUID(),
    domain_id: source.id,
    problem_id: problemId,
    kind: "owned",
    visibility: "public",
    created_by: owner,
    created_at: now,
    updated_at: now,
  });
  await setDomainProblemSharing(source.slug, "1001", owner, {
    expectedRevision: 0,
    enabled: true,
    scope: "all",
    targetDomainIds: [],
  });
  const ref = `${source.slug}:1001`;
  const { binding: bindingA } = await importDomainProblem(a.slug, ref, owner);
  const { binding: bindingB } = await importDomainProblem(b.slug, ref, owner);
  return {
    db: getDb(),
    owner,
    student,
    outsider,
    source,
    a,
    b,
    problemId,
    v1,
    v2,
    ref,
    bindingA,
    bindingB,
    runtime,
  };
}

async function withQueue(fn: () => Promise<void>) {
  const previous = Deno.env.get("REDIS_URL"), fake = await startFakeRedis();
  resetRedisForTest();
  Deno.env.set("REDIS_URL", fake.url);
  const redis = getRedis();
  try {
    await redis.connect();
    await fn();
  } finally {
    redis.disconnect();
    resetRedisForTest();
    if (previous) Deno.env.set("REDIS_URL", previous);
    else Deno.env.delete("REDIS_URL");
    await fake.stop();
  }
}

const input = (version: string) => ({
  version_id: version,
  language: "python3",
  code: "print(1)",
});

Deno.test({
  name: "域提交：同一源题使用两份域策略，评测与旧入口不串域",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const f = await fixture();
    await setDomainProblemBindingPolicy(
      f.b.slug,
      f.ref,
      f.owner,
      f.bindingB.revision,
      { mode: "exact", version_id: f.v1 },
      "学校 B 使用第一版",
    );
    await withQueue(async () => {
      const a = await createDomainSubmission(
        f.a.slug,
        f.ref,
        f.student,
        input(f.v2),
      );
      const b = await createDomainSubmission(
        f.b.slug,
        f.ref,
        f.student,
        input(f.v1),
      );
      assertEquals(a.domain_id, f.a.id);
      assertEquals(b.domain_id, f.b.id);
      assertEquals(a.reference.display_ref, f.ref);
      const [storedA] = await f.db.select().from(submissions).where(
        eq(submissions.id, a.id),
      );
      const [storedB] = await f.db.select().from(submissions).where(
        eq(submissions.id, b.id),
      );
      assertEquals(storedA.domain_problem_binding_id, f.bindingA.id);
      assertEquals(storedB.domain_problem_binding_id, f.bindingB.id);
      assertEquals(storedA.submitted_version_id, f.v2);
      assertEquals(storedB.submitted_version_id, f.v1);
      assertEquals(storedA.receipt_sequence < storedB.receipt_sequence, true);
      const [attempt] = await f.db.select().from(evaluationAttempts).where(
        eq(evaluationAttempts.submission_id, a.id),
      );
      assertEquals(attempt.problem_version_id, f.v2);
      await saveV2ResultForTest({
        submission_id: a.id,
        status: "finished",
        score: 8000,
        output: "",
        details: {},
      });
      await saveV2ResultForTest({
        submission_id: b.id,
        status: "finished",
        score: 6000,
        output: "",
        details: {},
      });
      const [gradedA] = await f.db.select().from(submissions).where(
        eq(submissions.id, a.id),
      );
      const [gradedB] = await f.db.select().from(submissions).where(
        eq(submissions.id, b.id),
      );
      assertEquals(gradedA.is_valid, true);
      assertEquals(gradedB.is_valid, true);
      const [scoreA] = await f.db.select({ score: evaluationAttempts.score })
        .from(evaluationAttempts)
        .where(eq(evaluationAttempts.id, gradedA.effective_attempt_id!));
      const [scoreB] = await f.db.select({ score: evaluationAttempts.score })
        .from(evaluationAttempts)
        .where(eq(evaluationAttempts.id, gradedB.effective_attempt_id!));
      assertEquals(scoreA.score, 8000);
      assertEquals(scoreB.score, 6000);
      assertEquals(
        (await listSubmissions({ userId: f.student, page: 1, perPage: 20 }))
          .total,
        0,
      );
      await assertRejects(
        () => getSubmission(a.id, f.student, "admin"),
        NotFoundError,
      );
      assertEquals(
        await getSubmissionQueueStatus(a.id, f.student, "admin"),
        null,
      );
    });
  },
});

Deno.test({
  name: "域提交：错误域、成员撤权、归档和版本冲突在创建前拒绝",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const f = await fixture();
    await assertRejects(
      () => createDomainSubmission(f.a.slug, f.ref, f.outsider, input(f.v2)),
      NotFoundError,
    );
    await assertRejects(
      () => createDomainSubmission(f.a.slug, "1001", f.student, input(f.v2)),
      NotFoundError,
    );
    const mismatch = await assertRejects(
      () => createDomainSubmission(f.a.slug, f.ref, f.student, input(f.v1)),
      AppError,
    );
    assertEquals(mismatch.code, "PROBLEM_ANSWER_VERSION_CHANGED");
    await removeDomainMember(f.a.slug, f.owner, f.student);
    await assertRejects(
      () => createDomainSubmission(f.a.slug, f.ref, f.student, input(f.v2)),
      NotFoundError,
    );
    await setDomainStatus(f.b.slug, f.owner, "archived", f.b.revision);
    await assertRejects(
      () => createDomainSubmission(f.b.slug, f.ref, f.student, input(f.v2)),
      ForbiddenError,
    );
    assertEquals((await f.db.select().from(submissions)).length, 0);
  },
});

Deno.test({
  name: "域提交：外部准备后共享撤销或策略变化，事务复查阻止写入",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const f = await fixture(), request = { slug: f.a.slug, reference: f.ref };
    const initial = await resolveDomainExecution(request, f.student, f.v2);
    await setDomainProblemBindingPolicy(
      f.a.slug,
      f.ref,
      f.owner,
      f.bindingA.revision,
      { mode: "exact", version_id: f.v1 },
      "改用第一版",
    );
    const changed = await assertRejects(
      () =>
        f.db.transaction((tx) =>
          lockDomainExecution(initial, request, f.student, f.v2, tx)
        ),
      AppError,
    );
    assertEquals(changed.code, "PROBLEM_ANSWER_VERSION_CHANGED");
    await setDomainProblemSharing(f.source.slug, "1001", f.owner, {
      expectedRevision: 1,
      enabled: false,
      scope: "all",
      targetDomainIds: [],
    });
    await assertRejects(
      () =>
        f.db.transaction((tx) =>
          lockDomainExecution(initial, request, f.student, f.v2, tx)
        ),
      NotFoundError,
    );
  },
});

Deno.test({
  name: "域提交：学校比赛只阻止本域选手练习，不扩大到公共源域或其他学校",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const f = await fixture(), id = crypto.randomUUID(), now = Date.now();
    await f.db.insert(contests).values({
      id,
      domain_id: f.a.id,
      title: "学校赛",
      description: "",
      type: "oi",
      kind: "public",
      created_by: f.owner,
      start_time: new Date(now - 60000).toISOString(),
      end_time: new Date(now + 60000).toISOString(),
      created_at: new Date(now).toISOString(),
      updated_at: new Date(now).toISOString(),
    });
    await f.db.insert(contestProblems).values({
      contest_id: id,
      problem_id: f.problemId,
      pinned_version_id: f.v2,
      sort_order: 0,
      label: "A",
      score: 10000,
    });
    await f.db.insert(contestParticipants).values({
      contest_id: id,
      user_id: f.student,
      registered_at: new Date(now).toISOString(),
    });
    assertEquals(
      (await readDomainProblem(f.source.slug, "1001", f.outsider)).version_id,
      f.v2,
    );
    assertEquals(
      (await readDomainProblem(f.b.slug, f.ref, f.student)).version_id,
      f.v2,
    );
    const blocked = await assertRejects(
      () => createDomainSubmission(f.a.slug, f.ref, f.student, input(f.v2)),
      ForbiddenError,
    );
    assertEquals(blocked.code, "CONTEST_PRACTICE_BLOCKED");
    assertEquals(
      (await resolveDomainExecution(
        { slug: f.b.slug, reference: f.ref },
        f.student,
        f.v2,
      )).domain.id,
      f.b.id,
    );
    // 测试外层事务固定数据库 now()；结束窗口明确早于事务开始。
    await f.db.update(contests).set({
      start_time: new Date(now - 180000).toISOString(),
      end_time: new Date(now - 120000).toISOString(),
    }).where(eq(contests.id, id));
    assertEquals(
      (await resolveDomainExecution(
        { slug: f.a.slug, reference: f.ref },
        f.student,
        f.v2,
      )).domain.id,
      f.a.id,
    );
  },
});

Deno.test({
  name: "域提交：学校 LLM 未配置时不回退公共 Provider",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const f = await fixture(), version = crypto.randomUUID();
    await f.db.insert(problemVersions).values({
      id: version,
      problem_id: f.problemId,
      version: 3,
      content: {
        kind: "ai",
        title: "LLM",
        description: "",
        samples: [],
        submission_mode: "code",
        runtime_config: f.runtime,
        template_content: "",
        artifact_max_size_mb: null,
        llm_config: { max_calls: 5, max_tokens: 500 },
      },
      published_at: new Date().toISOString(),
    });
    await f.db.update(problems).set({ latest_version_id: version }).where(
      eq(problems.id, f.problemId),
    );
    const error = await assertRejects(
      () => createDomainSubmission(f.a.slug, f.ref, f.student, input(version)),
      AppError,
    );
    assertEquals(error.code, "DOMAIN_LLM_NOT_CONFIGURED");
    assertEquals((await f.db.select().from(submissions)).length, 0);
  },
});
