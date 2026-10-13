import { authorizeLegacyJobActorForTest } from "../_versioning-fixtures.ts";
/**
 * 批任务"预检先于创建尝试"的回归（复审问题 7，P2）与升级额度调用点（#9）。
 *
 * 顺序契约：**预先分配 attempt ID → 支持包存在性 + LLM 服务/模型/预算预检 +
 * 完整非敏感快照 → 再在一个事务内创建副本/尝试/条目**。因此：
 * - Provider 缺配、支持包缺失等永久失败**不得留下尝试行**（也不得留下副本）；
 * - 重派只续签交付凭据，Provider/模型/预算取自既有尝试快照，**不重新解析当前默认**。
 */
import { assertEquals } from "jsr:@std/assert@^1";
import { eq } from "drizzle-orm";
import { getDb } from "../../../../shared/db/connection.ts";
import {
  evaluationAttempts,
  judgeImages,
  problems,
  problemVersionObjects,
  problemVersions,
  storageObjects,
  submissionJobItems,
  submissions,
  users,
} from "../../../../shared/db/schema.ts";
import { getLlmPlatformDefault } from "../../../gateway/index.ts";
import { LocalStorageProvider } from "../../../system/services/storage/local.ts";
import { setStorageProviderForTest } from "../../../system/services/storage/factory.ts";
import { buildStorageUrl } from "../../../system/services/storage/types.ts";
import { claimJobItems } from "../../services/versioning/job-worker.ts";
import { dispatchJobItem } from "../../services/versioning/dispatch-job-item.ts";
import { acceptLegacyRejudgeJobForTest as acceptRejudgeJob } from "../_versioning-fixtures.ts";
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
const tempStorageDir = Deno.makeTempDirSync({ prefix: "noj-preflight-order-" });

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
  const id = `pf-order-user-${tag}-${ts}`;
  await db.insert(users).values({
    id,
    username: `pf-order-${tag}-${ts}`,
    email: `pf-order-${tag}-${ts}@test.noj`,
    password_hash: "hash",
    created_at: now,
    updated_at: now,
  });
  await authorizeLegacyJobActorForTest(id);
  return id;
}

async function seedProblem(
  tag: string,
  options: { llm?: boolean; supportPackageUrl?: string } = {},
): Promise<{ problemId: string; versionId: string }> {
  const problemId = `pf-order-prob-${tag}-${ts}`;
  const versionId = `pf-order-v1-${tag}-${ts}`;
  await db.insert(problems).values({
    id: problemId,
    title: `预检顺序测试题 ${tag}`,
    description: "d",
    difficulty: "easy",
    number: 95400 + Math.floor(Math.random() * 900),
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
      title: `预检顺序测试题 ${tag}`,
      description: "d",
      samples: [],
      submission_mode: "code",
      runtime_config: {
        ...dualConfig,
        // LLM 需要 evaluator 网络
        evaluator: { ...dualConfig.evaluator, network: { enabled: true } },
      },
      template_content: "",
      artifact_max_size_mb: null,
      llm_config: options.llm ? { max_calls: 3, max_tokens: 1000 } : null,
    },
    published_at: now,
  });
  await db.update(problems).set({ latest_version_id: versionId }).where(
    eq(problems.id, problemId),
  );
  if (options.supportPackageUrl) {
    await db.insert(storageObjects).values({
      storage_url: options.supportPackageUrl,
      sha256: null,
      byte_size: 10,
      state: "unknown",
      created_at: now,
    });
    await db.insert(problemVersionObjects).values({
      version_id: versionId,
      role: "support_package",
      path: "package.zip",
      storage_url: options.supportPackageUrl,
    });
  }
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

async function acceptClaimAndDispatch(
  actor: string,
  submissionId: string,
  owner: string,
): Promise<{ itemId: string; outcome: string }> {
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
    `pf-order-key-${crypto.randomUUID()}`,
  );
  const [item] = (await claimJobItems(owner, { limit: 100 })).filter(
    (row) => row.job_id === accepted.job_id,
  );
  const outcome = await dispatchJobItem(item, owner, "rejudge");
  return { itemId: item.id, outcome };
}

async function loadItem(itemId: string) {
  const [item] = await db.select().from(submissionJobItems).where(
    eq(submissionJobItems.id, itemId),
  );
  return item;
}

function withFakeRedis<T>(fn: () => Promise<T>): Promise<T> {
  const fake = startFakeRedis();
  const prevUrl = Deno.env.get("REDIS_URL") ?? null;
  return (async () => {
    try {
      resetRedisForTest();
      Deno.env.set("REDIS_URL", fake.url);
      await getRedis().connect();
      return await fn();
    } finally {
      resetRedisForTest();
      if (prevUrl !== null) Deno.env.set("REDIS_URL", prevUrl);
      else Deno.env.delete("REDIS_URL");
      await fake.stop();
    }
  })();
}

Deno.test({
  name: "preflight#7: Provider 缺配 → 条目 failed，且不留尝试行与副本",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await withFakeRedis(async () => {
      const platformConfigured = getLlmPlatformDefault() !== null;
      const actor = await makeUser("llm");
      const { problemId, versionId } = await seedProblem("llm", { llm: true });
      const submissionId = await seedSubmission(problemId, actor, versionId);

      const { itemId, outcome } = await acceptClaimAndDispatch(
        actor,
        submissionId,
        "pf-order-w1",
      );
      assertEquals(outcome, "failed");
      const item = await loadItem(itemId);
      assertEquals(item.status, "failed");
      assertEquals(item.attempt_id, null);
      if (!platformConfigured) {
        assertEquals(
          item.reason_message?.includes("LLM Provider") ?? false,
          true,
        );
      }
      // 不留尝试行（预检失败发生在创建尝试之前）
      assertEquals(
        (await db.select().from(evaluationAttempts).where(
          eq(evaluationAttempts.submission_id, submissionId),
        )).length,
        0,
      );
      // 源提交的活动指针保持为空、状态未被改成 pending
      const [source] = await db.select().from(submissions).where(
        eq(submissions.id, submissionId),
      );
      assertEquals(source.active_attempt_id, null);
      assertEquals(source.status, "finished");
    });
  },
});

Deno.test({
  name:
    "preflight#7: 支持包缺失 → failed + SUPPORT_PACKAGE_MISSING，不留尝试行",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await withFakeRedis(async () => {
      // 存储对象登记存在但物理对象从未写入 → stat 不存在
      setStorageProviderForTest(new LocalStorageProvider(tempStorageDir));
      const missingUrl = buildStorageUrl("local", `pf-order-missing-${ts}`);
      const actor = await makeUser("pack");
      const { problemId, versionId } = await seedProblem("pack", {
        supportPackageUrl: missingUrl,
      });
      const submissionId = await seedSubmission(problemId, actor, versionId);

      const { itemId, outcome } = await acceptClaimAndDispatch(
        actor,
        submissionId,
        "pf-order-w2",
      );
      assertEquals(outcome, "failed");
      const item = await loadItem(itemId);
      assertEquals(item.status, "failed");
      assertEquals(item.reason_code, "SUPPORT_PACKAGE_MISSING");
      assertEquals(item.attempt_id, null);
      assertEquals(
        (await db.select().from(evaluationAttempts).where(
          eq(evaluationAttempts.submission_id, submissionId),
        )).length,
        0,
      );
    });
  },
});

Deno.test({
  name: "preflight#7: 重派使用快照中的 provider/model，不重新解析当前默认配置",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await withFakeRedis(async () => {
      const platformConfigured = getLlmPlatformDefault() !== null;
      const actor = await makeUser("frozen");
      const { problemId, versionId } = await seedProblem("frozen", {
        llm: true,
      });
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
        `pf-order-frozen-${ts}`,
      );
      const [claimed] = (await claimJobItems("pf-order-w3", { limit: 100 }))
        .filter((row) => row.job_id === accepted.job_id);

      // 预置"已有尝试 + 冻结快照"：重派必须只用快照，不再解析平台默认
      const attemptId = crypto.randomUUID();
      await db.insert(evaluationAttempts).values({
        id: attemptId,
        submission_id: submissionId,
        problem_id: problemId,
        problem_version_id: versionId,
        sequence: 0,
        source: "rejudge",
        state: "queued",
        task_snapshot: {
          runtime_config: dualConfig,
          llm_execution: {
            provider_id: "frozen-provider",
            model: "frozen-model",
            max_calls: 3,
            max_tokens: 1000,
          },
        },
        created_at: now,
      });
      await db.update(submissions).set({
        active_attempt_id: attemptId,
        status: "pending",
      }).where(eq(submissions.id, submissionId));
      await db.update(submissionJobItems).set({ attempt_id: attemptId }).where(
        eq(submissionJobItems.id, claimed.id),
      );

      // 未配置平台默认 Provider 时：若代码重新解析默认配置 → 抛"平台未配置" 400；
      // 用快照路径则会直接走 gateway 查询（错误形态不同）。
      let error: unknown = null;
      try {
        await dispatchJobItem(claimed, "pf-order-w3", "rejudge");
      } catch (err) {
        error = err;
      }
      // 无论 gateway 是否可达，重派都不得新建尝试（复用既有 attempts）
      assertEquals(
        (await db.select().from(evaluationAttempts).where(
          eq(evaluationAttempts.submission_id, submissionId),
        )).length,
        1,
      );
      if (!platformConfigured && error) {
        const message = error instanceof Error ? error.message : String(error);
        assertEquals(
          message.includes("平台未配置默认 LLM Provider") ||
            message.includes("平台默认 LLM Provider"),
          false,
          "已冻结快照的重派不应再抛'平台未配置默认 Provider'",
        );
      }
    });
  },
});
