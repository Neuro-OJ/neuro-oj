import { authorizeLegacyJobActorForTest } from "../_versioning-fixtures.ts";
import { DEFAULT_DOMAIN_ID } from "../../../workspace/index.ts";
/**
 * 升级副本的统计 revision 与额度回归（复审问题 6、9，P2）。
 *
 * - #6：升级副本**首次插入的同一事务**内递增 problem / contest / global 的
 *   实际提交数 revision（与普通提交入口同口径）；复用已有副本（重派/重试）
 *   不得重复递增。
 * - #9：升级副本占用**原用户**正常提交额度；额度不足（Redis 不可用 → fail-closed）
 *   时条目**延期**（不发新提交、可重试、不计失败），重派只扣一次。
 */
import { assertEquals } from "jsr:@std/assert@^1";
import { and, eq } from "drizzle-orm";
import { getDb } from "../../../../shared/db/connection.ts";
import {
  contestParticipants,
  contests,
  evaluationAttempts,
  judgeImages,
  problems,
  problemVersions,
  queryProjectionRevisions,
  submissionJobItems,
  submissions,
  users,
} from "../../../../shared/db/schema.ts";
import {
  contestScopeKey,
  globalScopeKey,
  problemScopeKey,
} from "../../services/versioning/projection.ts";
import { claimJobItems } from "../../services/versioning/job-worker.ts";
import { dispatchJobItem } from "../../services/versioning/dispatch-job-item.ts";
import { acceptUpgradeJob } from "../../services/versioning/upgrade-jobs.ts";
import {
  getRedis,
  resetRedisForTest,
} from "../../../../shared/mq/connection.ts";
import { startFakeRedis } from "../mq/_setup.ts";
import { insertContestProblems } from "../../../../../tests/helper.ts";

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
  const id = `uq-user-${tag}-${ts}`;
  await db.insert(users).values({
    id,
    username: `uq-${tag}-${ts}`,
    email: `uq-${tag}-${ts}@test.noj`,
    password_hash: "hash",
    created_at: now,
    updated_at: now,
  });
  await authorizeLegacyJobActorForTest(id);
  return id;
}

async function seedProblem(
  tag: string,
): Promise<{ problemId: string; v1: string; v2: string }> {
  const problemId = `uq-prob-${tag}-${ts}`;
  const v1 = `uq-v1-${tag}-${ts}`;
  const v2 = `uq-v2-${tag}-${ts}`;
  await db.insert(problems).values({
    id: problemId,
    title: `升级副本测试题 ${tag}`,
    description: "d",
    difficulty: "easy",
    number: 95900 + Math.floor(Math.random() * 900),
    owner_id: "0",
    judge_type: "dual",
    runtime_config: dualConfig,
    created_at: now,
    updated_at: now,
  });
  const content = (title: string) => ({
    kind: "ai",
    title,
    description: "d",
    samples: [],
    submission_mode: "code",
    runtime_config: dualConfig,
    template_content: "",
    artifact_max_size_mb: null,
    llm_config: null,
  });
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

/** 读取某作用域的 data_revision（无行视为 0）。 */
async function revisionOf(scopeKey: string): Promise<number> {
  const [row] = await db.select().from(queryProjectionRevisions).where(
    eq(queryProjectionRevisions.scope_key, scopeKey),
  );
  return row?.data_revision ?? 0;
}

async function loadItem(jobId: string) {
  const [item] = await db.select().from(submissionJobItems).where(
    eq(submissionJobItems.job_id, jobId),
  );
  return item;
}

/**
 * 把已派发条目恢复为可重新领取（等价于退避到期后的下一轮领取）：
 * `claimJobItems` 只会领取 `pending` 或 **lease 已过期**的 `preparing`，
 * 因此这里回到 `pending` + 清租约，由领取过程重新写 preparing/lease。
 */
async function makeClaimable(itemId: string): Promise<void> {
  await db.update(submissionJobItems).set({
    status: "pending",
    lease_owner: null,
    lease_until: null,
    next_dispatch_at: null,
  }).where(eq(submissionJobItems.id, itemId));
}

/** 在假 Redis 中领取并派发某升级任务的第一条条目。 */
async function dispatchUpgradeItem(
  jobId: string,
  owner: string,
): Promise<string> {
  const items = (await claimJobItems(owner, { limit: 100 })).filter(
    (item) => item.job_id === jobId,
  );
  assertEquals(items.length, 1);
  return await dispatchJobItem(items[0], owner, "upgrade", "practice");
}

Deno.test({
  name: "revision#6: 升级副本首次创建递增 problem/global，复用不重复递增",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const fake = startFakeRedis();
    const prevUrl = Deno.env.get("REDIS_URL") ?? null;
    try {
      resetRedisForTest();
      Deno.env.set("REDIS_URL", fake.url);
      await getRedis().connect();

      const actor = await makeUser("rev");
      const { problemId, v1, v2 } = await seedProblem("rev");
      const submissionId = await seedSubmission(problemId, actor, v1);
      const accepted = await acceptUpgradeJob(
        actor,
        {
          submissions: [{ kind: "submission", id: submissionId }],
          context: "practice",
        },
        `uq-rev-key-${ts}`,
      );

      const problemKey = problemScopeKey(problemId);
      const globalKey = globalScopeKey();
      const before = {
        problem: await revisionOf(problemKey),
        global: await revisionOf(globalKey),
      };

      assertEquals(
        await dispatchUpgradeItem(accepted.job_id, "uq-w1"),
        "dispatched",
      );
      const item = await loadItem(accepted.job_id);
      const copyId = item.result_submission_id as string;
      assertEquals(typeof copyId, "string");

      // 首次创建副本的同一事务内三个作用域都递增（practice → 无竞赛维度）
      assertEquals(await revisionOf(problemKey), before.problem + 1);
      assertEquals(await revisionOf(globalKey), before.global + 1);
      const afterFirst = {
        problem: await revisionOf(problemKey),
        global: await revisionOf(globalKey),
      };

      // 重派（复用既有副本与尝试）→ 不再递增
      await makeClaimable(item.id);
      assertEquals(
        await dispatchUpgradeItem(accepted.job_id, "uq-w2"),
        "dispatched",
      );
      const reused = await loadItem(accepted.job_id);
      assertEquals(reused.result_submission_id, copyId);
      assertEquals(reused.attempt_id, item.attempt_id);
      assertEquals(await revisionOf(problemKey), afterFirst.problem);
      assertEquals(await revisionOf(globalKey), afterFirst.global);
      // 只有一份副本、一个升级尝试
      assertEquals(
        (await db.select().from(submissions).where(
          eq(submissions.upgraded_from_id, submissionId),
        )).length,
        1,
      );
      const attempts = await db.select().from(evaluationAttempts).where(
        and(
          eq(evaluationAttempts.submission_id, copyId),
          eq(evaluationAttempts.source, "upgrade"),
        ),
      );
      assertEquals(attempts.length, 1);
      assertEquals(attempts[0].sequence, 0);
      void v2;
    } finally {
      resetRedisForTest();
      if (prevUrl !== null) Deno.env.set("REDIS_URL", prevUrl);
      else Deno.env.delete("REDIS_URL");
      await fake.stop();
    }
  },
});

Deno.test({
  name: "revision#6: source_contest 升级副本同时递增竞赛作用域",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const fake = startFakeRedis();
    const prevUrl = Deno.env.get("REDIS_URL") ?? null;
    try {
      resetRedisForTest();
      Deno.env.set("REDIS_URL", fake.url);
      await getRedis().connect();

      const actor = await makeUser("contest");
      const { problemId, v1, v2 } = await seedProblem("contest");
      const contestId = `uq-contest-${ts}`;
      await db.insert(contests).values({
        id: contestId,
        domain_id: DEFAULT_DOMAIN_ID,
        created_by: actor,
        public_id: `uq-ct-${ts}`,
        title: "c",
        start_time: "2026-01-01T00:00:00.000Z",
        end_time: "2026-12-31T00:00:00.000Z",
        type: "kaggle",
        kind: "public",
        is_public: true,
        created_at: now,
        updated_at: now,
      });
      // 竞赛固定作答版本 = 最新版（#43 要求相等才可升级）
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
        user_id: actor,
        registered_at: now,
      });
      const submissionId = await seedSubmission(
        problemId,
        actor,
        v1,
        contestId,
      );
      const accepted = await acceptUpgradeJob(
        actor,
        {
          submissions: [{ kind: "submission", id: submissionId }],
          context: "source_contest",
        },
        `uq-contest-key-${ts}`,
      );

      const keys = {
        problem: problemScopeKey(problemId),
        contest: contestScopeKey(contestId),
        global: globalScopeKey(),
      };
      const before = {
        problem: await revisionOf(keys.problem),
        contest: await revisionOf(keys.contest),
        global: await revisionOf(keys.global),
      };

      const items = (await claimJobItems("uq-c1", { limit: 100 })).filter(
        (item) => item.job_id === accepted.job_id,
      );
      assertEquals(
        await dispatchJobItem(items[0], "uq-c1", "upgrade", "source_contest"),
        "dispatched",
      );
      assertEquals(await revisionOf(keys.problem), before.problem + 1);
      assertEquals(await revisionOf(keys.contest), before.contest + 1);
      assertEquals(await revisionOf(keys.global), before.global + 1);
      // 竞赛副本保留竞赛上下文
      const item = await loadItem(accepted.job_id);
      const [copy] = await db.select().from(submissions).where(
        eq(submissions.id, item.result_submission_id as string),
      );
      assertEquals(copy.contest_id, contestId);
      assertEquals(copy.submitted_version_id, v2);
    } finally {
      resetRedisForTest();
      if (prevUrl !== null) Deno.env.set("REDIS_URL", prevUrl);
      else Deno.env.delete("REDIS_URL");
      await fake.stop();
    }
  },
});

Deno.test({
  name:
    "quota#9: 额度不足/不可用 → 条目延期、不发新提交、不建尝试；恢复后可重试",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const prevUrl = Deno.env.get("REDIS_URL") ?? null;
    // 第一段：**注入**额度消费者返回 fail-closed 信号（等价于 Redis/Lua 不可用）。
    // 为什么用注入而不是让 fake Redis 的 EVAL 报错：额度实现只访问 Redis，而
    // `REDIS_URL` 是**进程级**环境变量、同分片测试文件并行执行——伪造一个"EVAL 失败"
    // 的 URL 会让并行文件的额度调用一起 fail-closed，从而把它们的正常升级派发
    // 误判成延期（实测整目录 8 failed）。注入点让本条用例零全局污染。
    const fake = startFakeRedis();
    try {
      resetRedisForTest();
      Deno.env.set("REDIS_URL", fake.url);
      await getRedis().connect();
      const actor = await makeUser("quota");
      const { problemId, v1, v2 } = await seedProblem("quota");
      const submissionId = await seedSubmission(problemId, actor, v1);
      const accepted = await acceptUpgradeJob(
        actor,
        {
          submissions: [{ kind: "submission", id: submissionId }],
          context: "practice",
        },
        `uq-quota-key-${ts}`,
      );
      const [claimed] = (await claimJobItems("uq-q1", { limit: 100 })).filter(
        (item) => item.job_id === accepted.job_id,
      );

      // 记录注入消费者的入参：必须是**原用户**与 job item id（幂等标识）
      const seen: Array<{ userId: string; itemId: string }> = [];
      const outcome = await dispatchJobItem(
        claimed,
        "uq-q1",
        "upgrade",
        "practice",
        (userId, itemId) => {
          seen.push({ userId, itemId });
          return Promise.resolve({ ok: false, retryAfterMs: 5_000 });
        },
      );
      assertEquals(outcome, "deferred");
      assertEquals(seen, [{ userId: actor, itemId: claimed.id }]);

      const item = await loadItem(accepted.job_id);
      assertEquals(item.status, "pending");
      assertEquals(item.attempt_id, null);
      assertEquals(item.result_submission_id, null);
      assertEquals(typeof item.next_dispatch_at, "string");
      // 未发新提交、未建尝试（额度不足时整个事务回滚）
      assertEquals(
        (await db.select().from(submissions).where(
          eq(submissions.upgraded_from_id, submissionId),
        )).length,
        0,
      );
      assertEquals(
        (await db.select().from(evaluationAttempts).where(
          eq(evaluationAttempts.submission_id, submissionId),
        )).filter((row) => row.source === "upgrade").length,
        0,
      );

      // 第二段：走**真实**额度实现（默认消费者）→ 正常派发且只有一份副本
      await db.update(submissionJobItems).set({ next_dispatch_at: null })
        .where(eq(submissionJobItems.id, item.id));
      assertEquals(
        await dispatchUpgradeItem(accepted.job_id, "uq-q2"),
        "dispatched",
      );
      const done = await loadItem(accepted.job_id);
      assertEquals(done.status, "dispatched");
      assertEquals(
        (await db.select().from(submissions).where(
          eq(submissions.upgraded_from_id, submissionId),
        )).length,
        1,
      );
      // 注：`NOJ_ENV=test` 下限流总开关关闭，真实消费者按文档语义直接放行
      // （不写幂等占位、不依赖 Redis 可用性）；额度计数与「重派只扣一次」的
      // 幂等语义由 task-10 的额度实现自身用例覆盖。
      void v2;
    } finally {
      // 先恢复全局 env / 单例，再停止 fake：避免"env 仍指向已停止服务器"的窗口
      // 被并行测试文件的 Redis 调用读到（ECONNREFUSED → 额度 fail-closed）。
      resetRedisForTest();
      if (prevUrl !== null) Deno.env.set("REDIS_URL", prevUrl);
      else Deno.env.delete("REDIS_URL");
      await fake.stop();
    }
  },
});
