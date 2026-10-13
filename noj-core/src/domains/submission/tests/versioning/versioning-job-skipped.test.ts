import { DEFAULT_DOMAIN_ID } from "../../../../shared/workspace/types.ts";
import { authorizeLegacyJobActorForTest } from "../_versioning-fixtures.ts";
/**
 * 锁内复查分类回归（复审问题 10，P2）——PGlite 可跑部分。
 *
 * Handbook 固定分类：**源正在评测 / 源已删除 → 条目 `skipped`**（可重试），
 * 其它目标配置/交付物错误仍 `failed`。本文件覆盖"两个任务争抢同一源"的可观测契约；
 * 真正需要屏障的"预检期间源被换版/删除"用例在 `versioning-job-skipped-source.pg.test.ts`
 * （真实 PostgreSQL）。
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
  submissionJobs,
  submissions,
  users,
} from "../../../../shared/db/schema.ts";
import { claimJobItems } from "../../services/versioning/job-worker.ts";
import { dispatchJobItem } from "../../services/versioning/dispatch-job-item.ts";
import { acceptLegacyRejudgeJobForTest as acceptRejudgeJob } from "../_versioning-fixtures.ts";
import { applyAttemptResult } from "../../services/versioning/result-write.ts";
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

async function makeUser(tag: string): Promise<string> {
  const id = `sk-user-${tag}-${ts}`;
  await db.insert(users).values({
    id,
    username: `sk-${tag}-${ts}`,
    email: `sk-${tag}-${ts}@test.noj`,
    password_hash: "hash",
    created_at: now,
    updated_at: now,
  });
  await authorizeLegacyJobActorForTest(id);
  return id;
}

async function seedProblem(
  tag: string,
): Promise<{ problemId: string; versionId: string }> {
  const problemId = `sk-prob-${tag}-${ts}`;
  const versionId = `sk-v1-${tag}-${ts}`;
  await db.insert(problems).values({
    domain_id: DEFAULT_DOMAIN_ID,
    id: problemId,
    title: `skipped 分类测试题 ${tag}`,
    description: "d",
    difficulty: "easy",
    number: 94700 + Math.floor(Math.random() * 900),
    owner_id: "0",
    judge_type: "dual",
    runtime_config: dualConfig,
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
      title: `skipped 分类测试题 ${tag}`,
      description: "d",
      samples: [],
      submission_mode: "code",
      runtime_config: dualConfig,
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
  const id = crypto.randomUUID();
  await db.insert(submissions).values({
    id,
    user_id: userId,
    problem_id: problemId,
    status: "finished",
    language: "python3",
    code: "print(1)",
    submitted_version_id: versionId,
    version_origin: "known",
    created_at: now,
  });
  return id;
}

/** 受理一个指向该提交的重测任务并返回条目。 */
async function acceptAndClaim(
  actor: string,
  submissionId: string,
  owner: string,
) {
  const accepted = await acceptRejudgeJob(
    actor,
    {
      kind: "rejudge",
      scope: {
        type: "selected",
        submissions: [{ kind: "submission", id: submissionId }],
      },
      target: { mode: "submitted" },
    },
    `sk-key-${crypto.randomUUID()}`,
  );
  const [item] = (await claimJobItems(owner, { limit: 100 })).filter(
    (row) => row.job_id === accepted.job_id,
  );
  return { jobId: accepted.job_id, item };
}

Deno.test({
  name: "skipped#10: 两任务争抢同一源 → 后到者 skipped + SOURCE_JUDGING",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const fake = startFakeRedis();
    const prevUrl = Deno.env.get("REDIS_URL") ?? null;
    try {
      resetRedisForTest();
      Deno.env.set("REDIS_URL", fake.url);
      await getRedis().connect();

      const actor = await makeUser("race");
      const { problemId, versionId } = await seedProblem("race");
      const submissionId = await seedSubmission(problemId, actor, versionId);

      const first = await acceptAndClaim(actor, submissionId, "sk-w1");
      assertEquals(
        await dispatchJobItem(first.item, "sk-w1", "rejudge"),
        "dispatched",
      );
      const [firstItem] = await db.select().from(submissionJobItems).where(
        eq(submissionJobItems.id, first.item.id),
      );
      assertEquals(firstItem.status, "dispatched");
      const winningAttempt = firstItem.attempt_id as string;
      assertEquals(typeof winningAttempt, "string");

      // 第二个任务（不同任务、不同条目）指向同一源
      const second = await acceptAndClaim(actor, submissionId, "sk-w2");
      assertEquals(
        await dispatchJobItem(second.item, "sk-w2", "rejudge"),
        "skipped",
      );
      const [secondItem] = await db.select().from(submissionJobItems).where(
        eq(submissionJobItems.id, second.item.id),
      );
      assertEquals(secondItem.status, "skipped");
      assertEquals(secondItem.reason_code, "SOURCE_JUDGING");
      assertEquals(secondItem.attempt_id, null);

      // 只有获胜者创建了尝试；源的活动指针未被后来者覆盖
      const attempts = await db.select().from(evaluationAttempts).where(
        eq(evaluationAttempts.submission_id, submissionId),
      );
      assertEquals(attempts.length, 1);
      assertEquals(attempts[0].id, winningAttempt);
      const [source] = await db.select().from(submissions).where(
        eq(submissions.id, submissionId),
      );
      assertEquals(source.active_attempt_id, winningAttempt);
      // 源已进入 judging（获胜尝试在跑）→ 后到条目不阻塞整批任务
      assertEquals(source.status, "judging");

      // 获胜尝试结束后，被跳过的条目可以重试（skipped 可重试）
      await applyAttemptResult({
        attemptId: winningAttempt,
        resultKind: "graded",
        resultStatus: "finished",
        score: 10000,
        accepted: true,
      });
      const [afterSource] = await db.select().from(submissions).where(
        eq(submissions.id, submissionId),
      );
      assertEquals(afterSource.active_attempt_id, null);
      // 重新领取（preparing + 有效租约）后才能再次派发
      await db.update(submissionJobItems).set({
        status: "preparing",
        lease_owner: "sk-w3",
        lease_until: new Date(Date.now() + 60_000).toISOString(),
        reason_code: null,
        reason_message: null,
      }).where(eq(submissionJobItems.id, second.item.id));
      assertEquals(
        await dispatchJobItem(
          { ...second.item, attempt_id: null },
          "sk-w3",
          "rejudge",
        ),
        "dispatched",
      );
      const [retried] = await db.select().from(submissionJobItems).where(
        eq(submissionJobItems.id, second.item.id),
      );
      assertEquals(retried.status, "dispatched");
      assertEquals(
        (await db.select().from(evaluationAttempts).where(
          eq(evaluationAttempts.submission_id, submissionId),
        )).length,
        2,
      );
      void submissionJobs;
    } finally {
      resetRedisForTest();
      if (prevUrl !== null) Deno.env.set("REDIS_URL", prevUrl);
      else Deno.env.delete("REDIS_URL");
      await fake.stop();
    }
  },
});
