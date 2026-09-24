/**
 * prediction 提交服务行为测试（Task 15）。
 *
 * 覆盖 `createPredictionSubmission` 的**服务层真实行为**（不是 mock 断言 mock）：
 * - prediction 题 + `.csv` 成功：返回体、落库行（`artifact_storage_url` /
 *   `file_name` / `language`）、真实存储对象字节、入队任务
 *   （`submission_mode=prediction`）；
 * - `.pkl` 被格式校验拒绝（`PREDICTION_FORMAT_REJECTED`）；
 * - 超过题目 `artifact_max_size_mb` 的文件被拒绝，且不留孤儿对象；
 * - 非 prediction 题经 prediction 服务入口被拒；
 * - 入队失败时删除已上传的预测文件；
 * - prediction 提交不可重测（`artifact_storage_url` 非空触发现有拒绝）。
 *
 * 存储使用真实 `LocalStorageProvider` + 临时 `SUPPORT_PACKAGE_DIR`，从而验证
 * 对象确实落盘 / 被删除，而非让 fake 自证；Redis 使用 `tests/mq/_setup.ts`
 * 的 RESP mock（仅需 EVAL/LPUSH 即走完整入队路径）。
 *
 * 环境约定（与同目录 `submissions.test.ts` 一致）：PGlite 内存数据库始终可用，
 * 因此 `ignore` 仅取决于进程是否禁用了 DB。
 */

import { assertEquals, assertExists, assertRejects } from "jsr:@std/assert@^1";
import { eq, like } from "drizzle-orm";
import {
  createPredictionSubmission,
  JUDGE_QUEUES,
  rejudgeProblemSubmissions,
  rejudgeSubmission,
} from "../../index.ts";
import { getDb, resetDbForTest } from "../../../../shared/db/connection.ts";
import { problems, submissions, users } from "../../../../shared/db/schema.ts";
import { AppError, BadRequestError } from "../../../../shared/base/errors.ts";
import {
  LocalStorageProvider,
  resetStorageProvider,
  setStorageProviderForTest,
} from "../../../system/index.ts";
import {
  getRedis,
  resetRedisForTest,
} from "../../../../shared/mq/connection.ts";
import { type FakeRedis, startFakeRedis } from "../mq/_setup.ts";

const hasDb = true; // PGlite 内存数据库始终可用
const skip = !hasDb;

// 建立 schema + 评测镜像白名单种子（validateJudgeImageWithKind 依赖）。
await resetDbForTest();

/** 题目编号递增器，避免 (type, number) 唯一约束冲突。 */
let problemNumberSeq = 900000 + (Date.now() % 10000);
function nextProblemNumber(): number {
  problemNumberSeq += 1;
  return problemNumberSeq;
}

interface Fixture {
  userId: string;
  problemId: string;
}

/**
 * 插入「可提交用户 + 一道 public P 型题」。
 *
 * 题目 owner 为 root（"0"），测试用户经 public 可见性获得提交权限。
 *
 * @param mode 题目 `submission_mode`
 * @param artifactMaxSizeMb 可选题目级大小上限（MB）
 */
async function insertFixture(
  mode: "code" | "artifact" | "prediction",
  artifactMaxSizeMb?: number,
): Promise<Fixture> {
  const db = getDb();
  const unique = crypto.randomUUID().replace(/-/g, "");
  const userId = `tst-pred-user-${unique}`;
  const problemId = `tst-pred-problem-${unique}`;
  const now = new Date().toISOString();
  await db.insert(users).values({
    id: userId,
    username: `tstpred-${unique.slice(0, 8)}`,
    email: `${userId}@test.noj`,
    password_hash: "hash",
    created_at: now,
    updated_at: now,
  });
  await db.insert(problems).values({
    id: problemId,
    title: `预测提交测试题 ${unique.slice(0, 8)}`,
    description: "prediction 服务行为测试",
    difficulty: "easy",
    runtime_config: {
      // prediction 题只要求 evaluator（无 Solution 容器）
      evaluator: {
        image: "noj-evaluator-python",
        command: "python3 /workspace/evaluate.py",
        time_limit_ms: 5000,
        memory_limit_mb: 512,
      },
    },
    number: nextProblemNumber(),
    owner_id: "0",
    type: "P",
    visibility: "public",
    submission_mode: mode,
    artifact_max_size_mb: artifactMaxSizeMb ?? null,
    created_at: now,
    updated_at: now,
  });
  return { userId, problemId };
}

/** 删除 fixture 数据（事务回滚已隔离，这里保证非 preload 运行也不留残留）。 */
async function deleteFixture(fixture: Fixture): Promise<void> {
  const db = getDb();
  await db.delete(submissions).where(
    eq(submissions.problem_id, fixture.problemId),
  );
  await db.delete(problems).where(eq(problems.id, fixture.problemId));
  await db.delete(users).where(eq(users.id, fixture.userId));
}

/** 按题目查询该题的全部提交（测试内只建一条，便于断言）。 */
function findSubmissions(problemId: string) {
  return getDb().select().from(submissions).where(
    eq(submissions.problem_id, problemId),
  );
}

/** 把字节数组包成单块可读流（避免 Blob 的泛型兼容问题）。 */
function streamOf(bytes: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
}

/**
 * 在隔离的临时存储目录 + 真实 `LocalStorageProvider` 下执行 `fn`，
 * 结束后恢复 provider / 环境变量并删除临时目录。
 */
async function withLocalStorage<T>(
  fn: (provider: LocalStorageProvider) => Promise<T>,
): Promise<T> {
  const dir = await Deno.makeTempDir({ prefix: "noj-prediction-storage-" });
  const previousDir = Deno.env.get("SUPPORT_PACKAGE_DIR");
  Deno.env.set("SUPPORT_PACKAGE_DIR", dir);
  resetStorageProvider();
  const provider = new LocalStorageProvider();
  setStorageProviderForTest(provider);
  try {
    return await fn(provider);
  } finally {
    resetStorageProvider();
    if (previousDir === undefined) Deno.env.delete("SUPPORT_PACKAGE_DIR");
    else Deno.env.set("SUPPORT_PACKAGE_DIR", previousDir);
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
}

/**
 * 在 fake Redis 已连接的前提下执行 `fn`；`fn` 可通过 `fake.getMessages()`
 * 断言真实入队的任务内容。
 */
async function withFakeRedis<T>(
  fn: (fake: FakeRedis) => Promise<T>,
): Promise<T> {
  const fake = startFakeRedis();
  const previousUrl = Deno.env.get("REDIS_URL");
  resetRedisForTest();
  Deno.env.set("REDIS_URL", fake.url);
  try {
    const redis = getRedis();
    await redis.connect();
    await redis.ping();
    return await fn(fake);
  } finally {
    resetRedisForTest();
    await fake.stop();
    if (previousUrl === undefined) Deno.env.delete("REDIS_URL");
    else Deno.env.set("REDIS_URL", previousUrl);
  }
}

Deno.test({
  name: "prediction-submissions: .csv 成功落库并推送 prediction 任务",
  ignore: skip,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const fixture = await insertFixture("prediction");
    try {
      await withLocalStorage(async (storage) => {
        await withFakeRedis(async (fake) => {
          const payload = new TextEncoder().encode(
            "id,value\n1,0.5\n2,0.9\n",
          );
          const created = await createPredictionSubmission(
            fixture.userId,
            {
              problem_id: fixture.problemId,
              file_name: "prediction.csv",
              file_stream: streamOf(payload),
            },
          );

          // 1) 返回体
          assertEquals(created.problem_id, fixture.problemId);
          assertEquals(created.language, "python3");
          assertEquals(created.code, "");
          assertEquals(created.file_name, "prediction.csv");
          assertEquals(created.status, "judging");
          assertExists(created.public_id);

          // 2) 落库行：artifact_storage_url 指向真实存储对象
          const rows = await findSubmissions(fixture.problemId);
          assertEquals(rows.length, 1);
          const row = rows[0];
          assertEquals(row.id, created.id);
          assertEquals(row.status, "judging");
          assertEquals(row.file_name, "prediction.csv");
          assertEquals(row.language, "python3");
          assertEquals(row.code, "");
          assertExists(row.artifact_storage_url);
          const stored = await storage.get(row.artifact_storage_url!);
          assertEquals(
            stored,
            payload,
            "存储对象字节应与上传内容一致（peekFirstChunk 不丢字节）",
          );

          // 3) 入队任务携带 submission_mode=prediction
          const messages = fake.getMessages(JUDGE_QUEUES.medium);
          assertEquals(messages.length, 1);
          const task = JSON.parse(messages[0]) as Record<string, unknown>;
          assertEquals(task.submission_id, created.id);
          assertEquals(task.submission_mode, "prediction");
          assertEquals(task.priority, "medium");
          assertEquals(task.file_name, "prediction.csv");
          assertEquals(task.language, "python3");
          assertEquals(task.code, "");
          const runtime = task.runtime_config as {
            evaluator?: { image?: string };
          };
          assertEquals(runtime.evaluator?.image, "noj-evaluator-python");
          assertEquals(
            typeof task.artifact_download_url,
            "string",
            "prediction 任务应携带预测文件下载 URL",
          );
        });
      });
    } finally {
      await deleteFixture(fixture);
    }
  },
});

Deno.test({
  name:
    "prediction-submissions: 题目切为 prediction 后旧代码提交重测仍以 code 入队",
  ignore: skip,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    // 回归：重测只承载代码提交（artifact_storage_url 为空），必须固定 code。
    // 若从 problem.submission_mode 派生，题目被作者切为 prediction 后此处会
    // 发出 prediction，judge 找不到预测文件而静默失败。
    const fixture = await insertFixture("prediction");
    try {
      const db = getDb();
      const now = new Date().toISOString();
      const subId = crypto.randomUUID();
      await db.insert(submissions).values({
        id: subId,
        user_id: fixture.userId,
        problem_id: fixture.problemId,
        language: "python3",
        code: "print(1)",
        file_name: "main.py",
        status: "finished",
        rejudge_seq: 0,
        created_at: now,
      });

      await withFakeRedis(async (fake) => {
        // 单条重测
        await rejudgeSubmission(subId);
        const single = fake.getMessages(JUDGE_QUEUES.low);
        assertEquals(single.length, 1);
        const singleTask = JSON.parse(single[0]) as Record<string, unknown>;
        assertEquals(
          singleTask.submission_mode,
          "code",
          "重测路径只承载代码提交，必须固定 code，不随题目当前模式漂移",
        );

        // 批量重测：同题同样固定 code
        await getDb().update(submissions).set({ status: "finished" })
          .where(eq(submissions.id, subId));
        fake.clear();
        await rejudgeProblemSubmissions(fixture.problemId);
        const batch = fake.getMessages(JUDGE_QUEUES.low);
        assertEquals(batch.length, 1);
        const batchTask = JSON.parse(batch[0]) as Record<string, unknown>;
        assertEquals(
          batchTask.submission_mode,
          "code",
          "批量重测路径只承载代码提交，必须固定 code",
        );
      });
    } finally {
      await deleteFixture(fixture);
    }
  },
});

Deno.test({
  name: "prediction-submissions: .pkl 被格式校验拒绝",
  ignore: skip,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const fixture = await insertFixture("prediction");
    try {
      await withLocalStorage(async (storage) => {
        const err = await assertRejects(
          () =>
            createPredictionSubmission(fixture.userId, {
              problem_id: fixture.problemId,
              file_name: "model.pkl",
              file_stream: streamOf(new Uint8Array([0x80, 0x04, 1, 2])),
            }),
          BadRequestError,
        );
        assertEquals(err.code, "PREDICTION_FORMAT_REJECTED");
        // 校验失败发生在落存储之前：无对象、无提交行
        assertEquals((await storage.listObjects()).length, 0);
        assertEquals((await findSubmissions(fixture.problemId)).length, 0);
      });
    } finally {
      await deleteFixture(fixture);
    }
  },
});

Deno.test({
  name: "prediction-submissions: 超过题目大小上限的文件被拒绝且不留孤儿",
  ignore: skip,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    // 题目级上限 1MB（硬上限默认 2GB，故实际取 1MB）→ 验证题目级上限生效
    const fixture = await insertFixture("prediction", 1);
    try {
      await withLocalStorage(async (storage) => {
        const big = new Uint8Array(2 * 1024 * 1024).fill(0x61);
        const err = await assertRejects(
          () =>
            createPredictionSubmission(fixture.userId, {
              problem_id: fixture.problemId,
              file_name: "big.csv",
              file_stream: streamOf(big),
            }),
          BadRequestError,
        );
        assertEquals(err.message.includes("超过大小限制"), true);
        assertEquals(
          err.message.includes("1MB"),
          true,
          `错误信息应体现题目级上限，实际：${err.message}`,
        );
        assertEquals(
          (await storage.listObjects()).length,
          0,
          "超限应中止上传且不留临时/最终对象",
        );
        assertEquals((await findSubmissions(fixture.problemId)).length, 0);
      });
    } finally {
      await deleteFixture(fixture);
    }
  },
});

Deno.test({
  name: "prediction-submissions: 非 prediction 题经 prediction 服务被拒",
  ignore: skip,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const fixture = await insertFixture("code");
    try {
      const err = await assertRejects(
        () =>
          createPredictionSubmission(fixture.userId, {
            problem_id: fixture.problemId,
            file_name: "prediction.csv",
            file_stream: streamOf(new TextEncoder().encode("id,value\n")),
          }),
        BadRequestError,
      );
      assertEquals(err.message, "该题目不支持 prediction 提交");
      assertEquals((await findSubmissions(fixture.problemId)).length, 0);
    } finally {
      await deleteFixture(fixture);
    }
  },
});

Deno.test({
  name: "prediction-submissions: 入队失败删除已上传的预测文件",
  ignore: skip,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const fixture = await insertFixture("prediction");
    try {
      await withLocalStorage(async (storage) => {
        // 不连接 Redis：pushJudgeTask 因连接未就绪失败（可重试错误）
        resetRedisForTest();
        const err = await assertRejects(
          () =>
            createPredictionSubmission(fixture.userId, {
              problem_id: fixture.problemId,
              file_name: "prediction.csv",
              file_stream: streamOf(
                new TextEncoder().encode("id,value\n1,0.5\n"),
              ),
            }),
          AppError,
        );
        assertEquals(err.code, "SUBMISSION_QUEUE_ERROR");

        // 可重试入队失败：提交行保留为 pending，但预测文件必须立即删除
        const rows = await findSubmissions(fixture.problemId);
        assertEquals(rows.length, 1);
        assertEquals(rows[0].status, "pending");
        const url = rows[0].artifact_storage_url;
        assertExists(url);
        await assertRejects(() => storage.get(url), Deno.errors.NotFound);
        assertEquals((await storage.listObjects()).length, 0);
      });
    } finally {
      await deleteFixture(fixture);
    }
  },
});

Deno.test({
  name: "prediction-submissions: prediction 提交不可重测",
  ignore: skip,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const fixture = await insertFixture("prediction");
    try {
      await withLocalStorage(async () => {
        await withFakeRedis(async () => {
          const created = await createPredictionSubmission(
            fixture.userId,
            {
              problem_id: fixture.problemId,
              file_name: "prediction.csv",
              file_stream: streamOf(
                new TextEncoder().encode("id,value\n1,0.5\n"),
              ),
            },
          );

          // 单条重测：artifact_storage_url 非空 → 复用既有拒绝
          const single = await assertRejects(
            () => rejudgeSubmission(created.id),
            BadRequestError,
          );
          assertEquals(single.message, "产物/预测提交不支持重测");

          // 批量重测：题目含 prediction 提交 → 拒绝
          await getDb().update(submissions).set({ status: "finished" })
            .where(eq(submissions.id, created.id));
          const batch = await assertRejects(
            () => rejudgeProblemSubmissions(fixture.problemId),
            BadRequestError,
          );
          assertEquals(batch.message.includes("产物/预测提交"), true);
        });
      });
    } finally {
      await deleteFixture(fixture);
    }
  },
});

Deno.test({
  name: "prediction-submissions: 清理测试数据",
  ignore: skip,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const db = getDb();
    await db.delete(submissions).where(
      like(submissions.user_id, "tst-pred-user-%"),
    );
    await db.delete(problems).where(like(problems.id, "tst-pred-problem-%"));
    await db.delete(users).where(like(users.id, "tst-pred-user-%"));
  },
});
