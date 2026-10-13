import { problemExecutionForTest } from "../../../../../tests/helper.ts";
import { DEFAULT_DOMAIN_ID } from "../../../../shared/workspace/types.ts";
import { authorizeLegacyJobActorForTest } from "../_versioning-fixtures.ts";
/**
 * 批任务派发前的平台安全预检回归（tracking #33 后半、Handbook §7）。
 *
 * 批任务重测/升级的可能是**很久以前发布**的版本：当时通过校验的评测镜像可能已被
 * 移出白名单，平台资源上限也可能已收紧。worker 必须在**创建尝试之前**复用当前平台
 * 预检；预检失败属永久失败（条目 `failed` + 机器可读原因码），不得留下无消息的活动
 * 尝试，也不得丢弃历史判定。
 */
import { assertEquals } from "jsr:@std/assert@^1";
import { eq } from "drizzle-orm";
import { getDb } from "../../../../shared/db/connection.ts";
import {
  evaluationAttempts,
  judgeImages,
  problems,
  problemVersions,
  submissionJobItems,
  submissions,
  users,
} from "../../../../shared/db/schema.ts";
import { ROOT_USER_ID } from "../../../../shared/base/constants.ts";
import { resetSetting, updateSetting } from "../../../system/index.ts";
import { acceptLegacyRejudgeJobForTest as acceptRejudgeJob } from "../_versioning-fixtures.ts";
import { dispatchJobItem } from "../../services/versioning/dispatch-job-item.ts";
import { claimJobItems } from "../../services/versioning/job-worker.ts";
import {
  getRedis,
  resetRedisForTest,
} from "../../../../shared/mq/connection.ts";
import { startFakeRedis } from "../mq/_setup.ts";

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

const runtimeWith = (overrides: {
  evaluatorImage?: string;
  evaluatorMemoryMb?: number;
}) => ({
  evaluator: {
    image: overrides.evaluatorImage ?? "noj-evaluator-python",
    command: "python3 /workspace/evaluate.py",
    time_limit_ms: 1000,
    memory_limit_mb: overrides.evaluatorMemoryMb ?? 256,
  },
  solution: {
    image: "noj-solution-python",
    call_timeout_ms: 2000,
    memory_limit_mb: 256,
  },
});

async function makeUser(tag: string): Promise<string> {
  const id = `pf-user-${tag}-${ts}`;
  await db.insert(users).values({
    id,
    username: `pf-${tag}-${ts}`,
    email: `pf-${tag}-${ts}@test.noj`,
    password_hash: "hash",
    created_at: now,
    updated_at: now,
  });
  await authorizeLegacyJobActorForTest(id);
  return id;
}

/** 建题 + 单个已发布版本（内容按参数构造），返回版本 ID。 */
async function seedVersionContent(
  tag: string,
  runtime: ReturnType<typeof runtimeWith>,
): Promise<{ problemId: string; versionId: string }> {
  const problemId = `pf-prob-${tag}-${ts}`;
  const versionId = `pf-v1-${tag}-${ts}`;
  await db.insert(problems).values({
    domain_id: DEFAULT_DOMAIN_ID,
    id: problemId,
    title: `预检测试题 ${tag}`,
    description: "d",
    difficulty: "easy",
    number: 96900 + Math.floor(Math.random() * 900),
    owner_id: "0",
    judge_type: "dual",
    runtime_config: runtime,
    created_at: now,
    updated_at: now,
  });
  await db.insert(problemVersions).values({
    id: versionId,
    problem_id: problemId,
    version: 1,
    origin: "published",
    content: {
      kind: "ai",
      title: `预检测试题 ${tag}`,
      description: "d",
      samples: [],
      submission_mode: "code",
      runtime_config: runtime,
      template_content: "",
      artifact_max_size_mb: null,
      llm_config: null,
    },
    published_at: now,
  });
  await db.update(problems).set({ latest_version_id: versionId }).where(
    eq(problems.id, problemId),
  );
  return { problemId, versionId };
}

async function seedSubmission(
  problemId: string,
  userId: string,
  versionId: string,
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
  });
  return submissionId;
}

/** 受理 latest 目标重测任务并在假 Redis 中派发第一条。 */
async function acceptAndDispatch(
  actor: string,
  submissionId: string,
): Promise<{ jobId: string; outcome: string }> {
  const accepted = await acceptRejudgeJob(
    actor,
    {
      kind: "rejudge",
      scope: {
        type: "selected",
        submissions: [{ kind: "submission", id: submissionId }],
      },
      target: { mode: "latest" },
    },
    `pf-key-${crypto.randomUUID()}`,
  );
  const jobId = accepted.job_id;
  const fake = startFakeRedis();
  const prevUrl = Deno.env.get("REDIS_URL") ?? null;
  try {
    resetRedisForTest();
    Deno.env.set("REDIS_URL", fake.url);
    await getRedis().connect();
    const items = (await claimJobItems("pf-worker", { limit: 100 })).filter(
      (item) => item.job_id === jobId,
    );
    assertEquals(items.length, 1);
    const outcome = await dispatchJobItem(items[0], "pf-worker", "rejudge");
    return { jobId, outcome };
  } finally {
    // 同上：先恢复 env / 单例，再停止 fake
    resetRedisForTest();
    if (prevUrl !== null) Deno.env.set("REDIS_URL", prevUrl);
    else Deno.env.delete("REDIS_URL");
    await fake.stop();
  }
}

async function loadItem(jobId: string) {
  const [item] = await db.select().from(submissionJobItems).where(
    eq(submissionJobItems.job_id, jobId),
  );
  return item;
}

Deno.test({
  name:
    "dispatch#33: 目标版本镜像不在当前白名单 → failed + JUDGE_IMAGE_NOT_ALLOWED（不建尝试）",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const actor = await makeUser("image");
    const { problemId, versionId } = await seedVersionContent(
      "image",
      runtimeWith({ evaluatorImage: "evil-evaluator:latest" }),
    );
    const submissionId = await seedSubmission(problemId, actor, versionId);

    const { jobId, outcome } = await acceptAndDispatch(actor, submissionId);
    assertEquals(outcome, "failed");
    const item = await loadItem(jobId);
    assertEquals(item.status, "failed");
    assertEquals(item.reason_code, "JUDGE_IMAGE_NOT_ALLOWED");
    assertEquals(item.attempt_id, null);
    assertEquals(item.lease_owner, null);
    // 未创建任何重测尝试，源提交活动指针保持空
    const attempts = await db.select({
      id: evaluationAttempts.id,
      source: evaluationAttempts.source,
    }).from(evaluationAttempts).where(
      eq(evaluationAttempts.submission_id, submissionId),
    );
    assertEquals(attempts.filter((row) => row.source === "rejudge").length, 0);
    const [source] = await db.select().from(submissions).where(
      eq(submissions.id, submissionId),
    );
    assertEquals(source.active_attempt_id, null);
  },
});

Deno.test({
  name:
    "dispatch#33: 目标版本资源超限 → failed + RESOURCE_LIMIT_EXCEEDED（不建尝试）",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const actor = await makeUser("limit");
    // 版本声明的 evaluator 内存远超平台上限
    const { problemId, versionId } = await seedVersionContent(
      "limit",
      runtimeWith({ evaluatorMemoryMb: 4096 }),
    );
    const submissionId = await seedSubmission(problemId, actor, versionId);

    await updateSetting(
      "judge_max_evaluator_memory_limit_mb",
      512,
      ROOT_USER_ID,
    );
    try {
      const { jobId, outcome } = await acceptAndDispatch(actor, submissionId);
      assertEquals(outcome, "failed");
      const item = await loadItem(jobId);
      assertEquals(item.status, "failed");
      assertEquals(item.reason_code, "RESOURCE_LIMIT_EXCEEDED");
      assertEquals(item.attempt_id, null);
      const attempts = await db.select().from(evaluationAttempts).where(
        eq(evaluationAttempts.submission_id, submissionId),
      );
      assertEquals(
        attempts.filter((row) => row.source === "rejudge").length,
        0,
      );
    } finally {
      await resetSetting(
        "judge_max_evaluator_memory_limit_mb",
        ROOT_USER_ID,
      );
    }
  },
});

Deno.test({
  name: "dispatch#33: 白名单与资源均合规 → 正常创建尝试并派发",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const actor = await makeUser("ok");
    const { problemId, versionId } = await seedVersionContent(
      "ok",
      runtimeWith({}),
    );
    const submissionId = await seedSubmission(problemId, actor, versionId);

    const { jobId, outcome } = await acceptAndDispatch(actor, submissionId);
    assertEquals(outcome, "dispatched");
    const item = await loadItem(jobId);
    assertEquals(item.status, "dispatched");
    assertEquals(typeof item.attempt_id, "string");
    assertEquals(item.reason_code, null);
  },
});
