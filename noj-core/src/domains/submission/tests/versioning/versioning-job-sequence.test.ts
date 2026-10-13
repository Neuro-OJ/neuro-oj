import { authorizeLegacyJobActorForTest } from "../_versioning-fixtures.ts";
/**
 * 批任务 sequence 一致性的回归（第三轮复审问题 1，P1）。
 *
 * 缺陷：预检阶段用 `nextAttemptSequence()` 冻结 sequence，而落库时
 * `createAttempt` 取 `max(MAX(尝试)+1, 源行 rejudge_seq)`。对**存量
 * `legacy_unknown` 提交**（无尝试行但 `rejudge_seq=7`）两者不一致：落库 7、
 * 任务封套 0 → 结果回写因 sequence 不匹配被静默丢弃（提交卡 judging、活动尝试不清）。
 *
 * 修复后 sequence 只在**源提交行锁内**统一分配，任务封套一律使用**落库返回的**
 * `attempt.sequence`。
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
import { claimJobItems } from "../../services/versioning/job-worker.ts";
import { dispatchJobItem } from "../../services/versioning/dispatch-job-item.ts";
import { acceptLegacyRejudgeJobForTest as acceptRejudgeJob } from "../_versioning-fixtures.ts";
import {
  getRedis,
  resetRedisForTest,
} from "../../../../shared/mq/connection.ts";
import { startFakeRedis } from "../mq/_setup.ts";

const now = new Date().toISOString();
const db = getDb();
const ts = Date.now();

// 真实 PG（独立 schema）不含 PGlite 的 root 与镜像种子
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

async function makeUser(tag: string): Promise<string> {
  const id = `sq-user-${tag}-${ts}`;
  await db.insert(users).values({
    id,
    username: `sq-${tag}-${ts}`,
    email: `sq-${tag}-${ts}@test.noj`,
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
  const problemId = `sq-prob-${tag}-${ts}`;
  const versionId = `sq-v1-${tag}-${ts}`;
  await db.insert(problems).values({
    id: problemId,
    title: `sequence 测试题 ${tag}`,
    description: "d",
    difficulty: "easy",
    type: "P",
    number: 93100 + Math.floor(Math.random() * 900),
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
      title: `sequence 测试题 ${tag}`,
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

/** 建存量 `legacy_unknown` 提交：无尝试行，但源行带较大的 rejudge_seq。 */
async function seedLegacySubmission(
  problemId: string,
  userId: string,
  rejudgeSeq: number,
): Promise<string> {
  const id = crypto.randomUUID();
  await db.insert(submissions).values({
    id,
    user_id: userId,
    problem_id: problemId,
    status: "finished",
    language: "python3",
    code: "print(1)",
    submitted_version_id: null,
    version_origin: "legacy_unknown",
    rejudge_seq: rejudgeSeq,
    created_at: now,
  });
  return id;
}

/** 在假 Redis 内派发某任务的条目，返回推送出去的评测任务与结论。 */
async function dispatchClaimed(
  jobId: string,
  owner: string,
): Promise<{
  outcome: string;
  task: Record<string, unknown>;
  itemId: string;
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
    const outcome = await dispatchJobItem(item, owner, "rejudge");
    const messages: Record<string, unknown>[] = [];
    for (
      const queue of [
        "noj:judge:queue:ai:low",
        "noj:judge:queue:ai:medium",
        "noj:judge:queue:oi-native:medium",
      ]
    ) {
      for (const raw of fake.getMessages(queue)) {
        messages.push(JSON.parse(raw) as Record<string, unknown>);
      }
    }
    assertEquals(messages.length, 1);
    return { outcome, task: messages[0], itemId: item.id };
  } finally {
    resetRedisForTest();
    if (prevUrl !== null) Deno.env.set("REDIS_URL", prevUrl);
    else Deno.env.delete("REDIS_URL");
    await fake.stop();
  }
}

/** 直接派发一个已组装好的条目（用于"重派"场景，绕过领取条件）。 */
async function dispatchClaimedItem(
  item: Parameters<typeof dispatchJobItem>[0],
  owner: string,
): Promise<{ outcome: string; task: Record<string, unknown> }> {
  const fake = startFakeRedis();
  const prevUrl = Deno.env.get("REDIS_URL") ?? null;
  try {
    resetRedisForTest();
    Deno.env.set("REDIS_URL", fake.url);
    await getRedis().connect();
    const outcome = await dispatchJobItem(item, owner, "rejudge");
    const messages: Record<string, unknown>[] = [];
    for (
      const queue of [
        "noj:judge:queue:ai:low",
        "noj:judge:queue:ai:medium",
        "noj:judge:queue:oi-native:medium",
      ]
    ) {
      for (const raw of fake.getMessages(queue)) {
        messages.push(JSON.parse(raw) as Record<string, unknown>);
      }
    }
    assertEquals(messages.length, 1);
    return { outcome, task: messages[0] };
  } finally {
    resetRedisForTest();
    if (prevUrl !== null) Deno.env.set("REDIS_URL", prevUrl);
    else Deno.env.delete("REDIS_URL");
    await fake.stop();
  }
}

Deno.test({
  name: "sequence#1: 存量 rejudge_seq=7 无尝试行 → 落库与任务封套同为 7",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const actor = await makeUser("legacy");
    const { problemId, versionId } = await seedProblem("legacy");
    const submissionId = await seedLegacySubmission(problemId, actor, 7);
    const accepted = await acceptRejudgeJob(
      actor,
      {
        kind: "rejudge",
        scope: {
          type: "selected",
          submissions: [{ kind: "submission", id: submissionId }],
        },
        // 指定版本重测：存量提交没有提交时版本，必须显式给目标版本
        target: { mode: "specified", versions: { [problemId]: versionId } },
      },
      `sq-key-${ts}`,
    );

    const { outcome, task } = await dispatchClaimed(accepted.job_id, "sq-w1");
    assertEquals(outcome, "dispatched");
    const attempts = await db.select().from(evaluationAttempts).where(
      eq(evaluationAttempts.submission_id, submissionId),
    );
    assertEquals(attempts.length, 1);
    // 落库 sequence 取 max(MAX(尝试)+1, 源行 7) = 7
    assertEquals(attempts[0].sequence, 7);
    // **任务封套必须与落库一致**（缺陷前这里是 0 → 结果被静默丢弃）
    assertEquals(task.rejudge_seq, 7);
    assertEquals(task.run_id, attempts[0].id);
    const [source] = await db.select().from(submissions).where(
      eq(submissions.id, submissionId),
    );
    assertEquals(source.rejudge_seq, 7);
    assertEquals(source.active_attempt_id, attempts[0].id);
  },
});

Deno.test({
  name: "sequence#1: 重派沿用落库 sequence（封套与尝试一致）",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const actor = await makeUser("reuse");
    const { problemId, versionId } = await seedProblem("reuse");
    const submissionId = await seedLegacySubmission(problemId, actor, 5);
    const accepted = await acceptRejudgeJob(
      actor,
      {
        kind: "rejudge",
        scope: {
          type: "selected",
          submissions: [{ kind: "submission", id: submissionId }],
        },
        target: { mode: "specified", versions: { [problemId]: versionId } },
      },
      `sq-reuse-key-${ts}`,
    );
    const first = await dispatchClaimed(accepted.job_id, "sq-w2");
    assertEquals(first.task.rejudge_seq, 5);

    // 模拟重派（条目仍持有本 worker 的有效租约）：复用同一尝试与 sequence
    await db.update(submissionJobItems).set({
      status: "preparing",
      lease_owner: "sq-w3",
      lease_until: new Date(Date.now() + 60_000).toISOString(),
    }).where(eq(submissionJobItems.id, first.itemId));
    const [row] = await db.select().from(submissionJobItems).where(
      eq(submissionJobItems.id, first.itemId),
    );
    const second = await dispatchClaimedItem({
      id: row.id,
      job_id: row.job_id,
      ordinal: row.ordinal,
      source_kind: row.source_kind,
      source_id: row.source_id,
      problem_id: row.problem_id,
      target_version_id: row.target_version_id,
      target_version_ref: row.target_version_ref,
      dispatch_retries: row.dispatch_retries,
      attempt_id: row.attempt_id,
      result_submission_id: row.result_submission_id,
    }, "sq-w3");
    assertEquals(second.outcome, "dispatched");
    assertEquals(second.task.rejudge_seq, 5);
    assertEquals(second.task.run_id, first.task.run_id);
    const attempts = await db.select().from(evaluationAttempts).where(
      eq(evaluationAttempts.submission_id, submissionId),
    );
    assertEquals(attempts.length, 1);
    assertEquals(attempts[0].sequence, 5);
  },
});
