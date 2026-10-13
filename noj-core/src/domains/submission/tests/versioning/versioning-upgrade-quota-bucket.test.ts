import { problemExecutionForTest } from "../../../../../tests/helper.ts";
import { resetDbForTest } from "../../../../shared/db/connection.ts";
import { authorizeLegacyJobActorForTest } from "../_versioning-fixtures.ts";
import { DEFAULT_DOMAIN_ID } from "../../../workspace/index.ts";
/**
 * 升级额度**桶选择**的回归（第三轮复审问题 6，P2）。
 *
 * 正常提交有三种用户额度桶（代码 / 竞赛代码 / 客观题）。升级副本此前统一占用
 * 代码桶，导致用户可以用练习额度跑竞赛升级、或用代码额度跑客观题升级。
 *
 * 本文件覆盖两层：
 * 1. 派发层**桶映射**（注入消费者，确定性强，不依赖 Redis）：练习代码 → `code`、
 *    `source_contest` → `contest_code`、客观题 → `objective`；管理员代升级仍扣原用户；
 * 2. 额度实现层**桶隔离与幂等**（假 Redis + 按用例开启限流）：一个桶耗尽不影响
 *    其它桶；同一 job item 重派只扣一次。
 */
import { assertEquals } from "jsr:@std/assert@^1";
import { eq } from "drizzle-orm";
import { getDb } from "../../../../shared/db/connection.ts";
import {
  contestParticipants,
  contests,
  judgeImages,
  objectiveSubmissions,
  permissions,
  problems,
  problemVersions,
  rolePermissions,
  roles,
  submissions,
  userRoles,
  users,
} from "../../../../shared/db/schema.ts";
import {
  SUBMISSION_QUOTA_BUCKETS,
  submissionQuotaRedisKey,
} from "../../../system/index.ts";
import { consumeSubmissionQuotaForUpgrade } from "../../services/versioning/upgrade-quota.ts";
import { claimJobItems } from "../../services/versioning/job-worker.ts";
import { dispatchJobItem } from "../../services/versioning/dispatch-job-item.ts";
import { acceptUpgradeJob } from "../../services/versioning/upgrade-jobs.ts";
import {
  getRedis,
  resetRedisForTest,
} from "../../../../shared/mq/connection.ts";
import { startFakeRedis } from "../mq/_setup.ts";
import {
  bindPublishedProblemForTest,
  insertContestProblems,
} from "../../../../../tests/helper.ts";

await resetDbForTest();

const now = new Date().toISOString();
const db = getDb();
const ts = Date.now();

// 真实 PG（独立 schema）不含 PGlite 的 root / 镜像种子
await db.insert(users).values({
  id: "0",
  username: "root",
  email: "root@noj.local",
  password_hash: "",
  created_at: now,
  updated_at: now,
}).onConflictDoNothing();
await db.insert(judgeImages).values([
  {
    id: "e0000000-0000-0000-0000-000000000002",
    image: "noj-evaluator-python",
    mode: "all_versions",
    kind: "evaluator",
    description: "测试 Evaluator",
    created_at: now,
    updated_at: now,
  },
  {
    id: "e0000000-0000-0000-0000-000000000003",
    image: "noj-solution-python",
    mode: "all_versions",
    kind: "solution",
    description: "测试 Solution",
    created_at: now,
    updated_at: now,
  },
]).onConflictDoNothing();

const dualConfig = {
  evaluator: {
    image: "noj-evaluator-python",
    command: "python3 /workspace/evaluate.py",
    time_limit_ms: 1111,
    memory_limit_mb: 512,
  },
  solution: {
    image: "noj-solution-python",
    call_timeout_ms: 2000,
    memory_limit_mb: 512,
  },
};

/** 建一个拥有 `admin:full_access` 的测试用户（用于"管理员代原用户升级"）。 */
async function makeAdminUser(tag: string): Promise<string> {
  const roleId = `qb-admin-role-${ts}`;
  const [existingPerm] = await db.select().from(permissions).where(
    eq(permissions.resource, "admin"),
  ).limit(1);
  const permissionId = existingPerm?.id ?? `qb-perm-${ts}`;
  if (!existingPerm) {
    await db.insert(permissions).values({
      id: permissionId,
      resource: "admin",
      action: "full_access",
      description: "测试用",
    }).onConflictDoNothing();
  }
  await db.insert(roles).values({
    id: roleId,
    name: `qb-admin-${ts}`,
    description: "测试管理员",
    created_at: now,
    updated_at: now,
  }).onConflictDoNothing();
  await db.insert(rolePermissions).values({
    role_id: roleId,
    permission_id: permissionId,
  }).onConflictDoNothing();
  const userId = await makeUser(tag);
  await db.insert(userRoles).values({ user_id: userId, role_id: roleId })
    .onConflictDoNothing();
  return userId;
}

async function makeUser(tag: string): Promise<string> {
  const id = `qb-user-${tag}-${ts}`;
  await db.insert(users).values({
    id,
    username: `qb-${tag}-${ts}`,
    email: `qb-${tag}-${ts}@test.noj`,
    password_hash: "hash",
    created_at: now,
    updated_at: now,
  });
  await authorizeLegacyJobActorForTest(id);
  return id;
}

async function seedProblem(
  tag: string,
  objective = false,
): Promise<{ problemId: string; v1: string; v2: string }> {
  const problemId = `qb-prob-${tag}-${ts}`;
  const v1 = `qb-v1-${tag}-${ts}`;
  const v2 = `qb-v2-${tag}-${ts}`;
  await db.insert(problems).values({
    domain_id: DEFAULT_DOMAIN_ID,
    id: problemId,
    title: `桶测试题 ${tag}`,
    description: "d",
    difficulty: "easy",
    number: 92500 + Math.floor(Math.random() * 900),
    owner_id: "0",
    judge_type: "dual",
    is_objective: objective,
    runtime_config: dualConfig,
    created_at: now,
    updated_at: now,
  });
  const content = (title: string) =>
    objective
      ? {
        kind: "objective",
        title,
        description: "d",
        samples: [],
        questions: [],
      }
      : {
        kind: "ai",
        title,
        description: "d",
        samples: [],
        submission_mode: "code",
        runtime_config: dualConfig,
        template_content: "",
        artifact_max_size_mb: null,
        llm_config: null,
      };
  await db.insert(problemVersions).values([
    {
      id: v1,
      problem_id: problemId,
      version: 1,
      origin: "published",
      content: content("V1"),
      published_at: now,
    },
    {
      id: v2,
      problem_id: problemId,
      version: 2,
      origin: "published",
      content: content("V2"),
      published_at: now,
    },
  ]);
  await db.update(problems).set({ latest_version_id: v2 }).where(
    eq(problems.id, problemId),
  );
  await bindPublishedProblemForTest(problemId);
  return { problemId, v1, v2 };
}

async function seedSubmission(
  problemId: string,
  userId: string,
  versionId: string,
  contestId: string | null = null,
): Promise<string> {
  const id = crypto.randomUUID();
  await db.insert(submissions).values({
    ...(await problemExecutionForTest(problemId)),
    id,
    user_id: userId,
    problem_id: problemId,
    contest_id: contestId,
    status: "finished",
    language: "python3",
    code: "print(1)",
    submitted_version_id: versionId,
    version_origin: "known",
    created_at: now,
  });
  return id;
}

async function seedContestFixture(
  problemId: string,
  userId: string,
  pinnedVersionId: string,
): Promise<string> {
  const contestId = `qb-contest-${ts}`;
  await db.insert(contests).values({
    id: contestId,
    domain_id: DEFAULT_DOMAIN_ID,
    created_by: userId,
    public_id: `qb-ct-${ts}`,
    title: "c",
    start_time: "2026-01-01T00:00:00.000Z",
    end_time: "2026-12-31T00:00:00.000Z",
    type: "kaggle",
    kind: "public",
    is_public: true,
    created_at: now,
    updated_at: now,
  });
  await insertContestProblems({
    contest_id: contestId,
    problem_id: problemId,
    label: "A",
    score: 100,
    sort_order: 0,
    pinned_version_id: pinnedVersionId,
  });
  await db.insert(contestParticipants).values({
    contest_id: contestId,
    user_id: userId,
    registered_at: now,
  });
  return contestId;
}

/** 在假 Redis 内领取并派发某升级条目，返回结论与注入消费者记录。 */
async function dispatchWithBucketProbe(
  jobId: string,
  owner: string,
  kind: "upgrade" | "rejudge",
  context: "practice" | "source_contest",
  bucketDecision: "defer" | "pass",
): Promise<{
  outcome: string;
  seen: Array<{ userId: string; itemId: string; bucket: string }>;
}> {
  const fake = startFakeRedis();
  const prevUrl = Deno.env.get("REDIS_URL") ?? null;
  try {
    resetRedisForTest();
    Deno.env.set("REDIS_URL", fake.url);
    await getRedis().connect();
    const [item] = (await claimJobItems(owner, { limit: 100 })).filter(
      (row) => row.job_id === jobId,
    );
    const seen: Array<{ userId: string; itemId: string; bucket: string }> = [];
    const outcome = await dispatchJobItem(
      item,
      owner,
      kind,
      context,
      (userId, itemId, bucket) => {
        seen.push({ userId, itemId, bucket });
        return Promise.resolve(
          bucketDecision === "defer"
            ? { ok: false as const, retryAfterMs: 1_000 }
            : { ok: true as const },
        );
      },
    );
    return { outcome, seen };
  } finally {
    resetRedisForTest();
    if (prevUrl !== null) Deno.env.set("REDIS_URL", prevUrl);
    else Deno.env.delete("REDIS_URL");
    await fake.stop();
  }
}

Deno.test({
  name: "quota#6: 练习代码升级用 code 桶",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const actor = await makeUser("code");
    const { problemId, v1 } = await seedProblem("code");
    await seedSubmission(problemId, actor, v1);
    const accepted = await acceptUpgradeJob(
      actor,
      {
        submissions: [{
          kind: "submission",
          id: (await db.select({ id: submissions.id }).from(submissions).where(
            eq(submissions.problem_id, problemId),
          ))[0].id,
        }],
        context: "practice",
      },
      `qb-code-key-${ts}`,
    );
    const probe = await dispatchWithBucketProbe(
      accepted.job_id,
      "qb-w1",
      "upgrade",
      "practice",
      "defer",
    );
    assertEquals(probe.outcome, "deferred");
    assertEquals(probe.seen.length, 1);
    assertEquals(probe.seen[0].bucket, "code");
    assertEquals(probe.seen[0].userId, actor);
  },
});

Deno.test({
  name: "quota#6: 竞赛内升级用 contest_code 桶（管理员代升级扣原用户）",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const owner = await makeUser("contest");
    const admin = await makeAdminUser("admin");
    const { problemId, v1, v2 } = await seedProblem("contest");
    const contestId = await seedContestFixture(problemId, owner, v2);
    const submissionId = await seedSubmission(problemId, owner, v1, contestId);
    // 管理员代原用户升级（actor = admin，额度必须扣原用户）
    const accepted = await acceptUpgradeJob(
      admin,
      {
        submissions: [{ kind: "submission", id: submissionId }],
        context: "source_contest",
      },
      `qb-contest-key-${ts}`,
    );
    const probe = await dispatchWithBucketProbe(
      accepted.job_id,
      "qb-w2",
      "upgrade",
      "source_contest",
      "defer",
    );
    assertEquals(probe.outcome, "deferred");
    assertEquals(probe.seen.length, 1);
    assertEquals(probe.seen[0].bucket, "contest_code");
    // 管理员代升级仍扣**原用户**预算
    assertEquals(probe.seen[0].userId, owner);
  },
});

Deno.test({
  name: "quota#6: 客观题升级用 objective 桶",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const actor = await makeUser("objective");
    const { problemId, v1 } = await seedProblem("objective", true);
    const objectiveSubmissionId = crypto.randomUUID();
    await db.insert(objectiveSubmissions).values({
      ...(await problemExecutionForTest(problemId)),
      id: objectiveSubmissionId,
      paper_id: problemId,
      user_id: actor,
      submission_type: "practice",
      answers: {},
      status: "finished",
      score: 0,
      details: {},
      submitted_version_id: v1,
      version_origin: "known",
      created_at: now,
    });
    const accepted = await acceptUpgradeJob(
      actor,
      {
        submissions: [{ kind: "objective", id: objectiveSubmissionId }],
        context: "practice",
      },
      `qb-obj-key-${ts}`,
    );
    const probe = await dispatchWithBucketProbe(
      accepted.job_id,
      "qb-w3",
      "upgrade",
      "practice",
      "defer",
    );
    assertEquals(probe.outcome, "deferred");
    assertEquals(probe.seen.length, 1);
    assertEquals(probe.seen[0].bucket, "objective");
    assertEquals(probe.seen[0].userId, actor);
    // 延期意味着事务回滚：不留副本
    assertEquals(
      (await db.select().from(objectiveSubmissions).where(
        eq(objectiveSubmissions.paper_id, problemId),
      )).length,
      1,
    );
  },
});

Deno.test({
  name: "quota#6: 三个桶相互独立，且同一 job item 重派只扣一次",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const prevLimit = Deno.env.get("RATE_LIMIT_ENABLED");
    const fake = startFakeRedis();
    const prevUrl = Deno.env.get("REDIS_URL") ?? null;
    try {
      resetRedisForTest();
      Deno.env.set("REDIS_URL", fake.url);
      await getRedis().connect();
      // 限流总开关按用例开启（NOJ_ENV=test 默认关闭）——必须 finally 还原
      Deno.env.set("RATE_LIMIT_ENABLED", "true");

      const userId = `qb-bucket-user-${ts}`;
      const codeKey = submissionQuotaRedisKey("code", userId);
      const contestKey = submissionQuotaRedisKey("contest_code", userId);
      const objectiveKey = submissionQuotaRedisKey("objective", userId);
      assertDistinct(codeKey, contestKey, objectiveKey);

      // 代码桶耗尽：仅代码桶延期，竞赛/客观题桶不受影响（桶隔离）
      await getRedis().set(
        codeKey,
        String(SUBMISSION_QUOTA_BUCKETS.code.limit.max),
      );
      const code = await consumeSubmissionQuotaForUpgrade(
        userId,
        "qb-item-code",
        { bucket: "code" },
      );
      assertEquals(code.ok, false);
      assertEquals(
        (await consumeSubmissionQuotaForUpgrade(userId, "qb-item-contest", {
          bucket: "contest_code",
        })).ok,
        true,
      );
      assertEquals(
        (await consumeSubmissionQuotaForUpgrade(userId, "qb-item-objective", {
          bucket: "objective",
        })).ok,
        true,
      );
      // 只扣了各桶自己的计数：竞赛/客观题桶各 1
      assertEquals(await getRedis().get(contestKey), "1");
      assertEquals(await getRedis().get(objectiveKey), "1");

      // 幂等：同一 job item 重派不再扣费
      assertEquals(
        (await consumeSubmissionQuotaForUpgrade(userId, "qb-item-contest", {
          bucket: "contest_code",
        })).ok,
        true,
      );
      assertEquals(await getRedis().get(contestKey), "1");
    } finally {
      resetRedisForTest();
      if (prevLimit === undefined) Deno.env.delete("RATE_LIMIT_ENABLED");
      else Deno.env.set("RATE_LIMIT_ENABLED", prevLimit);
      if (prevUrl !== null) Deno.env.set("REDIS_URL", prevUrl);
      else Deno.env.delete("REDIS_URL");
      await fake.stop();
    }
  },
});

function assertDistinct(...keys: string[]): void {
  assertEquals(new Set(keys).size, keys.length);
}
