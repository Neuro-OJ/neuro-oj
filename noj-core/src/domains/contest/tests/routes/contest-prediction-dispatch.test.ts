/**
 * 竞赛提交路由的 submission_mode 分派测试（Task 14）。
 *
 * 验证 `POST /api/v1/contests/:id/submit` 的 multipart 分支按题目的
 * `submission_mode` 分派到 prediction 或 artifact 服务；并复用竞赛成员校验时
 * 已取得的 mode，不为分派额外查询题目。
 */

import { assertEquals, assertExists } from "jsr:@std/assert@^1";
import { eq } from "drizzle-orm";
import { createApp } from "../../../../app.ts";
import { getDb, resetDbForTest } from "../../../../shared/db/connection.ts";
import {
  contestParticipants,
  contestProblems,
  contests,
  problems,
  submissions,
  userRoles,
  users,
} from "../../../../shared/db/schema.ts";
import { signToken } from "../../../identity/index.ts";
import { initRedisForTest } from "../../../../../tests/helper.ts";
import { resetRedisForTest } from "../../../../shared/mq/connection.ts";
import {
  resetStorageProvider,
  setStorageProviderForTest,
} from "../../../system/index.ts";
import type { StorageProvider } from "../../../system/index.ts";
import {
  multipartRequest,
  startFakeRedis,
  withoutSubmissionRateLimit,
} from "../../../submission/tests/routes/_multipart.ts";

await resetDbForTest();
await initRedisForTest();

/** 内存 StorageProvider：不触碰真实文件系统。 */
class MemoryStorageProvider implements StorageProvider {
  /** @inheritdoc */
  put(key: string, _data: Uint8Array): Promise<string> {
    return Promise.resolve(`noj-storage://test/${key}`);
  }

  /** @inheritdoc */
  async putStream(
    key: string,
    stream: ReadableStream<Uint8Array>,
  ): Promise<string> {
    const reader = stream.getReader();
    while (true) {
      const { done } = await reader.read();
      if (done) break;
    }
    return `noj-storage://test/${key}`;
  }

  /** @inheritdoc */
  get(_url: string): Promise<Uint8Array> {
    return Promise.resolve(new Uint8Array());
  }

  /** @inheritdoc */
  delete(_url: string): Promise<void> {
    return Promise.resolve();
  }

  /** @inheritdoc */
  downloadUrl(storageUrl: string): Promise<string> {
    return Promise.resolve(`noj-download://test/${storageUrl}`);
  }
}

/** 建好「进行中竞赛 + prediction 题 + 参赛者」并返回 ID 组合。 */
async function setupRunningContestWithPredictionProblem(): Promise<{
  contestId: string;
  problemId: string;
  userId: string;
  token: string;
}> {
  const db = getDb();
  const unique = `${Date.now()}-${crypto.randomUUID().slice(0, 8)}`;
  const now = new Date().toISOString();
  const userId = crypto.randomUUID();
  const problemId = crypto.randomUUID();
  const contestId = crypto.randomUUID();

  await db.insert(users).values({
    id: userId,
    username: `pred-contest-user-${unique}`,
    email: `pred-contest-user-${unique}@example.com`,
    password_hash: "hash",
    created_at: now,
    updated_at: now,
  });
  await db.insert(problems).values({
    id: problemId,
    title: `竞赛预测题 ${unique}`,
    description: "竞赛 prediction 分派测试",
    difficulty: "easy",
    runtime_config: {
      evaluator: {
        image: "noj-evaluator-python",
        command: "python3 /workspace/evaluate.py",
        time_limit_ms: 5000,
        memory_limit_mb: 512,
      },
      // prediction 题不需要 solution
    },
    number: 800000 + Math.floor(Math.random() * 100000),
    owner_id: "0",
    type: "P",
    submission_mode: "prediction",
    created_at: now,
    updated_at: now,
  });
  await db.insert(contests).values({
    id: contestId,
    title: `prediction 分派竞赛 ${unique}`,
    start_time: new Date(Date.now() - 60_000).toISOString(),
    end_time: new Date(Date.now() + 3_600_000).toISOString(),
    type: "kaggle",
    created_by: userId,
    created_at: now,
    updated_at: now,
  });
  await db.insert(contestProblems).values({
    contest_id: contestId,
    problem_id: problemId,
    sort_order: 0,
    label: "A",
    score: 10000,
  });
  await db.insert(contestParticipants).values({
    contest_id: contestId,
    user_id: userId,
    registered_at: now,
  });
  await db.insert(userRoles).values({
    user_id: userId,
    role_id: "user",
  }).onConflictDoNothing();

  const token = await signToken({ sub: userId, role: "user" });
  return { contestId, problemId, userId, token };
}

Deno.test({
  name: "contests route: prediction 题 multipart 提交走 prediction 服务",
  ignore: !Deno.env.get("JWT_SECRET"),
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const db = getDb();
    const app = createApp();
    const { contestId, problemId, token } =
      await setupRunningContestWithPredictionProblem();

    resetStorageProvider();
    setStorageProviderForTest(new MemoryStorageProvider());

    const fake = startFakeRedis();
    const previousRedisUrl = Deno.env.get("REDIS_URL");
    resetRedisForTest();
    Deno.env.set("REDIS_URL", fake.url);

    try {
      const { getRedis } = await import("../../../../shared/mq/connection.ts");
      const redis = getRedis();
      await redis.connect();
      await redis.ping();

      const res = await withoutSubmissionRateLimit(() =>
        multipartRequest(
          app,
          `/api/v1/contests/${contestId}/submit`,
          { problem_id: problemId },
          {
            name: "prediction.csv",
            data: new TextEncoder().encode("id,value\n1,0.5\n"),
          },
          token,
        )
      );
      assertEquals(res.status, 201);
      const body = await res.json();
      assertExists(body.data.id);

      const [row] = await db.select({
        artifact_storage_url: submissions.artifact_storage_url,
        contest_id: submissions.contest_id,
        language: submissions.language,
      }).from(submissions).where(eq(submissions.id, body.data.id)).limit(1);
      assertExists(row.artifact_storage_url);
      assertEquals(row.contest_id, contestId);
      assertEquals(row.language, "python3");
    } finally {
      resetRedisForTest();
      await fake.stop();
      if (previousRedisUrl) Deno.env.set("REDIS_URL", previousRedisUrl);
      else Deno.env.delete("REDIS_URL");
      resetStorageProvider();
    }
  },
});

Deno.test({
  name: "contests route: 非竞赛题目 multipart 提交返回 400",
  ignore: !Deno.env.get("JWT_SECRET"),
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const db = getDb();
    const app = createApp();
    const { contestId, userId, token } =
      await setupRunningContestWithPredictionProblem();

    // 另建一道不属于该竞赛的 prediction 题
    const outsiderId = crypto.randomUUID();
    const now = new Date().toISOString();
    await db.insert(problems).values({
      id: outsiderId,
      title: "竞赛外 prediction 题",
      description: "不属于该竞赛",
      difficulty: "easy",
      runtime_config: {
        evaluator: {
          image: "noj-evaluator-python",
          command: "python3 /workspace/evaluate.py",
          time_limit_ms: 5000,
          memory_limit_mb: 512,
        },
      },
      number: 900000 + Math.floor(Math.random() * 100000),
      owner_id: userId,
      type: "P",
      submission_mode: "prediction",
      created_at: now,
      updated_at: now,
    });

    resetStorageProvider();
    setStorageProviderForTest(new MemoryStorageProvider());

    const fake = startFakeRedis();
    const previousRedisUrl = Deno.env.get("REDIS_URL");
    resetRedisForTest();
    Deno.env.set("REDIS_URL", fake.url);

    try {
      const { getRedis } = await import("../../../../shared/mq/connection.ts");
      const redis = getRedis();
      await redis.connect();
      await redis.ping();

      const res = await withoutSubmissionRateLimit(() =>
        multipartRequest(
          app,
          `/api/v1/contests/${contestId}/submit`,
          { problem_id: outsiderId },
          {
            name: "prediction.csv",
            data: new TextEncoder().encode("id,value\n1,0.5\n"),
          },
          token,
        )
      );
      assertEquals(res.status, 400);
      assertEquals((await res.json()).error, "题目不属于该竞赛");
    } finally {
      resetRedisForTest();
      await fake.stop();
      if (previousRedisUrl) Deno.env.set("REDIS_URL", previousRedisUrl);
      else Deno.env.delete("REDIS_URL");
      resetStorageProvider();
    }
  },
});
