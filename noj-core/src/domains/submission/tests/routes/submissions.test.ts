import { assertEquals, assertExists } from "jsr:@std/assert@^1";
import { eq } from "drizzle-orm";
import {
  createUserToken,
  initRedisForTest,
  jsonRequest,
} from "../../../../../tests/helper.ts";
import { createApp } from "../../../../app.ts";
import { getDb, resetDbForTest } from "../../../../shared/db/connection.ts";
import { problems, submissions } from "../../../../shared/db/schema.ts";
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
} from "./_multipart.ts";

// 模块级 bootstrap：确保 PGlite schema 已创建
await resetDbForTest();
await initRedisForTest();

const hasEnv = !!Deno.env.get("JWT_SECRET");
const hasDb = true; // PGlite 内存数据库始终可用
const skip = !(hasEnv && hasDb);

Deno.test({
  name: "submissions route: POST /api/v1/submissions 无 token 返回 401",
  ignore: !hasEnv,
  fn: async () => {
    const app = createApp();
    const res = await jsonRequest(app, "/api/v1/submissions", {
      method: "POST",
      body: {
        problem_id: "1001",
        language: "python3",
        code: "print('hi')",
      },
    });
    assertEquals(res.status, 401);
    const body = await res.json();
    assertEquals(body.error, "未提供认证令牌");
  },
});

Deno.test({
  name: "submissions route: POST /api/v1/submissions 无效 token 返回 401",
  ignore: !hasEnv,
  fn: async () => {
    const app = createApp();
    const res = await jsonRequest(app, "/api/v1/submissions", {
      method: "POST",
      body: {
        problem_id: "1001",
        language: "python3",
        code: "print('hi')",
      },
      token: "invalid-token-here",
    });
    assertEquals(res.status, 401);
    const body = await res.json();
    assertEquals(body.error, "认证令牌无效或已过期");
  },
});

Deno.test({
  name: "submissions route: POST /api/v1/submissions 缺少字段返回 400",
  ignore: skip,
  fn: async () => {
    const app = createApp();
    const token = await createUserToken();
    const res = await jsonRequest(app, "/api/v1/submissions", {
      method: "POST",
      body: { problem_id: "1001" }, // 缺少 language 和 code
      token,
    });
    assertEquals(res.status, 400);
    const body = await res.json();
    assertEquals(body.error.includes("缺少必填字段"), true);
  },
});

Deno.test({
  name: "submissions route: GET /api/v1/submissions/:id 无 token 返回 404",
  ignore: !hasEnv,
  fn: async () => {
    const app = createApp();
    // GET /:id 路由使用 optionalAuthMiddleware：无 token 时不抛 401，
    // 由 service 层对不存在的 id 抛 NotFoundError → 404
    const res = await jsonRequest(app, "/api/v1/submissions/123");
    assertEquals(res.status, 404);
  },
});

Deno.test({
  name:
    "submissions route: GET /api/v1/submissions/:id 有效 token 但提交不存在返回 404",
  ignore: skip,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const app = createApp();
    const token = await createUserToken();
    const res = await jsonRequest(app, "/api/v1/submissions/nonexistent-id", {
      token,
    });
    assertEquals(res.status, 404);
    const body = await res.json();
    assertEquals(body.error, "提交不存在");
  },
});

// ── 提交列表 ──

Deno.test({
  name: "submissions route: GET /api/v1/submissions 无 token 返回 401",
  ignore: !hasEnv,
  fn: async () => {
    const app = createApp();
    const res = await jsonRequest(app, "/api/v1/submissions");
    assertEquals(res.status, 401);
  },
});

Deno.test({
  name: "submissions route: GET /api/v1/submissions 无效 token 返回 401",
  ignore: !hasEnv,
  fn: async () => {
    const app = createApp();
    const res = await jsonRequest(app, "/api/v1/submissions", {
      token: "invalid-token",
    });
    assertEquals(res.status, 401);
  },
});

Deno.test({
  name:
    "submissions route: GET /api/v1/submissions 无数据时返回空列表和分页信息",
  ignore: skip,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const app = createApp();
    // 认证中间件会实时校验账号状态，测试令牌必须对应真实活跃用户。
    const token = await createUserToken();
    const res = await jsonRequest(app, "/api/v1/submissions", { token });
    assertEquals(res.status, 200);
    const body = await res.json();
    assertEquals(Array.isArray(body.data), true);
    assertEquals(body.data.length, 0);
    assertExists(body.pagination);
    assertEquals(body.pagination.page, 1);
    assertEquals(body.pagination.per_page, 20);
    assertEquals(body.pagination.total, 0);
    assertEquals(body.pagination.total_pages, 0);
  },
});

Deno.test({
  name:
    "submissions route: GET /api/v1/submissions 按 status 筛选返回错误状态值时 400",
  ignore: !hasEnv,
  fn: async () => {
    const app = createApp();
    const token = await createUserToken();
    const res = await jsonRequest(app, "/api/v1/submissions?status=invalid", {
      token,
    });
    assertEquals(res.status, 400);
  },
});

Deno.test({
  name: "submissions route: GET /api/v1/submissions per_page 超过上限自动限制",
  ignore: skip,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const app = createApp();
    const token = await createUserToken();
    const res = await jsonRequest(app, "/api/v1/submissions?per_page=999", {
      token,
    });
    assertEquals(res.status, 200);
    const body = await res.json();
    assertEquals(body.pagination.per_page, 100);
  },
});

// ── 管理员提交列表 ──

Deno.test({
  name:
    "admin submissions: GET /api/v1/admin/submission/submissions 无 token 返回 401",
  ignore: !hasEnv,
  fn: async () => {
    const app = createApp();
    const res = await jsonRequest(app, "/api/v1/admin/submission/submissions");
    assertEquals(res.status, 401);
  },
});

Deno.test({
  name:
    "admin submissions: GET /api/v1/admin/submission/submissions 普通用户返回 403",
  ignore: skip,
  fn: async () => {
    const app = createApp();
    const token = await createUserToken();
    const res = await jsonRequest(app, "/api/v1/admin/submission/submissions", {
      token,
    });
    assertEquals(res.status, 403);
    const body = await res.json();
    assertEquals(body.error, "需要管理员权限");
  },
});

Deno.test({
  name:
    "admin submissions: GET /api/v1/admin/submission/submissions 管理员查看所有提交",
  ignore: skip,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const app = createApp();
    const token = await createUserToken("admin");
    const res = await jsonRequest(app, "/api/v1/admin/submission/submissions", {
      token,
    });
    assertEquals(res.status, 200);
    const body = await res.json();
    assertEquals(Array.isArray(body.data), true);
    assertExists(body.pagination);
  },
});

Deno.test({
  name:
    "admin submissions: GET /api/v1/admin/submission/submissions 按 user_id 筛选",
  ignore: skip,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const app = createApp();
    const token = await createUserToken("admin");
    const res = await jsonRequest(
      app,
      "/api/v1/admin/submission/submissions?user_id=nonexistent-user",
      { token },
    );
    assertEquals(res.status, 200);
    const body = await res.json();
    assertEquals(body.data.length, 0);
    assertEquals(body.pagination.total, 0);
  },
});

Deno.test({
  name:
    "submissions route: GET /api/v1/submissions/:id/status 提交不存在时返回 404 + code + request_id",
  ignore: skip,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const app = createApp();
    const token = await createUserToken();
    const res = await jsonRequest(
      app,
      "/api/v1/submissions/nonexistent-id/status",
      { token },
    );
    assertEquals(res.status, 404);
    const body = await res.json();
    assertEquals(body.error, "提交不存在");
    assertEquals(body.code, "NOT_FOUND");
    assertExists(body.request_id);
  },
});

// ── multipart 按 submission_mode 分派（Task 14） ──

/**
 * 内存 StorageProvider：`putStream` 记录字节数并返回可预测的存储 URL，
 * 避免测试依赖真实文件系统 / S3。
 */
class MemoryStorageProvider implements StorageProvider {
  /** 已上传对象的存储 URL → 字节数 */
  readonly objects = new Map<string, number>();

  /** @inheritdoc */
  put(key: string, data: Uint8Array): Promise<string> {
    const url = `noj-storage://test/${key}`;
    this.objects.set(url, data.length);
    return Promise.resolve(url);
  }

  /** @inheritdoc */
  async putStream(
    key: string,
    stream: ReadableStream<Uint8Array>,
  ): Promise<string> {
    const reader = stream.getReader();
    let size = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
    }
    const url = `noj-storage://test/${key}`;
    this.objects.set(url, size);
    return url;
  }

  /** @inheritdoc */
  get(_url: string): Promise<Uint8Array> {
    return Promise.resolve(new Uint8Array());
  }

  /** @inheritdoc */
  delete(url: string): Promise<void> {
    this.objects.delete(url);
    return Promise.resolve();
  }

  /** @inheritdoc */
  downloadUrl(storageUrl: string): Promise<string> {
    return Promise.resolve(`noj-download://test/${storageUrl}`);
  }
}

/** 建一道题（multipart 提交路由测试用），返回题目 ID。 */
async function insertRouteProblem(
  ownerId: string,
  submissionMode: "artifact" | "prediction",
): Promise<string> {
  const db = getDb();
  const problemId = crypto.randomUUID();
  const now = new Date().toISOString();
  await db.insert(problems).values({
    id: problemId,
    title: `分派测试题 ${submissionMode}`,
    description: "路由分派测试",
    difficulty: "easy",
    runtime_config: {
      evaluator: {
        image: "noj-evaluator-python",
        command: "python3 /workspace/evaluate.py",
        time_limit_ms: 5000,
        memory_limit_mb: 512,
      },
      // prediction 题允许缺 solution；artifact 题需要 solution
      ...(submissionMode === "artifact"
        ? {
          solution: {
            image: "noj-solution-python",
            call_timeout_ms: 2000,
            memory_limit_mb: 512,
          },
        }
        : {}),
    },
    number: 700000 + Math.floor(Math.random() * 100000),
    owner_id: ownerId,
    type: "P",
    visibility: "public",
    submission_mode: submissionMode,
    created_at: now,
    updated_at: now,
  });
  return problemId;
}

Deno.test({
  name: "submissions route: prediction 题 multipart 提交走 prediction 服务",
  ignore: skip,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const db = getDb();
    const app = createApp();
    const token = await createUserToken();

    // 使用 root 用户（UID=0）作为题目 owner；visibility=public 使普通用户可提交。
    const problemId = await insertRouteProblem("0", "prediction");

    const storage = new MemoryStorageProvider();
    resetStorageProvider();
    setStorageProviderForTest(storage);

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
          "/api/v1/submissions",
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
        language: submissions.language,
        file_name: submissions.file_name,
      }).from(submissions).where(eq(submissions.id, body.data.id)).limit(1);
      // prediction 服务写入 artifact_storage_url（复用生命周期列）
      assertExists(row.artifact_storage_url);
      assertEquals(row.language, "python3");
      assertEquals(row.file_name, "prediction.csv");
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
  name: "submissions route: artifact 题 multipart 提交仍走 artifact 服务",
  ignore: skip,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const db = getDb();
    const app = createApp();
    const token = await createUserToken();
    const problemId = await insertRouteProblem("0", "artifact");

    const storage = new MemoryStorageProvider();
    resetStorageProvider();
    setStorageProviderForTest(storage);

    const fake = startFakeRedis();
    const previousRedisUrl = Deno.env.get("REDIS_URL");
    resetRedisForTest();
    Deno.env.set("REDIS_URL", fake.url);

    try {
      const { getRedis } = await import("../../../../shared/mq/connection.ts");
      const redis = getRedis();
      await redis.connect();
      await redis.ping();

      // 合法 zip（PK 头）走 artifact 服务 → 201
      const res = await withoutSubmissionRateLimit(() =>
        multipartRequest(
          app,
          "/api/v1/submissions",
          { problem_id: problemId },
          {
            name: "artifact.zip",
            data: new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0x00, 0x00]),
          },
          token,
        )
      );
      assertEquals(res.status, 201);
      const body = await res.json();
      const [row] = await db.select({
        artifact_storage_url: submissions.artifact_storage_url,
      }).from(submissions).where(eq(submissions.id, body.data.id)).limit(1);
      assertExists(row.artifact_storage_url);

      // 非 zip 扩展名 → artifact 服务拒绝（400，证明没有被 prediction 分支吞掉）
      const rejected = await withoutSubmissionRateLimit(() =>
        multipartRequest(
          app,
          "/api/v1/submissions",
          { problem_id: problemId },
          {
            name: "prediction.csv",
            data: new TextEncoder().encode("id,value\n1,0.5\n"),
          },
          token,
        )
      );
      assertEquals(rejected.status, 400);
    } finally {
      resetRedisForTest();
      await fake.stop();
      if (previousRedisUrl) Deno.env.set("REDIS_URL", previousRedisUrl);
      else Deno.env.delete("REDIS_URL");
      resetStorageProvider();
    }
  },
});
