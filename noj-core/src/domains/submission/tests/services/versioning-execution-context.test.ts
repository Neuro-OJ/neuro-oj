/**
 * 提交/评测执行链回归（tracking #1/#6/#10/#26/#29/#48）。
 *
 * 核心不变量（Handbook §2.2、§5.4、§5.6）：
 * - 初次提交的**执行来源必须取自已解析的提交时版本**：runtime_config、模板、
 *   LLM 能力、产物大小上限都不能读 `problems` 最新版投影；
 * - 新提交/自测必须显式携带版本，缺失一律拒绝且**不产生任何记录**；
 * - 提交 + 初次尝试 + 活动指针在同一事务内落库；
 * - 非法评分不得被改写成正式 0/满分（平台错误保留已有正式判定）；
 * - 新增/删除提交递增题目、竞赛与 **global** 作用域 revision。
 */
import { assertEquals, assertRejects } from "jsr:@std/assert@^1";
import { eq } from "drizzle-orm";
import { getDb } from "../../../../shared/db/connection.ts";
import { ensureDefaultWorkspace } from "../../../workspace/index.ts";
import {
  evaluationAttempts,
  llmTokenRevocations,
  problems,
  problemVersionObjects,
  problemVersions,
  queryProjectionRevisions,
  selfTests,
  storageObjects,
  submissions,
  submissionVersionResults,
} from "../../../../shared/db/schema.ts";
import {
  createSubmission,
  deleteSubmission,
  getSubmission,
} from "../../index.ts";
import { createArtifactSubmission } from "../../services/submissions/artifact-submissions.ts";
import { saveEvaluationResult } from "../../services/submissions/submissions-result.ts";
import { createSelfTest } from "../../services/self-tests.ts";
import {
  createAttempt,
  supersedeAttempt,
} from "../../services/versioning/attempts.ts";
import { assertExecutionPreflight } from "../../services/versioning/version-execution.ts";
import {
  globalScopeKey,
  problemScopeKey,
} from "../../services/versioning/projection.ts";
import type { ProblemContentV1 } from "../../../catalog/index.ts";
import { setStorageProviderForTest } from "../../../system/services/storage/factory.ts";
import { LocalStorageProvider } from "../../../system/services/storage/local.ts";
import { buildStorageUrl } from "../../../system/services/storage/types.ts";
import { _resetSystemSettingsForTest } from "../../../system/services/system-settings.ts";
import { startFakeRedis } from "../mq/_setup.ts";
import {
  getRedis,
  resetRedisForTest,
} from "../../../../shared/mq/connection.ts";

const now = new Date().toISOString();
const tempStorageDir = Deno.makeTempDirSync({ prefix: "noj-exec-ctx-" });

/** 每个用例使用同一个一次性临时目录（内容寻址，互不干扰）。 */
function useTempStorage(): LocalStorageProvider {
  const provider = new LocalStorageProvider(tempStorageDir);
  setStorageProviderForTest(provider);
  return provider;
}

class TrackingLocalStorageProvider extends LocalStorageProvider {
  putCount = 0;
  uploadedUrls: string[] = [];
  failNextDownloadUrl = false;
  downloadUrlOverride?: string;

  override async putStream(
    key: string,
    stream: ReadableStream<Uint8Array>,
    contentType?: string,
    maxSizeBytes?: number,
  ): Promise<string> {
    this.putCount++;
    const url = await super.putStream(key, stream, contentType, maxSizeBytes);
    this.uploadedUrls.push(url);
    return url;
  }

  override downloadUrl(
    storageUrl: string,
    expiresIn?: number,
  ): Promise<string> {
    if (this.failNextDownloadUrl) {
      this.failNextDownloadUrl = false;
      return Promise.reject(new Error("download URL test failure"));
    }
    if (this.downloadUrlOverride !== undefined) {
      return Promise.resolve(this.downloadUrlOverride);
    }
    return super.downloadUrl(storageUrl, expiresIn);
  }
}

function stubLlmGatewayProvider(enabled: boolean): () => void {
  const envNames = [
    "NOJ_LLM_DEFAULT_PROVIDER_ID",
    "NOJ_LLM_DEFAULT_MODEL",
    "NOJ_LLM_SERVICE_TOKEN",
    "NOJ_LLM_GATEWAY_URL",
  ] as const;
  const oldEnv = envNames.map((name) => [name, Deno.env.get(name)] as const);
  const originalFetch = globalThis.fetch;
  Deno.env.set("NOJ_LLM_DEFAULT_PROVIDER_ID", "prov-default");
  Deno.env.set("NOJ_LLM_DEFAULT_MODEL", "test-model");
  Deno.env.set("NOJ_LLM_SERVICE_TOKEN", "test-service-token-0123456789abcdef");
  Deno.env.set("NOJ_LLM_GATEWAY_URL", "http://llm-gateway.test");
  _resetSystemSettingsForTest();
  globalThis.fetch = (() =>
    Promise.resolve(
      new Response(
        JSON.stringify({
          data: {
            id: "prov-default",
            domain_id: "00000000-0000-4000-8000-000000000001",
            name: "test",
            base_url: "http://provider.test",
            cost_per_1k_tokens: 0,
            api_key_masked: "sk-****",
            enabled,
            created_at: now,
            updated_at: now,
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    )) as typeof fetch;
  return () => {
    globalThis.fetch = originalFetch;
    for (const [name, value] of oldEnv) {
      if (value === undefined) Deno.env.delete(name);
      else Deno.env.set(name, value);
    }
    _resetSystemSettingsForTest();
  };
}

interface VersionSpec {
  command: string;
  timeLimitMs: number;
  template: string;
  artifactMaxSizeMb: number | null;
  submissionMode: "code" | "artifact";
  evaluatorImage?: string;
  solutionImage?: string;
  llmConfig?: Record<string, unknown> | null;
}

/** 构造一份 `kind = ai` 的版本内容。 */
function aiContent(spec: VersionSpec): Record<string, unknown> {
  return {
    kind: "ai",
    title: "t",
    description: "d",
    samples: [{ id: "s1", input: "1", output: "1" }],
    submission_mode: spec.submissionMode,
    runtime_config: {
      evaluator: {
        image: spec.evaluatorImage ?? "noj-evaluator-python",
        command: spec.command,
        time_limit_ms: spec.timeLimitMs,
        memory_limit_mb: 256,
      },
      solution: {
        image: spec.solutionImage ?? "noj-solution-python",
        call_timeout_ms: 1000,
        memory_limit_mb: 256,
      },
    },
    template_content: spec.template,
    artifact_max_size_mb: spec.artifactMaxSizeMb,
    llm_config: spec.llmConfig ?? null,
  };
}

/** 以字节流形式提供一段"合法 zip 头 + 填充"的内容。 */
function zipStream(totalBytes: number): ReadableStream<Uint8Array> {
  const bytes = new Uint8Array(totalBytes);
  bytes.set([0x50, 0x4b, 0x03, 0x04]);
  return new ReadableStream({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
}

/**
 * 建题并发布 V1/V2 两个版本，`latest_version_id` 指向 V2。
 *
 * 题目行上的投影字段**故意写成 V2**：任何"读当前题目投影"的实现都会在断言中暴露。
 */
async function seedTwoVersions(
  problemId: string,
  number: number,
  v1: VersionSpec,
  v2: VersionSpec,
): Promise<void> {
  const db = getDb();
  await ensureDefaultWorkspace();
  const v2Content = aiContent(v2);
  await db.insert(problems).values({
    id: problemId,
    title: problemId,
    description: "d",
    number,
    owner_id: "0",
    difficulty: "easy",
    judge_type: "dual",
    submission_mode: v2.submissionMode,
    // 最新版投影 = V2（与 V1 明显不同）
    runtime_config: v2Content.runtime_config as Record<string, unknown>,
    template_content: v2.template,
    artifact_max_size_mb: v2.artifactMaxSizeMb,
    created_at: now,
    updated_at: now,
  });
  await db.insert(problemVersions).values([
    {
      id: `${problemId}-v1`,
      problem_id: problemId,
      version: 1,
      origin: "published",
      content: aiContent(v1),
      published_at: now,
    },
    {
      id: `${problemId}-v2`,
      problem_id: problemId,
      version: 2,
      origin: "published",
      content: v2Content,
      published_at: now,
    },
  ]);
  // 复合外键要求版本行先存在，再回写最新版指针
  await db.update(problems).set({ latest_version_id: `${problemId}-v2` }).where(
    eq(problems.id, problemId),
  );
}

async function attemptsOf(submissionId: string) {
  return await getDb().select().from(evaluationAttempts).where(
    eq(evaluationAttempts.submission_id, submissionId),
  );
}

Deno.test("execution context: V1 提交使用 V1 运行配置与模板，不继承最新版（#1）", async () => {
  await seedTwoVersions(
    "ec-p1",
    985001,
    {
      command: "python3 /workspace/evaluate_v1.py",
      timeLimitMs: 1111,
      template: "v1-template",
      artifactMaxSizeMb: 3,
      submissionMode: "code",
    },
    {
      command: "python3 /workspace/evaluate_v2.py",
      timeLimitMs: 2222,
      template: "v2-template",
      artifactMaxSizeMb: 900,
      submissionMode: "code",
    },
  );

  // 评测队列不可用会抛 500，但提交与尝试已原子落库——断言执行来源即可。
  await createSubmission("0", {
    problem_id: "ec-p1",
    language: "python3",
    code: "print(1)",
    version_id: "ec-p1-v1",
  }).catch(() => {/* Redis 不可用属预期 */});

  const [row] = await getDb().select().from(submissions).where(
    eq(submissions.problem_id, "ec-p1"),
  );
  assertEquals(row.submitted_version_id, "ec-p1-v1");
  assertEquals(row.version_origin, "known");
  assertEquals(row.status, "pending");

  const attempts = await attemptsOf(row.id);
  assertEquals(attempts.length, 1);
  assertEquals(attempts[0].problem_version_id, "ec-p1-v1");
  assertEquals(attempts[0].sequence, 0);
  // 活动指针与提交、尝试三者一致（同一事务写入，§5.4）
  assertEquals(row.active_attempt_id, attempts[0].id);
  assertEquals(row.judge_run_id, attempts[0].id);

  const snapshot = attempts[0].task_snapshot as Record<string, unknown>;
  const runtime = snapshot.runtime_config as {
    evaluator: { command: string; time_limit_ms: number };
  };
  assertEquals(runtime.evaluator.command, "python3 /workspace/evaluate_v1.py");
  assertEquals(runtime.evaluator.time_limit_ms, 1111);
  assertEquals(snapshot.problem_version_id, "ec-p1-v1");
  assertEquals(snapshot.language, "python3");
  // V1 没有 LLM 能力：不得读取最新版（V2）配置补出 llm 执行
  assertEquals("llm_execution" in snapshot, false);
});

Deno.test("execution context: 同一题缺版本提交被拒绝且不产生记录（#6）", async () => {
  await seedTwoVersions(
    "ec-p2",
    985002,
    {
      command: "python3 /workspace/evaluate_v1.py",
      timeLimitMs: 1111,
      template: "v1",
      artifactMaxSizeMb: null,
      submissionMode: "code",
    },
    {
      command: "python3 /workspace/evaluate_v2.py",
      timeLimitMs: 2222,
      template: "v2",
      artifactMaxSizeMb: null,
      submissionMode: "code",
    },
  );

  await assertRejects(
    () =>
      createSubmission("0", {
        problem_id: "ec-p2",
        language: "python3",
        code: "print(1)",
      }),
    Error,
    "必须携带 version_id",
  );
  assertEquals(
    (await getDb().select().from(submissions).where(
      eq(submissions.problem_id, "ec-p2"),
    )).length,
    0,
  );
  assertEquals((await attemptsOf("ec-p2")).length, 0);

  // 自测同样必须显式携带版本，不能静默绑定最新版
  await assertRejects(
    () => createSelfTest("0", "ec-p2", { language: "python3", code: "x" }),
    Error,
    "必须携带 version_id",
  );
  assertEquals(
    (await getDb().select().from(selfTests).where(
      eq(selfTests.problem_id, "ec-p2"),
    )).length,
    0,
  );
});

Deno.test("execution context: 产物提交大小上限取自已选版本而非最新版（#1）", async () => {
  useTempStorage();
  await seedTwoVersions(
    "ec-p3",
    985003,
    {
      command: "python3 /workspace/evaluate_v1.py",
      timeLimitMs: 1111,
      template: "v1",
      artifactMaxSizeMb: 1,
      submissionMode: "artifact",
    },
    {
      command: "python3 /workspace/evaluate_v2.py",
      timeLimitMs: 2222,
      template: "v2",
      artifactMaxSizeMb: 900,
      submissionMode: "artifact",
    },
  );

  // V1 上限 1MB：1.5MB 产物必须被拒绝（若误用最新版 V2 的 900MB 上限就会放行）
  await assertRejects(
    () =>
      createArtifactSubmission("0", {
        problem_id: "ec-p3",
        file_name: "submission.zip",
        file_stream: zipStream(1_500_000),
        version_id: "ec-p3-v1",
      }),
    Error,
    "超过大小限制（最大 1MB）",
  );
  assertEquals(
    (await getDb().select().from(submissions).where(
      eq(submissions.problem_id, "ec-p3"),
    )).length,
    0,
  );

  // 缺失版本字段（artifact 走 multipart 字段）同样拒绝且不落库
  await assertRejects(
    () =>
      createArtifactSubmission("0", {
        problem_id: "ec-p3",
        file_name: "submission.zip",
        file_stream: zipStream(1024),
      }),
    Error,
    "必须携带 version_id",
  );
  assertEquals(
    (await getDb().select().from(submissions).where(
      eq(submissions.problem_id, "ec-p3"),
    )).length,
    0,
  );
});

Deno.test("execution context: 队列不可用时产物与提交保留为可恢复 pending（#10）", async () => {
  const provider = useTempStorage();
  await seedTwoVersions(
    "ec-p4",
    985004,
    {
      command: "python3 /workspace/evaluate_v1.py",
      timeLimitMs: 1111,
      template: "v1",
      artifactMaxSizeMb: 100,
      submissionMode: "artifact",
    },
    {
      command: "python3 /workspace/evaluate_v2.py",
      timeLimitMs: 2222,
      template: "v2",
      artifactMaxSizeMb: 100,
      submissionMode: "artifact",
    },
  );

  await createArtifactSubmission("0", {
    problem_id: "ec-p4",
    file_name: "submission.zip",
    file_stream: zipStream(4096),
    version_id: "ec-p4-v2",
  }).catch(() => {/* Redis 不可用属预期 */});

  const [row] = await getDb().select().from(submissions).where(
    eq(submissions.problem_id, "ec-p4"),
  );
  assertEquals(row.status, "pending");
  assertEquals(row.submitted_version_id, "ec-p4-v2");
  // 产物对象必须保留（入队失败不得删除），由 sweeper 按尝试快照恢复
  assertEquals(typeof row.artifact_storage_url, "string");
  assertEquals((await provider.stat(row.artifact_storage_url!)).exists, true);
  const attempts = await attemptsOf(row.id);
  assertEquals(attempts.length, 1);
  assertEquals(attempts[0].state, "queued");
  assertEquals(attempts[0].problem_version_id, "ec-p4-v2");
});

Deno.test("execution result: 非法评分按平台错误处理，不产生正式判定（#29 core）", async () => {
  const db = getDb();
  await seedTwoVersions(
    "ec-p5",
    985005,
    {
      command: "python3 /workspace/evaluate_v1.py",
      timeLimitMs: 1111,
      template: "v1",
      artifactMaxSizeMb: null,
      submissionMode: "code",
    },
    {
      command: "python3 /workspace/evaluate_v2.py",
      timeLimitMs: 2222,
      template: "v2",
      artifactMaxSizeMb: null,
      submissionMode: "code",
    },
  );

  await createSubmission("0", {
    problem_id: "ec-p5",
    language: "python3",
    code: "print(1)",
    version_id: "ec-p5-v1",
  }).catch(() => {/* Redis 不可用属预期 */});
  const [row] = await db.select().from(submissions).where(
    eq(submissions.problem_id, "ec-p5"),
  );
  const attemptId = row.active_attempt_id!;

  // 评分缺失：不得被写成正式 0 分
  const outcome = await saveEvaluationResult({
    submission_id: row.id,
    status: "finished",
    score: undefined as unknown as number,
    output: "---RESULT---\n{}",
    details: {},
    evaluation_protocol_version: 2,
    attempt_id: attemptId,
    run_id: attemptId,
    problem_version_id: "ec-p5-v1",
    rejudge_seq: 0,
    result_kind: "graded",
  });
  assertEquals(outcome.applied, true);

  const [attempt] = await db.select().from(evaluationAttempts).where(
    eq(evaluationAttempts.id, attemptId),
  );
  assertEquals(attempt.state, "error");
  assertEquals(attempt.result_kind, "platform_error");
  assertEquals(attempt.result_status, "INVALID_SCORE");
  assertEquals(attempt.score, null);
  assertEquals(attempt.accepted, false);
  // 零写入正式判定：不产生该版本的当前成绩
  assertEquals(
    (await db.select().from(submissionVersionResults).where(
      eq(submissionVersionResults.submission_id, row.id),
    )).length,
    0,
  );
  const [after] = await db.select().from(submissions).where(
    eq(submissions.id, row.id),
  );
  assertEquals(after.status, "error");
  assertEquals(after.is_valid, false);
  assertEquals(after.is_accepted, false);
  assertEquals(after.effective_attempt_id, null);
});

Deno.test("artifact preflight: Provider 停用时上传文件由统一补偿清理", async () => {
  const db = getDb();
  const provider = new TrackingLocalStorageProvider(tempStorageDir);
  setStorageProviderForTest(provider);
  await seedTwoVersions(
    "ec-p8-provider",
    985019,
    {
      command: "python3 /workspace/evaluate_v1.py",
      timeLimitMs: 1111,
      template: "v1",
      artifactMaxSizeMb: 5,
      submissionMode: "artifact",
    },
    {
      command: "python3 /workspace/evaluate_v2.py",
      timeLimitMs: 2222,
      template: "v2",
      artifactMaxSizeMb: 5,
      submissionMode: "artifact",
      llmConfig: { max_calls: 2, max_tokens: 1000 },
    },
  );

  const restoreLlm = stubLlmGatewayProvider(false);

  try {
    await assertRejects(
      () =>
        createArtifactSubmission("0", {
          problem_id: "ec-p8-provider",
          file_name: "submission.zip",
          file_stream: zipStream(2048),
          version_id: "ec-p8-provider-v2",
        }),
      Error,
      "已停用",
    );
    assertEquals(provider.putCount, 1);
    const uploadedUrl = provider.uploadedUrls[0];
    assertEquals((await provider.stat(uploadedUrl)).exists, false);
    const [object] = await db.select().from(storageObjects).where(
      eq(storageObjects.storage_url, uploadedUrl),
    );
    assertEquals(object.state, "deleted");
    assertEquals(
      (await db.select().from(submissions).where(
        eq(submissions.problem_id, "ec-p8-provider"),
      )).length,
      0,
    );
  } finally {
    restoreLlm();
  }
});

Deno.test({
  name:
    "initial dispatch: code 与 artifact 永久入队失败都登记并执行吊销 outbox",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const fake = startFakeRedis();
    const previousRedisUrl = Deno.env.get("REDIS_URL") ?? null;
    const restoreLlm = stubLlmGatewayProvider(true);
    const db = getDb();
    try {
      resetRedisForTest();
      Deno.env.set("REDIS_URL", fake.url);
      await getRedis().connect();

      const codeProblemId = "ec-p8-outbox-code";
      await seedTwoVersions(
        codeProblemId,
        985022,
        {
          command: "python3 /workspace/evaluate_v1.py",
          timeLimitMs: 1111,
          template: "v1",
          artifactMaxSizeMb: null,
          submissionMode: "code",
          llmConfig: { max_calls: 2, max_tokens: 1000 },
        },
        {
          command: "python3 /workspace/evaluate_v2.py",
          timeLimitMs: 2222,
          template: "v2",
          artifactMaxSizeMb: null,
          submissionMode: "code",
          llmConfig: { max_calls: 2, max_tokens: 1000 },
        },
      );
      await assertRejects(
        () =>
          createSubmission("0", {
            problem_id: codeProblemId,
            language: "python3",
            code: "x".repeat(16 * 1024 * 1024 + 1024),
            version_id: `${codeProblemId}-v2`,
          }),
        Error,
        "队列暂时不可用",
      );
      const [codeSubmission] = await db.select().from(submissions).where(
        eq(submissions.problem_id, codeProblemId),
      );
      assertEquals(codeSubmission.status, "error");
      const [codeAttempt] = await db.select().from(evaluationAttempts).where(
        eq(evaluationAttempts.submission_id, codeSubmission.id),
      );
      assertEquals(
        "llm_execution" in
          (codeAttempt.task_snapshot as Record<string, unknown>),
        true,
      );
      const [codeRevocation] = await db.select().from(llmTokenRevocations)
        .where(eq(llmTokenRevocations.attempt_id, codeAttempt.id));
      assertEquals(codeRevocation.state, "done");
      assertEquals(
        await getRedis().get(`llm:attempt:revoked:${codeAttempt.id}`),
        "1",
      );

      const artifactProblemId = "ec-p8-outbox-artifact";
      await seedTwoVersions(
        artifactProblemId,
        985023,
        {
          command: "python3 /workspace/evaluate_v1.py",
          timeLimitMs: 1111,
          template: "v1",
          artifactMaxSizeMb: 5,
          submissionMode: "artifact",
          llmConfig: { max_calls: 2, max_tokens: 1000 },
        },
        {
          command: "python3 /workspace/evaluate_v2.py",
          timeLimitMs: 2222,
          template: "v2",
          artifactMaxSizeMb: 5,
          submissionMode: "artifact",
          llmConfig: { max_calls: 2, max_tokens: 1000 },
        },
      );
      const provider = new TrackingLocalStorageProvider(tempStorageDir);
      provider.downloadUrlOverride = "x".repeat(16 * 1024 * 1024 + 1024);
      setStorageProviderForTest(provider);
      await assertRejects(
        () =>
          createArtifactSubmission("0", {
            problem_id: artifactProblemId,
            file_name: "submission.zip",
            file_stream: zipStream(2048),
            version_id: `${artifactProblemId}-v2`,
          }),
        Error,
        "队列暂时不可用",
      );
      const [artifactSubmission] = await db.select().from(submissions).where(
        eq(submissions.problem_id, artifactProblemId),
      );
      assertEquals(artifactSubmission.status, "error");
      const [artifactAttempt] = await db.select().from(evaluationAttempts)
        .where(eq(evaluationAttempts.submission_id, artifactSubmission.id));
      assertEquals(
        "llm_execution" in
          (artifactAttempt.task_snapshot as Record<string, unknown>),
        true,
      );
      const [artifactRevocation] = await db.select().from(llmTokenRevocations)
        .where(eq(llmTokenRevocations.attempt_id, artifactAttempt.id));
      assertEquals(artifactRevocation.state, "done");
      assertEquals(
        await getRedis().get(`llm:attempt:revoked:${artifactAttempt.id}`),
        "1",
      );
      // 永久入队失败在任务未派发成功的情况下终结了尝试；不把它描述成 token 已送达 judge。
    } finally {
      restoreLlm();
      resetRedisForTest();
      if (previousRedisUrl === null) Deno.env.delete("REDIS_URL");
      else Deno.env.set("REDIS_URL", previousRedisUrl);
      await fake.stop();
    }
  },
});

Deno.test("artifact preflight: 停用镜像与丢失支持包均在上传前拒绝", async () => {
  const db = getDb();
  const provider = new TrackingLocalStorageProvider(tempStorageDir);
  setStorageProviderForTest(provider);
  await seedTwoVersions(
    "ec-p8-image",
    985020,
    {
      command: "python3 /workspace/evaluate_v1.py",
      timeLimitMs: 1111,
      template: "v1",
      artifactMaxSizeMb: 5,
      submissionMode: "artifact",
    },
    {
      command: "python3 /workspace/evaluate_v2.py",
      timeLimitMs: 2222,
      template: "v2",
      artifactMaxSizeMb: 5,
      submissionMode: "artifact",
      solutionImage: "noj-solution-pr622-disabled",
    },
  );
  await assertRejects(
    () =>
      createArtifactSubmission("0", {
        problem_id: "ec-p8-image",
        file_name: "submission.zip",
        file_stream: zipStream(2048),
        version_id: "ec-p8-image-v2",
      }),
    Error,
    "不在允许列表",
  );
  assertEquals(provider.putCount, 0, "镜像预检失败不得先上传产物");

  await seedTwoVersions(
    "ec-p8-package",
    985021,
    {
      command: "python3 /workspace/evaluate_v1.py",
      timeLimitMs: 1111,
      template: "v1",
      artifactMaxSizeMb: 5,
      submissionMode: "artifact",
    },
    {
      command: "python3 /workspace/evaluate_v2.py",
      timeLimitMs: 2222,
      template: "v2",
      artifactMaxSizeMb: 5,
      submissionMode: "artifact",
    },
  );
  const missingPackageUrl = buildStorageUrl(
    "local",
    `missing-support-${crypto.randomUUID()}`,
    "0".repeat(64),
  );
  await db.insert(storageObjects).values({
    storage_url: missingPackageUrl,
    sha256: null,
    byte_size: null,
    state: "unknown",
    created_at: now,
  });
  await db.insert(problemVersionObjects).values({
    version_id: "ec-p8-package-v2",
    role: "support_package",
    path: "package.zip",
    storage_url: missingPackageUrl,
  });
  await assertRejects(
    () =>
      createArtifactSubmission("0", {
        problem_id: "ec-p8-package",
        file_name: "submission.zip",
        file_stream: zipStream(2048),
        version_id: "ec-p8-package-v2",
      }),
    Error,
    "支持包已缺失",
  );
  assertEquals(provider.putCount, 0, "支持包预检失败不得先上传产物");
});

Deno.test("execution context: 上传后失败补偿不得删除共享对象（#11）", async () => {
  const provider = new TrackingLocalStorageProvider(tempStorageDir);
  setStorageProviderForTest(provider);
  const db = getDb();

  // 题目 A：正常 artifact 题，先成功落库并引用内容寻址对象
  await seedTwoVersions(
    "ec-p8a",
    985008,
    {
      command: "python3 /workspace/evaluate_v1.py",
      timeLimitMs: 1111,
      template: "v1",
      artifactMaxSizeMb: 5,
      submissionMode: "artifact",
    },
    {
      command: "python3 /workspace/evaluate_v2.py",
      timeLimitMs: 2222,
      template: "v2",
      artifactMaxSizeMb: 5,
      submissionMode: "artifact",
    },
  );

  // 题目 B 也允许 artifact；第二次相同字节上传后故意让下载 URL 生成失败。
  await seedTwoVersions(
    "ec-p8b",
    985018,
    {
      command: "python3 /workspace/evaluate_v1.py",
      timeLimitMs: 1111,
      template: "v1",
      artifactMaxSizeMb: 5,
      submissionMode: "artifact",
    },
    {
      command: "python3 /workspace/evaluate_v2.py",
      timeLimitMs: 2222,
      template: "v2",
      artifactMaxSizeMb: 5,
      submissionMode: "artifact",
    },
  );

  const bytes = new Uint8Array(2048);
  bytes.set([0x50, 0x4b, 0x03, 0x04]);
  const streamOf = () =>
    new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes);
        controller.close();
      },
    });

  // 第一个请求成功落库（入队失败不影响对象登记）
  await createArtifactSubmission("0", {
    problem_id: "ec-p8a",
    file_name: "submission.zip",
    file_stream: streamOf(),
    version_id: "ec-p8a-v1",
  }).catch(() => {/* Redis 不可用属预期 */});
  const [bound] = await db.select().from(submissions).where(
    eq(submissions.problem_id, "ec-p8a"),
  );
  assertEquals(typeof bound.artifact_storage_url, "string");
  const sharedUrl = bound.artifact_storage_url!;
  assertEquals((await provider.stat(sharedUrl)).exists, true);

  // 第二个请求上传**相同字节**（内容寻址 → 同一 URL），随后下载 URL 生成失败：
  // 补偿不得删除已被第一个提交引用的共享对象。
  provider.failNextDownloadUrl = true;
  await assertRejects(
    () =>
      createArtifactSubmission("0", {
        problem_id: "ec-p8b",
        file_name: "submission.zip",
        file_stream: streamOf(),
        version_id: "ec-p8b-v2",
      }),
    Error,
    "无法生成 artifact 下载地址",
  );
  assertEquals(provider.putCount, 2);
  assertEquals(
    (await db.select().from(submissions).where(
      eq(submissions.problem_id, "ec-p8b"),
    )).length,
    0,
  );
  // 共享对象仍在，且登记未被写成 deleted
  assertEquals((await provider.stat(sharedUrl)).exists, true);
  const [obj] = await db.select().from(storageObjects).where(
    eq(storageObjects.storage_url, sharedUrl),
  );
  assertEquals(obj.state === "deleted", false);
  // 第一个提交的引用仍然有效
  const [stillBound] = await db.select().from(submissions).where(
    eq(submissions.id, bound.id),
  );
  assertEquals(stillBound.artifact_storage_url, sharedUrl);
});

Deno.test("attempt sequence: 迁移前较大的源 rejudge_seq 不回退（#27）", async () => {
  const db = getDb();
  const problemId = "ec-p9";
  const versionId = "ec-p9-v1";
  await db.insert(problems).values({
    id: problemId,
    title: problemId,
    description: "d",
    number: 985009,
    owner_id: "0",
    difficulty: "easy",
    judge_type: "dual",
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
      title: problemId,
      description: "d",
      samples: [],
      submission_mode: "code",
      runtime_config: {
        evaluator: {
          image: "noj-evaluator-python",
          command: "python3 /workspace/evaluate.py",
          time_limit_ms: 1000,
          memory_limit_mb: 256,
        },
        solution: {
          image: "noj-solution-python",
          call_timeout_ms: 1000,
          memory_limit_mb: 256,
        },
      },
      template_content: "",
      artifact_max_size_mb: null,
      llm_config: null,
    },
    published_at: now,
  });
  await db.update(problems).set({ latest_version_id: versionId }).where(
    eq(problems.id, problemId),
  );

  // 旧协议迁移行：rejudge_seq=5 且没有任何尝试记录
  await db.insert(submissions).values({
    id: "ec-s9",
    user_id: "0",
    problem_id: problemId,
    language: "python3",
    code: "print(1)",
    submitted_version_id: versionId,
    version_origin: "known",
    status: "pending",
    rejudge_seq: 5,
    created_at: now,
  });

  const attempt = await createAttempt({
    source: {
      kind: "submission",
      id: "ec-s9",
      problem_id: problemId,
      contest_id: null,
    },
    problemVersionId: versionId,
    source_kind: "rejudge",
  });
  // 不回退到 0：seq 至少与源序号一致，任务与结果封套才不会判为过时
  assertEquals(attempt.sequence, 5);
  const [row] = await db.select().from(submissions).where(
    eq(submissions.id, "ec-s9"),
  );
  assertEquals(row.rejudge_seq, 5);
  assertEquals(row.judge_run_id, attempt.id);

  // 终结首次尝试后才能再次重测（同一源同时只允许一个活动尝试）
  await supersedeAttempt(attempt.id);
  const second = await createAttempt({
    source: {
      kind: "submission",
      id: "ec-s9",
      problem_id: problemId,
      contest_id: null,
    },
    problemVersionId: versionId,
    source_kind: "rejudge",
  });
  assertEquals(second.sequence, 6);
});

/**
 * 断言抛出的 `AppError` 带指定稳定 code（本仓库 @std/assert 版本不支持
 * `assertRejects` 的谓词重载，故显式实现）。
 */
async function expectAppErrorCode(
  fn: () => Promise<unknown>,
  code: string,
): Promise<void> {
  try {
    await fn();
  } catch (err) {
    assertEquals((err as { code?: string }).code, code);
    return;
  }
  throw new Error(`预期抛出 ${code}，但调用未失败`);
}

Deno.test("attempt lifecycle: superseded 后吊销旧尝试 token；传 executor 时不提前吊销", async () => {
  const db = getDb();
  await seedTwoVersions(
    "ec-p10",
    985010,
    {
      command: "python3 /workspace/evaluate_v1.py",
      timeLimitMs: 1111,
      template: "v1",
      artifactMaxSizeMb: null,
      submissionMode: "code",
    },
    {
      command: "python3 /workspace/evaluate_v2.py",
      timeLimitMs: 2222,
      template: "v2",
      artifactMaxSizeMb: null,
      submissionMode: "code",
    },
  );
  await db.insert(submissions).values({
    id: "ec-s10",
    user_id: "0",
    problem_id: "ec-p10",
    language: "python3",
    code: "print(1)",
    submitted_version_id: "ec-p10-v1",
    version_origin: "known",
    status: "pending",
    created_at: now,
  });

  const fake = startFakeRedis();
  const prevUrl = Deno.env.get("REDIS_URL") ?? null;
  resetRedisForTest();
  Deno.env.set("REDIS_URL", fake.url);
  try {
    const redis = getRedis();
    await redis.connect();
    const attemptKey = (id: string) => `llm:attempt:revoked:${id}`;

    // 自行开事务：提交后必须吊销（尝试维度 + 提交维度旧键）
    const first = await createAttempt({
      source: {
        kind: "submission",
        id: "ec-s10",
        problem_id: "ec-p10",
        contest_id: null,
      },
      problemVersionId: "ec-p10-v1",
      source_kind: "initial",
      taskSnapshot: {
        language: "python3",
        problem_version_id: "ec-p10-v1",
        runtime_config: {
          evaluator: {
            image: "noj-evaluator-python",
            command: "python3 /workspace/evaluate.py",
            time_limit_ms: 1111,
            memory_limit_mb: 256,
          },
          solution: {
            image: "noj-solution-python",
            call_timeout_ms: 1000,
            memory_limit_mb: 256,
          },
        },
      },
    });
    assertEquals(await supersedeAttempt(first.id), true);
    assertEquals(await redis.get(attemptKey(first.id)), "1");
    assertEquals(await redis.get("llm:token:revoked:ec-s10"), "1");
    // 已是终态：再次调用返回 false（幂等，不重复写）
    assertEquals(await supersedeAttempt(first.id), false);

    // 传入 executor 时事务尚未提交 → 不得提前吊销（调用方提交后自行吊销）
    const second = await createAttempt({
      source: {
        kind: "submission",
        id: "ec-s10",
        problem_id: "ec-p10",
        contest_id: null,
      },
      problemVersionId: "ec-p10-v1",
      source_kind: "rejudge",
    });
    let appliedInTx = false;
    await db.transaction(async (tx) => {
      appliedInTx = await supersedeAttempt(second.id, tx);
      assertEquals(await redis.get(attemptKey(second.id)), null);
    });
    assertEquals(appliedInTx, true);
    // 提交后本函数按契约不吊销（调用方负责）
    assertEquals(await redis.get(attemptKey(second.id)), null);
    assertEquals(
      (await getDb().select().from(evaluationAttempts).where(
        eq(evaluationAttempts.id, second.id),
      ))[0].state,
      "superseded",
    );
  } finally {
    await fake.stop();
    resetRedisForTest();
    if (prevUrl !== null) Deno.env.set("REDIS_URL", prevUrl);
    else Deno.env.delete("REDIS_URL");
  }
});

Deno.test("execution preflight: 语言/模式/镜像/产物上限给出稳定原因码（#33 共享 helper）", async () => {
  const aiContent = {
    kind: "ai",
    title: "t",
    description: "d",
    samples: [],
    submission_mode: "code",
    runtime_config: {
      evaluator: {
        image: "noj-evaluator-python",
        command: "python3 /workspace/evaluate.py",
        time_limit_ms: 1000,
        memory_limit_mb: 256,
      },
      solution: {
        image: "noj-solution-python",
        call_timeout_ms: 1000,
        memory_limit_mb: 256,
      },
    },
    template_content: "",
    artifact_max_size_mb: 2,
    llm_config: null,
  } as unknown as ProblemContentV1;

  // 模式不符 → SUBMISSION_MODE_MISMATCH
  await expectAppErrorCode(
    () =>
      assertExecutionPreflight(aiContent, {
        language: "python3",
        submissionMode: "artifact",
      }),
    "SUBMISSION_MODE_MISMATCH",
  );

  // 产物超过目标版本上限 → ARTIFACT_TOO_LARGE_FOR_VERSION
  const artifactContent = {
    ...aiContent,
    submission_mode: "artifact",
  } as unknown as ProblemContentV1;
  await expectAppErrorCode(
    () =>
      assertExecutionPreflight(artifactContent, {
        language: "python3",
        submissionMode: "artifact",
        artifactByteSize: 3 * 1024 * 1024,
      }),
    "ARTIFACT_TOO_LARGE_FOR_VERSION",
  );

  // 镜像不在白名单 → JUDGE_IMAGE_NOT_ALLOWED
  const ghostImage = {
    ...aiContent,
    runtime_config: {
      ...(aiContent as unknown as { runtime_config: Record<string, unknown> })
        .runtime_config,
      evaluator: {
        image: `ghost-evaluator-${Date.now()}`,
        command: "python3 /workspace/evaluate.py",
        time_limit_ms: 1000,
        memory_limit_mb: 256,
      },
    },
  } as unknown as ProblemContentV1;
  await expectAppErrorCode(
    () =>
      assertExecutionPreflight(ghostImage, {
        language: "python3",
        submissionMode: "code",
      }),
    "JUDGE_IMAGE_NOT_ALLOWED",
  );

  // OI 语言不在版本允许列表 → LANGUAGE_NOT_SUPPORTED
  const oiContent = {
    kind: "oi",
    title: "t",
    description: "d",
    samples: [],
    runtime_config: {
      backend: "native",
      languages: ["c"],
      time_limit_ms: 1000,
      memory_limit_mb: 256,
      checker: { type: "default" },
      subtasks: [],
    },
  } as unknown as ProblemContentV1;
  await expectAppErrorCode(
    () =>
      assertExecutionPreflight(oiContent, {
        language: "python3",
        submissionMode: "code",
      }),
    "LANGUAGE_NOT_SUPPORTED",
  );

  // 客观题版本 → CONTENT_KIND_MISMATCH
  await expectAppErrorCode(
    () =>
      assertExecutionPreflight(
        { kind: "objective" } as unknown as ProblemContentV1,
        { language: "python3", submissionMode: "code" },
      ),
    "CONTENT_KIND_MISMATCH",
  );

  // 合规版本直接通过（不含产物大小校验时同样通过）
  await assertExecutionPreflight(aiContent, {
    language: "python3",
    submissionMode: "code",
  });
  await assertExecutionPreflight(artifactContent, {
    language: "python3",
    submissionMode: "artifact",
    artifactByteSize: 1024,
  });
});

Deno.test("read model: 详情返回全部尝试历史与最近/有效/通过指针（#53）", async () => {
  const db = getDb();
  const v1 = {
    command: "python3 /workspace/evaluate_v1.py",
    timeLimitMs: 1111,
    template: "v1",
    artifactMaxSizeMb: null,
    submissionMode: "code" as const,
  };
  const v2 = {
    command: "python3 /workspace/evaluate_v2.py",
    timeLimitMs: 2222,
    template: "v2",
    artifactMaxSizeMb: null,
    submissionMode: "code" as const,
  };
  await seedTwoVersions("ec-p7", 985007, v1, v2);

  await createSubmission("0", {
    problem_id: "ec-p7",
    language: "python3",
    code: "print(1)",
    version_id: "ec-p7-v1",
  }).catch(() => {/* Redis 不可用属预期 */});
  const [row] = await db.select().from(submissions).where(
    eq(submissions.problem_id, "ec-p7"),
  );
  const firstAttemptId = row.active_attempt_id!;

  // 第一次执行：V1 通过（5000 分）
  await saveEvaluationResult({
    submission_id: row.id,
    status: "finished",
    score: 5000,
    output: "ok",
    details: {},
    evaluation_protocol_version: 2,
    attempt_id: firstAttemptId,
    run_id: firstAttemptId,
    problem_version_id: "ec-p7-v1",
    rejudge_seq: 0,
    result_kind: "graded",
  });

  // 重测：用 V2 执行并得到 0 分（最近一次执行变为 V2）
  const second = await createAttempt({
    source: {
      kind: "submission",
      id: row.id,
      problem_id: "ec-p7",
      contest_id: null,
    },
    problemVersionId: "ec-p7-v2",
    source_kind: "rejudge",
  });
  assertEquals(second.sequence, 1);
  await saveEvaluationResult({
    submission_id: row.id,
    status: "finished",
    score: 0,
    output: "wa",
    details: {},
    evaluation_protocol_version: 2,
    attempt_id: second.id,
    run_id: second.id,
    problem_version_id: "ec-p7-v2",
    rejudge_seq: 1,
    result_kind: "graded",
  });

  const detail = await getSubmission(row.id, "0", "admin");
  assertEquals(detail.attempts.length, 2);
  assertEquals(detail.attempts.map((a) => a.sequence), [0, 1]);
  assertEquals(detail.attempts[0].version, 1);
  assertEquals(detail.attempts[0].problem_version_id, "ec-p7-v1");
  assertEquals(detail.attempts[0].source, "initial");
  assertEquals(detail.attempts[0].state, "finished");
  assertEquals(detail.attempts[0].result_kind, "graded");
  assertEquals(detail.attempts[0].status, "finished");
  assertEquals(detail.attempts[1].version, 2);
  assertEquals(detail.attempts[1].source, "rejudge");

  // any 策略：最高分候选是 V1 的 5000 → 有效指针指向第一次执行
  assertEquals(detail.effective_attempt_id, firstAttemptId);
  assertEquals(detail.accepted_attempt_id, firstAttemptId);
  assertEquals(detail.attempts[0].is_effective, true);
  assertEquals(detail.attempts[0].is_accepted, true);
  assertEquals(detail.attempts[1].is_effective, false);
  // 最近一次执行是第二次（重测），与有效成绩分开
  assertEquals(detail.latest_attempt_id, second.id);
  assertEquals(detail.attempts[1].is_latest, true);
  assertEquals(detail.attempts[0].is_latest, false);
  assertEquals(detail.latest_attempt?.attempt_id, second.id);
  assertEquals(detail.latest_attempt?.sequence, 1);
  assertEquals(detail.effective_attempt?.problem_version_id, "ec-p7-v1");
  assertEquals(detail.effective_attempt?.version, 1);
  // `result` 仍是最远一次执行（最近运行），与有效成绩不同源
  assertEquals(detail.result?.score, 0);
  // 提交时版本 V1 不是最新版（最新为 V2）
  assertEquals(detail.is_latest, false);

  // 权限：非 owner 看不到源码/详情，但执行历史（无 output/details）仍在
  const asOther = await getSubmission(row.id, "other-user", undefined);
  assertEquals(asOther.code, null);
  assertEquals(asOther.result?.details, null);
  assertEquals(asOther.attempts.length, 2);
});

Deno.test("projection revision: 新增与删除提交递增题目与 global revision（#48）", async () => {
  const db = getDb();
  await seedTwoVersions(
    "ec-p6",
    985006,
    {
      command: "python3 /workspace/evaluate_v1.py",
      timeLimitMs: 1111,
      template: "v1",
      artifactMaxSizeMb: null,
      submissionMode: "code",
    },
    {
      command: "python3 /workspace/evaluate_v2.py",
      timeLimitMs: 2222,
      template: "v2",
      artifactMaxSizeMb: null,
      submissionMode: "code",
    },
  );

  await createSubmission("0", {
    problem_id: "ec-p6",
    language: "python3",
    code: "print(1)",
    version_id: "ec-p6-v1",
  }).catch(() => {/* Redis 不可用属预期 */});

  const rev = async (scopeKey: string) => {
    const [row] = await db.select().from(queryProjectionRevisions).where(
      eq(queryProjectionRevisions.scope_key, scopeKey),
    );
    return row?.data_revision ?? 0;
  };
  const problemKey = problemScopeKey("ec-p6");
  assertEquals(await rev(problemKey) >= 1, true);
  // 缓存读取的是 global：新增提交必须递增它，否则计数要等 TTL 才可见
  assertEquals(await rev(globalScopeKey()) >= 1, true);
  const afterCreate = await rev(globalScopeKey());

  // 删除路径：直接插入一条无尝试的终态提交再删除
  await db.insert(submissions).values({
    id: "ec-s6",
    user_id: "0",
    problem_id: "ec-p6",
    language: "python3",
    code: "print(2)",
    submitted_version_id: "ec-p6-v1",
    version_origin: "known",
    status: "finished",
    created_at: now,
  });
  await deleteSubmission("ec-s6");
  assertEquals(await rev(globalScopeKey()) > afterCreate, true);
  assertEquals(
    (await db.select().from(submissions).where(eq(submissions.id, "ec-s6")))
      .length,
    0,
  );
});
