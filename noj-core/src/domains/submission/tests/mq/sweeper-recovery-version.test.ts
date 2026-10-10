/**
 * pending 恢复的版本来源测试（Handbook §5.4、§6.5）。
 *
 * 恢复**不得**重新读取题目当前投影：题库更新（发布 V2/V3）后，用最新配置重建
 * 旧提交的任务等于拿新版本评测旧提交——配置、语言列表、产物大小限制都会漂移。
 * 正确来源是在途尝试绑定的版本；只有迁移期存量行（没有尝试也没有版本）才回退投影。
 *
 * 同时覆盖产物提交：产物对象保留到提交显式删除，pending 产物提交必须被**恢复**
 * （重新签发下载地址后入队），而不是"超时即删除对象并标记 error"。
 */
import { assertEquals } from "jsr:@std/assert@^1";
import { eq } from "drizzle-orm";
import { getDb } from "../../../../shared/db/connection.ts";
import {
  evaluationAttempts,
  problems,
  problemVersions,
  submissions,
  users,
} from "../../../../shared/db/schema.ts";
import { recoverPendingSubmissions } from "../../mq/sweeper.ts";
import {
  getRedis,
  resetRedisForTest,
} from "../../../../shared/mq/connection.ts";
import {
  getStorageProvider,
  LocalStorageProvider,
  setStorageProviderForTest,
} from "../../../system/index.ts";
import { startFakeRedis } from "./_setup.ts";

const tempStorageDir = Deno.makeTempDirSync({ prefix: "noj-sweeper-" });
setStorageProviderForTest(new LocalStorageProvider(tempStorageDir));

const db = getDb();
const ts = Date.now();
const now = new Date().toISOString();
const oldNow = new Date(Date.now() - 3 * 60_000).toISOString();

/** 题目投影里的配置（V3）：与尝试绑定的 V2 明显不同，便于区分来源。 */
const projectionConfig = {
  evaluator: {
    image: "noj-evaluator-python",
    command: "python3 /workspace/evaluate.py",
    time_limit_ms: 9999,
    memory_limit_mb: 999,
  },
  solution: {
    image: "noj-solution-python",
    call_timeout_ms: 9999,
    memory_limit_mb: 999,
  },
};

/** 尝试绑定版本（V2）里的配置：恢复必须采用这一份。 */
const versionConfig = {
  evaluator: {
    image: "noj-evaluator-python",
    command: "python3 /workspace/evaluate.py",
    time_limit_ms: 1111,
    memory_limit_mb: 111,
  },
  solution: {
    image: "noj-solution-python",
    call_timeout_ms: 1111,
    memory_limit_mb: 111,
  },
};

/** 建用户 + 题目 + 已发布版本，返回 {problemId, versionId}。 */
async function seedProblem(
  tag: string,
  number: number,
  content: Record<string, unknown>,
): Promise<{ problemId: string; versionId: string; userId: string }> {
  const userId = `tst-sweep-user-${tag}-${ts}`;
  const problemId = `tst-sweep-prob-${tag}-${ts}`;
  const versionId = `tst-sweep-ver-${tag}-${ts}`;
  await db.insert(users).values({
    id: userId,
    username: `tstsweep-${tag}-${ts}`,
    email: `tstsweep-${tag}-${ts}@test.noj`,
    password_hash: "hash",
    created_at: now,
    updated_at: now,
  });
  await db.insert(problems).values({
    id: problemId,
    title: `恢复测试题 ${tag}`,
    description: "d",
    difficulty: "easy",
    type: "P",
    number,
    owner_id: userId,
    runtime_config: projectionConfig,
    judge_type: "dual",
    created_at: now,
    updated_at: now,
  });
  await db.insert(problemVersions).values({
    id: versionId,
    problem_id: problemId,
    version: 1,
    origin: "published",
    content,
    published_at: now,
  });
  await db.update(problems).set({ latest_version_id: versionId })
    .where(eq(problems.id, problemId));
  return { problemId, versionId, userId };
}

/** 在假 Redis 环境中执行一次恢复，返回主队列消息（JSON）。 */
async function recoverAndReadMessages(): Promise<Record<string, unknown>[]> {
  const fake = startFakeRedis();
  const prevUrl = Deno.env.get("REDIS_URL") ?? null;
  try {
    resetRedisForTest();
    Deno.env.set("REDIS_URL", fake.url);
    const redis = getRedis();
    await redis.connect();
    await recoverPendingSubmissions(Date.now());
    const messages: Record<string, unknown>[] = [];
    for (
      const queue of [
        "noj:judge:queue:ai:high",
        "noj:judge:queue:ai:medium",
        "noj:judge:queue:ai:low",
        "noj:judge:queue:oi-native:medium",
        "noj:judge:queue:oi-wasm:medium",
      ]
    ) {
      for (const raw of fake.getMessages(queue)) {
        messages.push(JSON.parse(raw));
      }
    }
    return messages;
  } finally {
    await fake.stop();
    resetRedisForTest();
    if (prevUrl !== null) Deno.env.set("REDIS_URL", prevUrl);
    else Deno.env.delete("REDIS_URL");
  }
}

Deno.test({
  name: "sweeper: pending 提交按尝试绑定版本恢复（而非题目当前投影）",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const { problemId, versionId, userId } = await seedProblem(
      "ver",
      95100 + (ts % 500),
      {
        kind: "ai",
        title: "恢复测试题 ver",
        description: "d",
        samples: [],
        submission_mode: "code",
        runtime_config: versionConfig,
        template_content: "",
        artifact_max_size_mb: null,
        llm_config: null,
      },
    );
    const submissionId = `tst-sweep-sub-ver-${ts}`;
    const attemptId = `tst-sweep-att-ver-${ts}`;
    await db.insert(submissions).values({
      id: submissionId,
      user_id: userId,
      problem_id: problemId,
      status: "pending",
      language: "python3",
      code: "print('x')",
      submitted_version_id: versionId,
      version_origin: "known",
      created_at: oldNow,
    });
    await db.insert(evaluationAttempts).values({
      id: attemptId,
      submission_id: submissionId,
      problem_id: problemId,
      problem_version_id: versionId,
      sequence: 0,
      source: "initial",
      state: "queued",
      created_at: oldNow,
    });
    await db.update(submissions).set({ active_attempt_id: attemptId })
      .where(eq(submissions.id, submissionId));

    const messages = await recoverAndReadMessages();
    const task = messages.find((m) => m.submission_id === submissionId);
    assertEquals(task !== undefined, true);
    // run_id 必须复用原尝试：否则 judge 回传的结果无法落到该尝试上
    assertEquals(task!.run_id, attemptId);
    assertEquals(task!.problem_version_id, versionId);
    // 配置来自版本内容（time_limit 1111），而不是题目投影（9999）
    const runtime = task!.runtime_config as {
      evaluator: { time_limit_ms: number };
    };
    assertEquals(runtime.evaluator.time_limit_ms, 1111);

    const [row] = await db.select().from(submissions).where(
      eq(submissions.id, submissionId),
    );
    assertEquals(row.status, "judging");
  },
});

Deno.test({
  name: "sweeper: pending 产物提交被恢复且保留对象（不再删除后标记 error）",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const { problemId, versionId, userId } = await seedProblem(
      "artifact",
      95200 + (ts % 500),
      {
        kind: "ai",
        title: "恢复测试题 artifact",
        description: "d",
        samples: [],
        submission_mode: "artifact",
        runtime_config: versionConfig,
        template_content: "",
        artifact_max_size_mb: 8,
        llm_config: null,
      },
    );

    // 真实写入一个本地产物对象（内容寻址）
    const storage = await getStorageProvider();
    const artifactUrl = await storage.putStream(
      `artifacts/${crypto.randomUUID()}.zip`,
      new Blob([new Uint8Array([0x50, 0x4b, 0x03, 0x04])]).stream(),
      "application/zip",
      1024 * 1024,
    );

    const submissionId = `tst-sweep-sub-art-${ts}`;
    const attemptId = `tst-sweep-att-art-${ts}`;
    await db.insert(submissions).values({
      id: submissionId,
      user_id: userId,
      problem_id: problemId,
      status: "pending",
      language: "python3",
      code: "",
      file_name: "submission.zip",
      artifact_storage_url: artifactUrl,
      submitted_version_id: versionId,
      version_origin: "known",
      created_at: oldNow,
    });
    await db.insert(evaluationAttempts).values({
      id: attemptId,
      submission_id: submissionId,
      problem_id: problemId,
      problem_version_id: versionId,
      sequence: 0,
      source: "initial",
      state: "queued",
      created_at: oldNow,
    });
    await db.update(submissions).set({ active_attempt_id: attemptId })
      .where(eq(submissions.id, submissionId));

    const messages = await recoverAndReadMessages();
    const task = messages.find((m) => m.submission_id === submissionId);
    assertEquals(task !== undefined, true, "产物 pending 提交必须被恢复入队");
    assertEquals(task!.run_id, attemptId);
    assertEquals(typeof task!.artifact_download_url, "string");
    assertEquals(task!.code, "");

    // 对象未被删除，提交行仍保留引用（可再次派发/重测）
    const [row] = await db.select().from(submissions).where(
      eq(submissions.id, submissionId),
    );
    assertEquals(row.status, "judging");
    assertEquals(row.artifact_storage_url, artifactUrl);
    assertEquals(await storage.stat(artifactUrl) !== null, true);
  },
});

Deno.test({
  name: "sweeper: 无尝试的存量 pending 行仍回退题目投影（迁移期兼容）",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const { problemId, userId } = await seedProblem(
      "legacy",
      95300 + (ts % 500),
      {
        kind: "ai",
        title: "恢复测试题 legacy",
        description: "d",
        samples: [],
        submission_mode: "code",
        runtime_config: versionConfig,
        template_content: "",
        artifact_max_size_mb: null,
        llm_config: null,
      },
    );
    const submissionId = `tst-sweep-sub-legacy-${ts}`;
    await db.insert(submissions).values({
      id: submissionId,
      user_id: userId,
      problem_id: problemId,
      status: "pending",
      language: "python3",
      code: "print('legacy')",
      created_at: oldNow,
    });

    const messages = await recoverAndReadMessages();
    const task = messages.find((m) => m.submission_id === submissionId);
    assertEquals(task !== undefined, true);
    // 没有尝试 → 用题目投影配置，且不伪造 run_id（dual 任务没有运行标识）
    const runtime = task!.runtime_config as {
      evaluator: { time_limit_ms: number };
    };
    assertEquals(runtime.evaluator.time_limit_ms, 9999);
    assertEquals(task!.run_id, undefined);
  },
});
