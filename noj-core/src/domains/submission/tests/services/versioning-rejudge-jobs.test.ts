/**
 * 批任务受理测试（Handbook §4.3、§2.10、§5.7）。
 *
 * 覆盖：三种范围、三种目标版本模式、受理时固定集合与去重、500 条上限、
 * 幂等键（同请求返回原任务 / 不同请求 409）、空集合直接完成、
 * 「整场统一 V3 缺一题 → 整次受理 400 且不产生任务」、策略变更作用域校验与生效、
 * 重试只带 failed/skipped、任务状态由条目聚合。
 */
import { assertEquals, assertRejects } from "jsr:@std/assert@^1";
import { and, eq } from "drizzle-orm";
import { getDb } from "../../../../shared/db/connection.ts";
import {
  objectiveSubmissions,
  problems,
  problemVersions,
  submissionJobItems,
  submissionJobs,
  submissions,
  users,
} from "../../../../shared/db/schema.ts";
import {
  acceptRejudgeJob,
  getRejudgeJob,
  listRejudgeJobItems,
  refreshJobStatus,
  type RejudgeRequest,
  retryRejudgeJob,
} from "../../services/versioning/rejudge-jobs.ts";

const now = new Date().toISOString();

// 任务表对 actor_id 有外键：先建两个管理员账号（模块级、事务外，供全文件使用）
for (
  const [id, name] of [["admin-1", "rj-admin-1"], ["admin-2", "rj-admin-2"]]
) {
  await getDb().insert(users).values({
    id,
    username: name,
    email: `${name}@test.noj`,
    password_hash: "hash",
    created_at: now,
    updated_at: now,
  });
}

async function seedProblem(
  problemId: string,
  number: number,
  versions = [1, 2],
) {
  const db = getDb();
  await db.insert(problems).values({
    id: problemId,
    title: problemId,
    description: "d",
    type: "P",
    number,
    owner_id: "0",
    difficulty: "easy",
    judge_type: "dual",
    created_at: now,
    updated_at: now,
  });
  for (const version of versions) {
    await db.insert(problemVersions).values({
      id: `${problemId}-v${version}`,
      problem_id: problemId,
      version,
      origin: "published",
      content: { kind: "ai", title: problemId },
      published_at: now,
    });
  }
  await db.update(problems).set({
    latest_version_id: `${problemId}-v${versions[versions.length - 1]}`,
  }).where(eq(problems.id, problemId));
}

async function seedSubmission(
  id: string,
  problemId: string,
  options: { versionId?: string | null; contestId?: string | null } = {},
): Promise<void> {
  await getDb().insert(submissions).values({
    id,
    user_id: "0",
    problem_id: problemId,
    contest_id: options.contestId ?? null,
    language: "python",
    code: "x",
    submitted_version_id: options.versionId === undefined
      ? `${problemId}-v1`
      : options.versionId,
    version_origin: options.versionId === null ? "legacy_unknown" : "known",
    created_at: now,
  });
}

function request(overrides: Partial<RejudgeRequest> = {}): RejudgeRequest {
  return {
    kind: "rejudge",
    scope: { type: "selected", submissions: [] },
    target: { mode: "submitted" },
    ...overrides,
  };
}

Deno.test("jobs: selected 范围去重并固定提交集合", async () => {
  await seedProblem("rj-p1", 993001);
  await seedSubmission("rj-s1", "rj-p1");
  await seedSubmission("rj-s2", "rj-p1");

  const result = await acceptRejudgeJob(
    "admin-1",
    request({
      scope: {
        type: "selected",
        submissions: [
          { kind: "submission", id: "rj-s1" },
          { kind: "submission", id: "rj-s1" },
          { kind: "submission", id: "rj-s2" },
        ],
      },
    }),
    "key-1",
  );
  assertEquals(result.total_items, 2);
  assertEquals(result.status, "queued");

  // 受理后新增的提交不进入本批任务
  await seedSubmission("rj-s3", "rj-p1");
  const items = await listRejudgeJobItems(result.job_id);
  assertEquals(items.total, 2);
  assertEquals(items.data.map((item) => item.source_id), ["rj-s1", "rj-s2"]);
  assertEquals(items.data[0].target_version_id, "rj-p1-v1");
});

Deno.test("jobs: 未知提交时版本的条目 skipped（LEGACY_VERSION_UNKNOWN）", async () => {
  await seedProblem("rj-p2", 993002);
  await seedSubmission("rj-legacy", "rj-p2", { versionId: null });
  const result = await acceptRejudgeJob(
    "admin-1",
    request({
      scope: {
        type: "selected",
        submissions: [{ kind: "submission", id: "rj-legacy" }],
      },
    }),
    "key-2",
  );
  const items = await listRejudgeJobItems(result.job_id);
  assertEquals(items.data[0].status, "skipped");
  assertEquals(items.data[0].reason_code, "LEGACY_VERSION_UNKNOWN");
  // 全部条目已终态 → 任务完成（不因 skipped 而失败）
  assertEquals(await refreshJobStatus(result.job_id), "completed");
});

Deno.test("jobs: latest 目标在受理时解析并固定", async () => {
  await seedProblem("rj-p3", 993003);
  await seedSubmission("rj-s-latest", "rj-p3", { versionId: "rj-p3-v1" });
  const accepted = await acceptRejudgeJob(
    "admin-1",
    request({
      scope: {
        type: "selected",
        submissions: [{ kind: "submission", id: "rj-s-latest" }],
      },
      target: { mode: "latest" },
    }),
    "key-3",
  );
  let items = await listRejudgeJobItems(accepted.job_id);
  assertEquals(items.data[0].target_version_id, "rj-p3-v2");

  // 受理后发布 V3：任务目标版本不变
  await getDb().insert(problemVersions).values({
    id: "rj-p3-v3",
    problem_id: "rj-p3",
    version: 3,
    origin: "published",
    content: { kind: "ai", title: "rj-p3" },
    published_at: now,
  });
  await getDb().update(problems).set({ latest_version_id: "rj-p3-v3" }).where(
    eq(problems.id, "rj-p3"),
  );
  items = await listRejudgeJobItems(accepted.job_id);
  assertEquals(items.data[0].target_version_id, "rj-p3-v2");
});

Deno.test("jobs: specified 缺任一题版本 → 整次受理 400 且不产生任务", async () => {
  const db = getDb();
  await seedProblem("rj-p4", 993004);
  await seedProblem("rj-p5", 993005);
  await seedSubmission("rj-s4", "rj-p4");
  await seedSubmission("rj-s5", "rj-p5");

  await assertRejects(
    () =>
      acceptRejudgeJob(
        "admin-1",
        request({
          scope: {
            type: "selected",
            submissions: [
              { kind: "submission", id: "rj-s4" },
              { kind: "submission", id: "rj-s5" },
            ],
          },
          // 只给了 rj-p4 的版本：整次受理失败
          target: { mode: "specified", versions: { "rj-p4": "rj-p4-v2" } },
        }),
        "key-4",
      ),
    Error,
    "指定的目标版本缺失",
  );

  // 不产生任务
  const jobs = await db.select().from(submissionJobs).where(
    eq(submissionJobs.idempotency_key, "key-4"),
  );
  assertEquals(jobs.length, 0);
});

Deno.test("jobs: 幂等键语义（同请求复用 / 不同请求 409）", async () => {
  await seedProblem("rj-p6", 993006);
  await seedSubmission("rj-s6", "rj-p6");
  const first = await acceptRejudgeJob(
    "admin-1",
    request({
      scope: {
        type: "selected",
        submissions: [{ kind: "submission", id: "rj-s6" }],
      },
    }),
    "key-5",
  );
  assertEquals(first.existing, false);

  const repeat = await acceptRejudgeJob(
    "admin-1",
    request({
      scope: {
        type: "selected",
        submissions: [{ kind: "submission", id: "rj-s6" }],
      },
    }),
    "key-5",
  );
  assertEquals(repeat.existing, true);
  assertEquals(repeat.job_id, first.job_id);

  await assertRejects(
    () =>
      acceptRejudgeJob(
        "admin-1",
        request({
          scope: {
            type: "selected",
            submissions: [{ kind: "submission", id: "rj-s6" }],
          },
          target: { mode: "latest" },
        }),
        "key-5",
      ),
    Error,
    "已用于不同的请求",
  );

  // 不同 actor 可用同一 idempotency key
  const otherActor = await acceptRejudgeJob(
    "admin-2",
    request({
      scope: {
        type: "selected",
        submissions: [{ kind: "submission", id: "rj-s6" }],
      },
    }),
    "key-5",
  );
  assertEquals(otherActor.existing, false);
});

Deno.test("jobs: 空集合直接返回已完成任务", async () => {
  await seedProblem("rj-p7", 993007);
  const result = await acceptRejudgeJob(
    "admin-1",
    request({ scope: { type: "problem", problem_id: "rj-p7" } }),
    "key-6",
  );
  assertEquals(result.total_items, 0);
  assertEquals(result.status, "completed");
  const job = await getRejudgeJob(result.job_id);
  assertEquals(job?.status, "completed");
  assertEquals(job?.total_items, 0);
});

Deno.test("jobs: problem 范围覆盖两类提交", async () => {
  await seedProblem("rj-p8", 993008);
  await seedSubmission("rj-s8", "rj-p8");
  await getDb().update(problems).set({ is_objective: true }).where(
    eq(problems.id, "rj-p8"),
  );
  await getDb().insert(objectiveSubmissions).values({
    id: "rj-o8",
    paper_id: "rj-p8",
    user_id: "0",
    submission_type: "practice",
    answers: {},
    status: "finished",
    score: 0,
    details: {},
    submitted_version_id: "rj-p8-v1",
    version_origin: "known",
    created_at: now,
  });
  const result = await acceptRejudgeJob(
    "admin-1",
    request({ scope: { type: "problem", problem_id: "rj-p8" } }),
    "key-7",
  );
  assertEquals(result.total_items, 2);
  const items = await listRejudgeJobItems(result.job_id);
  assertEquals(
    items.data.map((item) => item.source_kind).sort(),
    ["objective", "submission"],
  );
});

Deno.test("jobs: 策略变更作用域校验与生效", async () => {
  const db = getDb();
  await seedProblem("rj-p9", 993009);
  await seedProblem("rj-p10", 993010);
  await seedSubmission("rj-s9", "rj-p9");

  // 作用域外 → 400
  await assertRejects(
    () =>
      acceptRejudgeJob(
        "admin-1",
        request({
          scope: {
            type: "selected",
            submissions: [{ kind: "submission", id: "rj-s9" }],
          },
          policy_changes: [{
            problem_id: "rj-p10",
            expected_revision: 0,
            policy: { mode: "any" },
          }],
        }),
        "key-8",
      ),
    Error,
    "任务范围之外",
  );

  // 作用域内 → 应用策略并建任务
  const accepted = await acceptRejudgeJob(
    "admin-1",
    request({
      scope: {
        type: "selected",
        submissions: [{ kind: "submission", id: "rj-s9" }],
      },
      policy_changes: [{
        problem_id: "rj-p9",
        expected_revision: 0,
        policy: { mode: "exact", version_id: "rj-p9-v2" },
      }],
    }),
    "key-9",
  );
  assertEquals(accepted.total_items, 1);
  const [problem] = await db.select().from(problems).where(
    eq(problems.id, "rj-p9"),
  );
  assertEquals(problem.effective_version_mode, "exact");
  assertEquals(problem.required_version_id, "rj-p9-v2");
  assertEquals(problem.effective_policy_revision, 1);

  // 预期 revision 过时 → 409（且不产生新任务）
  await assertRejects(
    () =>
      acceptRejudgeJob(
        "admin-1",
        request({
          scope: {
            type: "selected",
            submissions: [{ kind: "submission", id: "rj-s9" }],
          },
          policy_changes: [{
            problem_id: "rj-p9",
            expected_revision: 0,
            policy: { mode: "any" },
          }],
        }),
        "key-10",
      ),
    Error,
    "有效版本策略已被修改",
  );
  const stale = await db.select().from(submissionJobs).where(
    eq(submissionJobs.idempotency_key, "key-10"),
  );
  assertEquals(stale.length, 0);
});

Deno.test("jobs: 重试只带 failed/skipped 且不改策略", async () => {
  const db = getDb();
  await seedProblem("rj-p11", 993011);
  await seedSubmission("rj-s11a", "rj-p11");
  await seedSubmission("rj-s11b", "rj-p11");
  const accepted = await acceptRejudgeJob(
    "admin-1",
    request({
      scope: {
        type: "selected",
        submissions: [
          { kind: "submission", id: "rj-s11a" },
          { kind: "submission", id: "rj-s11b" },
        ],
      },
    }),
    "key-11",
  );

  // 人工置一条 succeeded、一条 failed
  const items = await db.select().from(submissionJobItems).where(
    eq(submissionJobItems.job_id, accepted.job_id),
  ).orderBy(submissionJobItems.ordinal);
  await db.update(submissionJobItems).set({ status: "succeeded" }).where(
    eq(submissionJobItems.id, items[0].id),
  );
  await db.update(submissionJobItems).set({
    status: "failed",
    reason_code: "ARTIFACT_MISSING",
  }).where(eq(submissionJobItems.id, items[1].id));
  assertEquals(
    await refreshJobStatus(accepted.job_id),
    "completed_with_errors",
  );

  const retried = await retryRejudgeJob("admin-1", accepted.job_id, "key-12");
  assertEquals(retried.total_items, 1);
  const newItems = await listRejudgeJobItems(retried.job_id);
  assertEquals(newItems.data[0].source_id, "rj-s11b");
  // 目标版本映射保留
  assertEquals(newItems.data[0].target_version_id, "rj-p11-v1");
  // 不再次修改策略（request 中 policy_changes 为空）
  const [newJob] = await db.select().from(submissionJobs).where(
    eq(submissionJobs.id, retried.job_id),
  );
  const stored = newJob.request as unknown as Record<string, unknown>;
  assertEquals(Array.isArray(stored.policy_changes), true);
  assertEquals((stored.policy_changes as unknown[]).length, 0);
  assertEquals(stored.retry_of, accepted.job_id);

  // 没有可重试条目 → 400
  await assertRejects(
    () => retryRejudgeJob("admin-1", retried.job_id, "key-13"),
    Error,
    "没有可重试的条目",
  );
});

Deno.test("jobs: 手动所选超过 500 条被拒绝", async () => {
  await seedProblem("rj-p12", 993012);
  const many = Array.from({ length: 501 }, (_, index) => ({
    kind: "submission" as const,
    id: `ghost-${index}`,
  }));
  await assertRejects(
    () =>
      acceptRejudgeJob(
        "admin-1",
        request({ scope: { type: "selected", submissions: many } }),
        "key-14",
      ),
    Error,
    "不得超过 500 条",
  );
});

Deno.test("jobs: 状态由条目聚合（running / completed）", async () => {
  const db = getDb();
  await seedProblem("rj-p13", 993013);
  await seedSubmission("rj-s13", "rj-p13");
  const accepted = await acceptRejudgeJob(
    "admin-1",
    request({
      scope: {
        type: "selected",
        submissions: [{ kind: "submission", id: "rj-s13" }],
      },
    }),
    "key-15",
  );
  assertEquals(await refreshJobStatus(accepted.job_id), "queued");
  await db.update(submissionJobItems).set({ status: "dispatched" }).where(
    and(
      eq(submissionJobItems.job_id, accepted.job_id),
      eq(submissionJobItems.status, "pending"),
    ),
  );
  assertEquals(await refreshJobStatus(accepted.job_id), "running");
  await db.update(submissionJobItems).set({ status: "succeeded" }).where(
    eq(submissionJobItems.job_id, accepted.job_id),
  );
  assertEquals(await refreshJobStatus(accepted.job_id), "completed");
});
