import { problemExecutionForTest } from "../../../../../tests/helper.ts";
import { resetDbForTest } from "../../../../shared/db/connection.ts";
import { authorizeLegacyJobActorForTest } from "../_versioning-fixtures.ts";
/**
 * 用户升级的授权与竞赛语义回归（tracking #42、#43）。
 *
 * - #42「升级复用正常提交权限/限制 + 管理员代原用户升级」：操作者授权（本人 /
 *   管理员或重测权限者）与**原用户的正常提交资格**必须分开评估——管理员代升级
 *   不能把自己的管理员可见性借给原用户；新提交归原用户，操作者记录在尝试上。
 * - #43「source_contest 先固定最新版并要求等于竞赛固定版本；客观题不得静默变练习」：
 *   固定版 == 最新版时可升级且保留竞赛；不匹配时受理即拒绝；
 *   客观题在 `source_contest` 下不得产生第二次竞赛提交，也不得被改成练习副本。
 */
import { assertEquals, assertRejects } from "jsr:@std/assert@^1";
import { and, eq } from "drizzle-orm";
import { getDb } from "../../../../shared/db/connection.ts";
import {
  DEFAULT_DOMAIN_ID,
  ensureDefaultWorkspace,
  removeDomainMember,
} from "../../../workspace/index.ts";
import {
  contestParticipants,
  contests,
  evaluationAttempts,
  judgeImages,
  objectiveSubmissions,
  permissions,
  problems,
  problemVersions,
  rolePermissions,
  roles,
  submissionJobItems,
  submissionJobs,
  submissions,
  userRoles,
  users,
} from "../../../../shared/db/schema.ts";
import { acceptUpgradeJob } from "../../services/versioning/upgrade-jobs.ts";
import { dispatchJobItem } from "../../services/versioning/dispatch-job-item.ts";
import { claimJobItems } from "../../services/versioning/job-worker.ts";
import {
  getRedis,
  resetRedisForTest,
} from "../../../../shared/mq/connection.ts";
import { startFakeRedis } from "../mq/_setup.ts";
import { insertContestProblems } from "../../../../../tests/helper.ts";

await resetDbForTest();

const now = new Date().toISOString();

// 真实 PG（独立 schema）由迁移创建，不含 PGlite 的 root 种子；
// 用例把 `owner_id` 指向 "0"，因此这里幂等补一行（PGlite 下已存在，无副作用）。
await getDb().insert(users).values({
  id: "0",
  username: "root",
  email: "root@noj.local",
  password_hash: "",
  created_at: now,
  updated_at: now,
}).onConflictDoNothing();

// 真实 PG（独立 schema）不含 PGlite 的评测镜像种子：白名单为空会让所有派发被
// 预检拒绝（JUDGE_IMAGE_NOT_ALLOWED），因此这里幂等补上两条（PGlite 下已存在）。
await getDb().insert(judgeImages).values([
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

const db = getDb();
const ts = Date.now();

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

/** 建一条拥有 `admin:full_access` 的测试角色（PGlite 模板不保证 RBAC 种子存在）。 */
async function ensureAdminRole(): Promise<string> {
  const roleId = `acc-role-admin-${ts}`;
  const [existingPerm] = await db.select().from(permissions).where(
    and(
      eq(permissions.resource, "admin"),
      eq(permissions.action, "full_access"),
    ),
  ).limit(1);
  const permissionId = existingPerm?.id ?? `acc-perm-${ts}`;
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
    name: `acc-admin-${ts}`,
    description: "测试管理员",
    created_at: now,
    updated_at: now,
  }).onConflictDoNothing();
  await db.insert(rolePermissions).values({
    role_id: roleId,
    permission_id: permissionId,
  }).onConflictDoNothing();
  return roleId;
}

async function makeUser(
  tag: string,
  options: { admin?: boolean } = {},
): Promise<string> {
  const id = `acc-user-${tag}-${ts}`;
  await db.insert(users).values({
    id,
    username: `acc-${tag}-${ts}`,
    email: `acc-${tag}-${ts}@test.noj`,
    password_hash: "hash",
    created_at: now,
    updated_at: now,
  });
  if (options.admin) {
    const roleId = await ensureAdminRole();
    await db.insert(userRoles).values({ user_id: id, role_id: roleId })
      .onConflictDoNothing();
  }
  await authorizeLegacyJobActorForTest(id);
  return id;
}

async function seedProblemWithVersions(
  tag: string,
  options: {
    visibility?: "public" | "private";
    ownerId?: string;
    /** 版本内容类别（客观题路径需要 `objective` 内容）。 */
    contentKind?: "ai" | "objective";
  } = {},
): Promise<{ problemId: string; v1: string; v2: string }> {
  const problemId = `acc-prob-${tag}-${ts}`;
  const v1 = `acc-v1-${tag}-${ts}`;
  const v2 = `acc-v2-${tag}-${ts}`;
  await db.insert(problems).values({
    domain_id: DEFAULT_DOMAIN_ID,
    id: problemId,
    title: `升级授权测试题 ${tag}`,
    description: "d",
    difficulty: "easy",
    number: 97800 + Math.floor(Math.random() * 1000),
    owner_id: options.ownerId ?? "0",
    visibility: options.visibility ?? "public",
    judge_type: "dual",
    runtime_config: dualConfig,
    created_at: now,
    updated_at: now,
  });
  const content = (title: string) =>
    options.contentKind === "objective"
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
  extra: Record<string, unknown> = {},
): Promise<string> {
  const submissionId = crypto.randomUUID();
  await db.insert(submissions).values({
    ...(await problemExecutionForTest(problemId)),
    id: submissionId,
    user_id: userId,
    problem_id: problemId,
    status: "finished",
    language: "python3",
    code: "print(1)",
    submitted_version_id: versionId,
    version_origin: "known",
    created_at: now,
    ...extra,
  });
  return submissionId;
}

async function loadItem(jobId: string) {
  const [item] = await db.select().from(submissionJobItems).where(
    eq(submissionJobItems.job_id, jobId),
  );
  return item;
}

/** 在假 Redis 中领取并派发某任务的第一条条目。 */
async function dispatchFirstItem(
  jobId: string,
  kind: "rejudge" | "upgrade",
  context: "practice" | "source_contest" = "practice",
): Promise<string> {
  const fake = startFakeRedis();
  const prevUrl = Deno.env.get("REDIS_URL") ?? null;
  try {
    resetRedisForTest();
    Deno.env.set("REDIS_URL", fake.url);
    await getRedis().connect();
    const items = (await claimJobItems("acc-worker", { limit: 100 }))
      .filter((item) => item.job_id === jobId);
    assertEquals(items.length > 0, true);
    return await dispatchJobItem(items[0], "acc-worker", kind, context);
  } finally {
    // 先恢复 env / 单例再停止 fake：避免并行文件读到已停止的服务器
    // （额度调用会 fail-closed，把正常升级派发误判为延期）
    resetRedisForTest();
    if (prevUrl !== null) Deno.env.set("REDIS_URL", prevUrl);
    else Deno.env.delete("REDIS_URL");
    await fake.stop();
  }
}

Deno.test({
  name: "upgrade#42: 管理员代原用户升级——新提交归原用户，actor 记入尝试",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const admin = await makeUser("admin", { admin: true });
    const owner = await makeUser("owner");
    const { problemId, v1, v2 } = await seedProblemWithVersions("proxy");
    const submissionId = await seedSubmission(problemId, owner, v1);

    const accepted = await acceptUpgradeJob(
      admin,
      {
        submissions: [{ kind: "submission", id: submissionId }],
        context: "practice",
      },
      `acc-proxy-key-${ts}`,
    );
    assertEquals(accepted.total_items, 1);
    const [job] = await db.select().from(submissionJobs).where(
      eq(submissionJobs.id, accepted.job_id),
    );
    assertEquals(job.actor_id, admin);

    const outcome = await dispatchFirstItem(accepted.job_id, "upgrade");
    assertEquals(outcome, "dispatched");

    const item = await loadItem(accepted.job_id);
    const newId = item.result_submission_id as string;
    assertEquals(typeof newId, "string");
    assertEquals(newId !== submissionId, true);
    const [created] = await db.select().from(submissions).where(
      eq(submissions.id, newId),
    );
    // 新提交仍归**原用户**，不是操作者
    assertEquals(created.user_id, owner);
    assertEquals(created.upgraded_from_id, submissionId);
    assertEquals(created.submitted_version_id, v2);
    // 操作者记录在尝试上
    const [attempt] = await db.select().from(evaluationAttempts).where(
      eq(evaluationAttempts.id, item.attempt_id as string),
    );
    assertEquals(attempt.created_by, admin);
    assertEquals(attempt.source, "upgrade");
  },
});

Deno.test({
  name: "upgrade#42: 管理员代升级不得把管理员可见性借给原用户（资格独立判定）",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const admin = await makeUser("admin2", { admin: true });
    const owner = await makeUser("owner2");
    const stranger = await makeUser("stranger");
    // 原用户离域后，管理员的管理权限不能替代其当前提交资格。
    const { problemId, v1 } = await seedProblemWithVersions("private", {
      visibility: "private",
      ownerId: owner,
    });
    const submissionId = await seedSubmission(problemId, stranger, v1);

    const accepted = await acceptUpgradeJob(
      admin,
      {
        submissions: [{ kind: "submission", id: submissionId }],
        context: "practice",
      },
      `acc-private-key-${ts}`,
    );
    assertEquals(accepted.total_items, 1);
    await removeDomainMember("main", "0", stranger);

    // 受理不校验可访问性；派发必须按**原用户**资格拒绝（管理员身份不外借）
    await assertRejects(
      () => dispatchFirstItem(accepted.job_id, "upgrade"),
      Error,
      "工作空间权限不足",
    );
    // 未创建任何升级副本
    assertEquals(
      (await db.select().from(submissions).where(
        eq(submissions.upgraded_from_id, submissionId),
      )).length,
      0,
    );
  },
});

Deno.test({
  name:
    "upgrade#43: source_contest 要求最新版 == 竞赛固定版，相等时可升级并留在竞赛",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const user = await makeUser("contest");
    const { problemId, v1, v2 } = await seedProblemWithVersions("contest-ok");
    const contestId = `acc-contest-${ts}`;
    await db.insert(contests).values({
      id: contestId,
      domain_id: DEFAULT_DOMAIN_ID,
      created_by: user,
      public_id: `ct-acc-${ts}`,
      title: "c",
      start_time: "2026-01-01T00:00:00.000Z",
      end_time: "2026-12-31T00:00:00.000Z",
      type: "kaggle",
      kind: "public",
      is_public: true,
      created_at: now,
      updated_at: now,
    });
    // 竞赛固定作答版本 = 最新版 V2
    await insertContestProblems({
      contest_id: contestId,
      problem_id: problemId,
      label: "A",
      score: 100,
      sort_order: 0,
      pinned_version_id: v2,
    });
    await db.insert(contestParticipants).values({
      contest_id: contestId,
      user_id: user,
      registered_at: now,
    });
    const submissionId = await seedSubmission(problemId, user, v1, {
      contest_id: contestId,
    });

    const accepted = await acceptUpgradeJob(
      user,
      {
        submissions: [{ kind: "submission", id: submissionId }],
        context: "source_contest",
      },
      `acc-contest-key-${ts}`,
    );
    assertEquals(accepted.skipped_items, 0);
    const item = await loadItem(accepted.job_id);
    // 目标版本 = 受理时固定的最新版 == 竞赛固定版
    assertEquals(item.target_version_id, v2);
    assertEquals(item.status, "pending");

    const outcome = await dispatchFirstItem(
      accepted.job_id,
      "upgrade",
      "source_contest",
    );
    assertEquals(outcome, "dispatched");
    const dispatched = await loadItem(accepted.job_id);
    const [created] = await db.select().from(submissions).where(
      eq(submissions.id, dispatched.result_submission_id as string),
    );
    // 新提交留在原竞赛、归原用户、使用固定版本
    assertEquals(created.contest_id, contestId);
    assertEquals(created.user_id, user);
    assertEquals(created.submitted_version_id, v2);
  },
});

Deno.test("upgrade#43: 客观题竞赛提交在 source_contest 下不得产生练习副本", async () => {
  await ensureDefaultWorkspace();
  const user = await makeUser("obj");
  const { problemId, v1, v2 } = await seedProblemWithVersions("obj", {
    contentKind: "objective",
  });
  await db.update(problems).set({ is_objective: true }).where(
    eq(problems.id, problemId),
  );
  const contestId = `acc-obj-contest-${ts}`;
  await db.insert(contests).values({
    id: contestId,
    domain_id: DEFAULT_DOMAIN_ID,
    created_by: user,
    public_id: `ct-acc-obj-${ts}`,
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
    pinned_version_id: v2,
  });
  await db.insert(contestParticipants).values({
    contest_id: contestId,
    user_id: user,
    registered_at: now,
  });
  const objectiveId = crypto.randomUUID();
  await db.insert(objectiveSubmissions).values({
    ...(await problemExecutionForTest(problemId)),
    id: objectiveId,
    paper_id: problemId,
    user_id: user,
    contest_id: contestId,
    submission_type: "contest",
    answers: { k1: ["A"] },
    status: "finished",
    score: 0,
    details: {},
    submitted_version_id: v1,
    version_origin: "known",
    created_at: now,
  });

  // 受理层：source_contest + 客观题 → 409，不产生任务
  await assertRejects(
    () =>
      acceptUpgradeJob(
        user,
        {
          submissions: [{ kind: "objective", id: objectiveId }],
          context: "source_contest",
        },
        `acc-obj-key-${ts}`,
      ),
    Error,
    "客观题竞赛仅允许一次提交",
  );
  assertEquals(
    (await db.select().from(submissionJobs).where(
      eq(submissionJobs.idempotency_key, `acc-obj-key-${ts}`),
    )).length,
    0,
  );

  // 派发侧兜底：即使条目已存在（例如受理后语义变更），也只能 failed，
  // 绝不能静默生成一条 contest_id = null 的练习提交
  const jobId = `acc-obj-job-${ts}`;
  await db.insert(submissionJobs).values({
    domain_id: DEFAULT_DOMAIN_ID,
    id: jobId,
    kind: "upgrade",
    actor_id: user,
    idempotency_key: `acc-obj-job-key-${ts}`,
    request_hash: "h",
    request: {
      submissions: [{ kind: "objective", id: objectiveId }],
      context: "source_contest",
    },
    status: "queued",
    created_at: now,
  });
  await db.insert(submissionJobItems).values({
    ...(await problemExecutionForTest(problemId)),
    id: `acc-obj-item-${ts}`,
    job_id: jobId,
    ordinal: 0,
    source_kind: "objective",
    source_id: objectiveId,
    problem_id: problemId,
    target_version_id: v2,
    target_version_ref: v2,
    status: "pending",
    created_at: now,
  });

  const fake = startFakeRedis();
  const prevUrl = Deno.env.get("REDIS_URL") ?? null;
  try {
    resetRedisForTest();
    Deno.env.set("REDIS_URL", fake.url);
    await getRedis().connect();
    const items = (await claimJobItems("acc-obj-worker", { limit: 100 }))
      .filter((item) => item.job_id === jobId);
    assertEquals(items.length, 1);
    const outcome = await dispatchJobItem(
      items[0],
      "acc-obj-worker",
      "upgrade",
      "source_contest",
    );
    assertEquals(outcome, "failed");
  } finally {
    // 先恢复 env / 单例再停止 fake：避免并行文件读到已停止的服务器
    // （额度调用会 fail-closed，把正常升级派发误判为延期）
    resetRedisForTest();
    if (prevUrl !== null) Deno.env.set("REDIS_URL", prevUrl);
    else Deno.env.delete("REDIS_URL");
    await fake.stop();
  }
  const item = await loadItem(jobId);
  assertEquals(item.status, "failed");
  assertEquals(item.reason_code, "OBJECTIVE_CONTEST_UPGRADE_FORBIDDEN");
  assertEquals(item.result_submission_id, null);
  // 竞赛客观题提交仍只有一条，也没有新的练习提交
  const rows = await db.select().from(objectiveSubmissions).where(
    and(
      eq(objectiveSubmissions.paper_id, problemId),
      eq(objectiveSubmissions.user_id, user),
    ),
  );
  assertEquals(rows.length, 1);
  assertEquals(rows[0].id, objectiveId);
  assertEquals(rows[0].contest_id, contestId);
});
import { bindPublishedProblemForTest } from "../../../../../tests/helper.ts";
