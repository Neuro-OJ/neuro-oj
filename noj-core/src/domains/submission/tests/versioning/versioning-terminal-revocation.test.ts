/**
 * 尝试终态统一吊销 LLM token 的回归（复审问题 3，P1）。
 *
 * 覆盖：
 * - 统一后处理 `revokeAttemptLlmTokens` 的 TTL 推导：必须覆盖该尝试**全部已签发
 *   token 的剩余有效期**（长寿命 token > 1h 时标记不得先过期）；
 * - job-worker 的终态路径（重试耗尽、直提永久失败）都写吊销标记；
 * - sweeper 的永久恢复失败路径同样吊销；
 * - "MQ 实际收到消息但调用方未拿到响应" 后条目被终结 → 仍吊销同一尝试。
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
import {
  claimJobItems,
  completeJobItem,
  LLM_REVOCATION_MIN_TTL_SECONDS,
  LLM_REVOCATION_TTL_MARGIN_SECONDS,
  resolveAttemptTokenTtlSeconds,
  revokeAttemptLlmTokens,
  scheduleDispatchRetryOrFail,
} from "../../services/versioning/job-worker.ts";
import { dispatchJobItem } from "../../services/versioning/dispatch-job-item.ts";
import { acceptRejudgeJob } from "../../services/versioning/rejudge-jobs.ts";
import { recoverPendingSubmissions } from "../../mq/sweeper.ts";
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

/** 长寿命 token：evaluator 时限 1h → 签发 TTL 14400s，远超固定的 3600s。 */
const LONG_TIME_LIMIT_MS = 3_600_000;

function dualConfig(timeLimitMs: number) {
  return {
    evaluator: {
      image: "noj-evaluator-python",
      command: "python3 /workspace/evaluate.py",
      time_limit_ms: timeLimitMs,
      memory_limit_mb: 512,
    },
    solution: {
      image: "noj-solution-python",
      call_timeout_ms: 2000,
      memory_limit_mb: 512,
    },
  };
}

async function makeUser(tag: string): Promise<string> {
  const id = `rev-user-${tag}-${ts}`;
  await db.insert(users).values({
    id,
    username: `rev-${tag}-${ts}`,
    email: `rev-${tag}-${ts}@test.noj`,
    password_hash: "hash",
    created_at: now,
    updated_at: now,
  });
  return id;
}

/** 建题 + V1（runtime_config 时限可配置）。 */
async function seedProblem(
  tag: string,
  timeLimitMs = 1111,
): Promise<{ problemId: string; versionId: string }> {
  const problemId = `rev-prob-${tag}-${ts}`;
  const versionId = `rev-v1-${tag}-${ts}`;
  await db.insert(problems).values({
    id: problemId,
    title: `吊销测试题 ${tag}`,
    description: "d",
    difficulty: "easy",
    type: "P",
    number: 96200 + Math.floor(Math.random() * 700),
    owner_id: "0",
    judge_type: "dual",
    runtime_config: dualConfig(timeLimitMs),
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
      title: `吊销测试题 ${tag}`,
      description: "d",
      samples: [],
      submission_mode: "code",
      runtime_config: dualConfig(timeLimitMs),
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

/** 受理 latest 目标重测任务并返回条目 id。 */
async function acceptAndClaim(
  actor: string,
  submissionId: string,
): Promise<{ jobId: string; itemId: string }> {
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
    `rev-key-${crypto.randomUUID()}`,
  );
  const [item] = (await claimJobItems("rev-worker", { limit: 100 })).filter(
    (row) => row.job_id === accepted.job_id,
  );
  return { jobId: accepted.job_id, itemId: item.id };
}

async function loadItem(itemId: string) {
  const [item] = await db.select().from(submissionJobItems).where(
    eq(submissionJobItems.id, itemId),
  );
  return item;
}

Deno.test("revoke#3: TTL 覆盖长寿命 token（> 1h），不是固定 3600s", () => {
  // 无快照 / 短时限：退化为 1h 下限 + 余量
  assertEquals(
    resolveAttemptTokenTtlSeconds(null),
    LLM_REVOCATION_MIN_TTL_SECONDS + LLM_REVOCATION_TTL_MARGIN_SECONDS,
  );
  assertEquals(
    resolveAttemptTokenTtlSeconds({
      runtime_config: { evaluator: { time_limit_ms: 1000 } },
    }),
    LLM_REVOCATION_MIN_TTL_SECONDS + LLM_REVOCATION_TTL_MARGIN_SECONDS,
  );
  // 1h 时限 → 签发 TTL = max(60, ceil(3600000*4/1000)) = 14400s
  const longTtl = resolveAttemptTokenTtlSeconds({
    runtime_config: { evaluator: { time_limit_ms: LONG_TIME_LIMIT_MS } },
  });
  assertEquals(longTtl, 14400 + LLM_REVOCATION_TTL_MARGIN_SECONDS);
  assertEquals(longTtl > LLM_REVOCATION_MIN_TTL_SECONDS, true);
});

Deno.test({
  name: "revoke#3: 吊销标记按尝试写入且 TTL 由快照推导（长 token 场景）",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const fake = startFakeRedis();
    const prevUrl = Deno.env.get("REDIS_URL") ?? null;
    try {
      resetRedisForTest();
      Deno.env.set("REDIS_URL", fake.url);
      await getRedis().connect();

      const attemptId = `rev-attempt-${ts}`;
      const outcome = await revokeAttemptLlmTokens({
        attemptId,
        submissionId: `rev-sub-${ts}`,
        taskSnapshot: {
          runtime_config: { evaluator: { time_limit_ms: LONG_TIME_LIMIT_MS } },
        },
      });
      assertEquals(outcome.applied, true);
      assertEquals(
        outcome.ttl_seconds,
        14400 + LLM_REVOCATION_TTL_MARGIN_SECONDS,
      );
      assertEquals(
        await getRedis().get(`llm:attempt:revoked:${attemptId}`),
        "1",
      );
      assertEquals(
        await getRedis().get(`llm:token:revoked:rev-sub-${ts}`),
        "1",
      );

      // 快照缺省时按 attemptId 查库推导（库中并无该尝试 → 退回下限）
      const fallback = await revokeAttemptLlmTokens({ attemptId: "missing" });
      assertEquals(
        fallback.ttl_seconds,
        LLM_REVOCATION_MIN_TTL_SECONDS + LLM_REVOCATION_TTL_MARGIN_SECONDS,
      );
    } finally {
      resetRedisForTest();
      if (prevUrl !== null) Deno.env.set("REDIS_URL", prevUrl);
      else Deno.env.delete("REDIS_URL");
      await fake.stop();
    }
  },
});

Deno.test({
  name: "revoke#3: 重试耗尽（job-worker 永久失败）后吊销尝试 token",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const fake = startFakeRedis();
    const prevUrl = Deno.env.get("REDIS_URL") ?? null;
    try {
      resetRedisForTest();
      Deno.env.set("REDIS_URL", fake.url);
      await getRedis().connect();

      const actor = await makeUser("exhaust");
      const { problemId, versionId } = await seedProblem("exhaust");
      const submissionId = await seedSubmission(problemId, actor, versionId);
      const { itemId } = await acceptAndClaim(actor, submissionId);

      // 手工挂一个 queued 尝试（等价于派发已创建尝试、随后派发失败待重试）
      const attemptId = `rev-exhaust-attempt-${ts}`;
      await db.insert(evaluationAttempts).values({
        id: attemptId,
        submission_id: submissionId,
        problem_id: problemId,
        problem_version_id: versionId,
        sequence: 0,
        source: "rejudge",
        state: "queued",
        task_snapshot: {
          runtime_config: dualConfig(LONG_TIME_LIMIT_MS),
        },
        created_at: now,
      });
      await db.update(submissions).set({
        active_attempt_id: attemptId,
        status: "pending",
      }).where(eq(submissions.id, submissionId));
      await db.update(submissionJobItems).set({ attempt_id: attemptId }).where(
        eq(submissionJobItems.id, itemId),
      );

      const owner = (await loadItem(itemId)).lease_owner as string;
      // 前 5 轮退避，第 6 轮耗尽 → 条目 failed + 尝试 platform_error
      for (let round = 0; round < 6; round++) {
        // 每轮恢复"本 worker 持有有效租约"的 preparing 状态
        // （等价于退避到期后被同一 worker 重新领取）
        await db.update(submissionJobItems).set({
          status: "preparing",
          lease_owner: owner,
          lease_until: new Date(Date.now() + 60_000).toISOString(),
        }).where(eq(submissionJobItems.id, itemId));
        const requeued = await scheduleDispatchRetryOrFail(itemId, {
          leaseOwner: owner,
          reasonCode: "DISPATCH_FAILED",
          reasonMessage: "模拟网络派发失败",
        });
        assertEquals(requeued, round < 5);
      }

      const item = await loadItem(itemId);
      assertEquals(item.status, "failed");
      const [attempt] = await db.select().from(evaluationAttempts).where(
        eq(evaluationAttempts.id, attemptId),
      );
      assertEquals(attempt.state, "error");
      assertEquals(attempt.result_kind, "platform_error");
      // 统一吊销后处理：尝试终态后必须写标记
      assertEquals(
        await getRedis().get(`llm:attempt:revoked:${attemptId}`),
        "1",
      );
      assertEquals(
        await getRedis().get(`llm:token:revoked:${submissionId}`),
        "1",
      );
    } finally {
      resetRedisForTest();
      if (prevUrl !== null) Deno.env.set("REDIS_URL", prevUrl);
      else Deno.env.delete("REDIS_URL");
      await fake.stop();
    }
  },
});

Deno.test({
  name: "revoke#3: 直提永久失败（completeJobItem）也吊销尝试 token",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const fake = startFakeRedis();
    const prevUrl = Deno.env.get("REDIS_URL") ?? null;
    try {
      resetRedisForTest();
      Deno.env.set("REDIS_URL", fake.url);
      await getRedis().connect();

      const actor = await makeUser("direct");
      const { problemId, versionId } = await seedProblem("direct");
      const submissionId = await seedSubmission(problemId, actor, versionId);
      const { itemId } = await acceptAndClaim(actor, submissionId);

      const attemptId = `rev-direct-attempt-${ts}`;
      await db.insert(evaluationAttempts).values({
        id: attemptId,
        submission_id: submissionId,
        problem_id: problemId,
        problem_version_id: versionId,
        sequence: 0,
        source: "rejudge",
        state: "queued",
        task_snapshot: { runtime_config: dualConfig(1000) },
        created_at: now,
      });
      await db.update(submissions).set({
        active_attempt_id: attemptId,
        status: "pending",
      }).where(eq(submissions.id, submissionId));
      await db.update(submissionJobItems).set({ attempt_id: attemptId }).where(
        eq(submissionJobItems.id, itemId),
      );

      const owner = (await loadItem(itemId)).lease_owner as string;
      assertEquals(
        await completeJobItem(itemId, {
          leaseOwner: owner,
          status: "failed",
          attemptId,
          reasonCode: "DISPATCH_PERMANENT_FAILURE",
          reasonMessage: "消息超过大小限制",
        }),
        true,
      );
      assertEquals((await loadItem(itemId)).status, "failed");
      assertEquals(
        await getRedis().get(`llm:attempt:revoked:${attemptId}`),
        "1",
      );
    } finally {
      resetRedisForTest();
      if (prevUrl !== null) Deno.env.set("REDIS_URL", prevUrl);
      else Deno.env.delete("REDIS_URL");
      await fake.stop();
    }
  },
});

Deno.test({
  name: "revoke#3: 派发响应丢失（MQ 已收到消息）后终结仍吊销同一尝试",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const fake = startFakeRedis();
    const prevUrl = Deno.env.get("REDIS_URL") ?? null;
    try {
      resetRedisForTest();
      Deno.env.set("REDIS_URL", fake.url);
      await getRedis().connect();

      const actor = await makeUser("lost");
      const { problemId, versionId } = await seedProblem("lost");
      const submissionId = await seedSubmission(problemId, actor, versionId);
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
        `rev-lost-key-${ts}`,
      );
      const [claimed] = (await claimJobItems("rev-lost-worker", { limit: 100 }))
        .filter((row) => row.job_id === accepted.job_id);

      // 第一次派发成功：MQ 确实收到了消息
      assertEquals(
        await dispatchJobItem(claimed, "rev-lost-worker", "rejudge"),
        "dispatched",
      );
      const item = await loadItem(claimed.id);
      const attemptId = item.attempt_id as string;
      assertEquals(typeof attemptId, "string");
      assertEquals(
        fake.getMessages("noj:judge:queue:ai:low").length > 0,
        true,
        "MQ 应已收到评测消息",
      );
      // 此时尚未终结 → 不应有吊销标记
      assertEquals(
        await getRedis().get(`llm:attempt:revoked:${attemptId}`),
        null,
      );

      // 模拟"调用方未拿到响应"：条目仍停在 preparing，随后被永久失败终结
      await db.update(submissionJobItems).set({
        status: "preparing",
        lease_owner: "rev-lost-worker",
        lease_until: new Date(Date.now() + 60_000).toISOString(),
      }).where(eq(submissionJobItems.id, claimed.id));
      assertEquals(
        await completeJobItem(claimed.id, {
          leaseOwner: "rev-lost-worker",
          status: "failed",
          attemptId,
          reasonCode: "DISPATCH_PERMANENT_FAILURE",
          reasonMessage: "派发响应丢失后永久失败",
        }),
        true,
      );
      // 终结即吊销：同一尝试的 token 不再可用
      assertEquals(
        await getRedis().get(`llm:attempt:revoked:${attemptId}`),
        "1",
      );
    } finally {
      resetRedisForTest();
      if (prevUrl !== null) Deno.env.set("REDIS_URL", prevUrl);
      else Deno.env.delete("REDIS_URL");
      await fake.stop();
    }
  },
});

Deno.test({
  name: "revoke#3: sweeper 永久恢复失败后吊销尝试 token",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const fake = startFakeRedis();
    const prevUrl = Deno.env.get("REDIS_URL") ?? null;
    try {
      resetRedisForTest();
      Deno.env.set("REDIS_URL", fake.url);
      await getRedis().connect();

      const actor = await makeUser("sweep");
      const { problemId, versionId } = await seedProblem("sweep");
      // pending 且已超过恢复阈值；活动尝试缺少绑定版本 → 永久恢复失败
      const submissionId = crypto.randomUUID();
      const attemptId = `rev-sweep-attempt-${ts}`;
      await db.insert(submissions).values({
        id: submissionId,
        user_id: actor,
        problem_id: problemId,
        status: "pending",
        language: "python3",
        code: "print(1)",
        submitted_version_id: versionId,
        version_origin: "known",
        created_at: new Date(Date.now() - 10 * 60_000).toISOString(),
      });
      await db.insert(evaluationAttempts).values({
        id: attemptId,
        submission_id: submissionId,
        problem_id: problemId,
        problem_version_id: null,
        sequence: 0,
        source: "rejudge",
        state: "queued",
        task_snapshot: { runtime_config: dualConfig(LONG_TIME_LIMIT_MS) },
        created_at: now,
      });
      await db.update(submissions).set({ active_attempt_id: attemptId }).where(
        eq(submissions.id, submissionId),
      );

      await recoverPendingSubmissions(Date.now());

      const [attempt] = await db.select().from(evaluationAttempts).where(
        eq(evaluationAttempts.id, attemptId),
      );
      assertEquals(attempt.state, "error");
      const [row] = await db.select().from(submissions).where(
        eq(submissions.id, submissionId),
      );
      assertEquals(row.status, "error");
      // 崩溃恢复被永久判失败同样必须吊销
      assertEquals(
        await getRedis().get(`llm:attempt:revoked:${attemptId}`),
        "1",
      );
    } finally {
      resetRedisForTest();
      if (prevUrl !== null) Deno.env.set("REDIS_URL", prevUrl);
      else Deno.env.delete("REDIS_URL");
      await fake.stop();
    }
  },
});
