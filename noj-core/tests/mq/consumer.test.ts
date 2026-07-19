/**
 * MQ Consumer 单元测试。
 *
 * 测试消费者核心逻辑：fake Redis LPUSH→BRPOP 路径、JudgeResult 持久化、空队列处理。
 *
 * 实际 startResultConsumer 无限循环 + BRPOP 阻塞时序在 fake Redis 中
 * 难以可靠测试（BRPOP 在 ioredis 端会阻塞直到超时），那部分由真实 Redis 覆盖。
 */

import { assertEquals } from "jsr:@std/assert@^1";
import { getRedis, resetRedisForTest } from "../../src/mq/connection.ts";
import { getDb, resetDbForTest } from "../../src/db/connection.ts";
import {
  evaluationResults,
  problems,
  submissions,
  users,
} from "../../src/db/schema.ts";
import { eq, sql } from "drizzle-orm";
import { startFakeRedis } from "./_setup.ts";

const hasDb = true;
const TS = Date.now();
const SUBMISSION_ID = `consumer-test-sub-${TS}`;
const PROBLEM_ID = `consumer-test-pr-${TS}`;
const USER_ID = `consumer-test-user-${TS}`;

async function setupTestData() {
  await resetDbForTest();
  const db = getDb();
  const now = new Date().toISOString();

  await db.insert(users).values({
    id: USER_ID,
    username: `c-tester-${TS}`,
    email: `c-${TS}@test.noj`,
    password_hash: "hash",
    role: "user",
    created_at: now,
    updated_at: now,
  });
  await db.insert(problems).values({
    id: PROBLEM_ID,
    title: `C-Test ${TS}`,
    description: "desc",
    difficulty: "easy",
    runtime_config: {
      evaluator: {
        image: "noj-evaluator-python",
        command: "python3 /workspace/evaluate.py",
        time_limit_ms: 5000,
        memory_limit_mb: 512,
      },

      solution: {
        image: "noj-solution-python",
        entry: "submission_sample.py",
        call_timeout_ms: 2000,
        memory_limit_mb: 512,
      },
    },
    number: 90000 + (TS & 0x7fff),
    owner_id: USER_ID,
    type: "P",
    created_at: now,
    updated_at: now,
  });
  await db.insert(submissions).values({
    id: SUBMISSION_ID,
    user_id: USER_ID,
    problem_id: PROBLEM_ID,
    status: "judging",
    language: "python3",
    code: "print('t')",
    created_at: now,
  });
}

async function assertResultExists(submissionId: string): Promise<boolean> {
  const db = getDb();
  const [row] = await db
    .select({ count: sql<number>`count(*)` })
    .from(evaluationResults)
    .where(eq(evaluationResults.submission_id, submissionId))
    .limit(1);
  return Number(row?.count ?? 0) > 0;
}

/** 向 fake Redis LPUSH 一条消息 */
async function fakeLpush(fakeUrl: string, queue: string, message: string) {
  const prevUrl = Deno.env.get("REDIS_URL") ?? null;
  try {
    resetRedisForTest();
    Deno.env.set("REDIS_URL", fakeUrl);
    const redis = getRedis();
    await redis.connect();
    await redis.ping();
    await redis.lpush(queue, message);
  } finally {
    resetRedisForTest();
    if (prevUrl !== null) Deno.env.set("REDIS_URL", prevUrl);
    else Deno.env.delete("REDIS_URL");
  }
}

/** 用 fake Redis 客户端执行回调，finally 保证状态恢复 */
async function _withFakeRedis<T>(
  fakeUrl: string,
  // deno-lint-ignore no-explicit-any
  fn: (redis: any) => Promise<T>,
): Promise<T> {
  const prevUrl = Deno.env.get("REDIS_URL") ?? null;
  try {
    resetRedisForTest();
    Deno.env.set("REDIS_URL", fakeUrl);
    const redis = getRedis();
    await redis.connect();
    await redis.ping();
    return await fn(redis);
  } finally {
    resetRedisForTest();
    if (prevUrl !== null) Deno.env.set("REDIS_URL", prevUrl);
    else Deno.env.delete("REDIS_URL");
  }
}

// ── 测试 ─────────────────────────────────────────

Deno.test({
  name: "mq/consumer: fake Redis BRPOP 空队列返回 null",
  ignore: !hasDb,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const fake = startFakeRedis();
    try {
      resetRedisForTest();
      Deno.env.set("REDIS_URL", fake.url);
      const redis = getRedis();
      await redis.connect();
      await redis.ping();
      // 空队列 BRPOP 应返回 null
      // deno-lint-ignore no-explicit-any
      const result = await (redis as any).brpop("nonexistent:q", 2);
      resetRedisForTest();
      Deno.env.delete("REDIS_URL");

      assertEquals(result, null, "空队列 BRPOP 应返回 null");
    } finally {
      await fake.stop();
    }
  },
});

Deno.test({
  name: "mq/consumer: fake Redis LPUSH 后 BRPOP 可取到数据",
  ignore: !hasDb,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const fake = startFakeRedis();
    try {
      await fakeLpush(fake.url, "mytest:queue", "hello42");

      // BRPOP 取数据
      resetRedisForTest();
      Deno.env.set("REDIS_URL", fake.url);
      const redis = getRedis();
      await redis.connect();
      await redis.ping();
      // deno-lint-ignore no-explicit-any
      const result = await (redis as any).brpop("mytest:queue", 2);
      resetRedisForTest();
      Deno.env.delete("REDIS_URL");

      assertEquals(Array.isArray(result), true, "有数据时应返回数组");
      assertEquals(result[0], "mytest:queue", "应返回队列名");
      assertEquals(result[1], "hello42", "应返回 LPUSH 的消息");
    } finally {
      await fake.stop();
    }
  },
});

Deno.test({
  name: "mq/consumer: JudgeResult 合法时可通过 saveEvaluationResult 持久化",
  ignore: !hasDb,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await setupTestData();
    const { saveEvaluationResult } = await import(
      "../../src/services/submissions.ts"
    );
    await saveEvaluationResult({
      submission_id: SUBMISSION_ID,
      status: "Accepted",
      score: 1000,
      output: '---RESULT---\n{"status":"Accepted"}',
      details: { cases: [{ status: "Accepted", score: 1000 }] },
      time_ms: 42,
      memory_kb: 8192,
    });

    const exists = await assertResultExists(SUBMISSION_ID);
    assertEquals(exists, true, "评测结果应已持久化到 evaluation_results");
  },
});

Deno.test({
  name: "mq/consumer: 多条消息 BRPOP 按 LPUSH 逆序取出（后入先出）",
  ignore: !hasDb,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const fake = startFakeRedis();
    try {
      await fakeLpush(fake.url, "test:q", "msg1");
      await fakeLpush(fake.url, "test:q", "msg2");

      resetRedisForTest();
      Deno.env.set("REDIS_URL", fake.url);
      const redis = getRedis();
      await redis.connect();
      await redis.ping();
      // deno-lint-ignore no-explicit-any
      const first = await (redis as any).brpop("test:q", 2);
      // deno-lint-ignore no-explicit-any
      const second = await (redis as any).brpop("test:q", 2);
      resetRedisForTest();
      Deno.env.delete("REDIS_URL");

      assertEquals(first[1], "msg2", "后入应先出（LPUSH 语义）");
      assertEquals(second[1], "msg1", "先入后出");
    } finally {
      await fake.stop();
    }
  },
});
