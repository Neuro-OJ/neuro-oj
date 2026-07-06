/**
 * MQ Producer 单元测试。
 *
 * 测试 pushJudgeTask 在各种场景下的行为：
 * - 成功 LPUSH
 * - 连接不可用时抛错
 * - 消息超过 16MB 限制时抛错
 * - 消息格式正确
 *
 * 依赖：fake Redis（通过 REDIS_URL 环境变量注入）。
 * 如果测试需要实际的 Redis，可以通过设置 REDIS_URL 来使用真实 Redis。
 */

import { assertEquals, assertRejects } from "jsr:@std/assert@^1";
import { pushJudgeTask } from "../../src/mq/producer.ts";
import { getRedis, resetRedisForTest } from "../../src/mq/connection.ts";
import { resetDbForTest } from "../../src/db/connection.ts";
import { startFakeRedis, type FakeRedis } from "./_setup.ts";
import type { JudgeTask } from "../../src/types/index.ts";

const hasDb = true; // PGlite 内存数据库始终可用

// ── 测试用 JudgeTask ────────────────────────────────

function makeTask(overrides?: Partial<JudgeTask>): JudgeTask {
  return {
    submission_id: "test-sub-001",
    problem_id: "1001",
    judge_image: "noj-judge-python",
    judge_command: "python3 /tmp/evaluate.py",
    download_url: "noj-download://base64/?content=",
    language: "python3",
    code: "print(42)",
    file_name: "submission.py",
    time_limit_ms: 5000,
    memory_limit_mb: 256,
    ...overrides,
  };
}

Deno.test({
  name: "mq/producer: pushJudgeTask 成功 LPUSH",
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
      await redis.ping(); // 使状态变为 ready

      const task = makeTask();
      const queueLen = await pushJudgeTask(task);
      assertEquals(typeof queueLen, "number", "应返回数字（队列长度）");
      assertEquals(queueLen > 0, true, "队列长度应大于 0");

      // 验证消息被推送
      const messages = fake.getMessages("noj:judge:queue");
      assertEquals(messages.length, 1, "应有 1 条消息在队列中");

      // 验证消息可反序列化为合法的 JudgeTask
      const parsed = JSON.parse(messages[0]) as JudgeTask;
      assertEquals(parsed.submission_id, "test-sub-001");
      assertEquals(parsed.judge_image, "noj-judge-python");
      assertEquals(parsed.code, "print(42)");
    } finally {
      await fake.stop();
      resetRedisForTest();
      Deno.env.delete("REDIS_URL");
    }
  },
});

Deno.test({
  name: "mq/producer: Redis 连接不可用时抛错",
  ignore: !hasDb,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const fake = startFakeRedis();
    try {
      resetRedisForTest();
      Deno.env.set("REDIS_URL", fake.url);

      // 不调用 getRedis().connect() — 状态不是 ready
      // pushJudgeTask 检查 redis.status !== "ready" 时抛错
      await assertRejects(
        async () => {
          await pushJudgeTask(makeTask());
        },
        Error,
        "Redis 连接不可用",
      );
    } finally {
      await fake.stop();
      resetRedisForTest();
      Deno.env.delete("REDIS_URL");
    }
  },
});

Deno.test({
  name: "mq/producer: 消息超过 16MB 时抛错",
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

      // 构造一个超大的 code（>16MB）
      const largeCode = "x".repeat(17 * 1024 * 1024); // 17MB
      const task = makeTask({ code: largeCode });

      await assertRejects(
        async () => {
          await pushJudgeTask(task);
        },
        Error,
        "超过大小限制",
      );
    } finally {
      await fake.stop();
      resetRedisForTest();
      Deno.env.delete("REDIS_URL");
    }
  },
});

Deno.test({
  name: "mq/producer: 消息格式正确（JSON 包含所有关键字段）",
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

      const task = makeTask({
        submission_id: "test-format-42",
        time_limit_ms: 3000,
        memory_limit_mb: 128,
      });
      await pushJudgeTask(task);

      const messages = fake.getMessages("noj:judge:queue");
      const parsed = JSON.parse(messages[0]) as Record<string, unknown>;

      // 验证所有关键字段存在且类型正确
      assertEquals(typeof parsed.submission_id, "string");
      assertEquals(typeof parsed.judge_image, "string");
      assertEquals(typeof parsed.code, "string");
      assertEquals(typeof parsed.time_limit_ms, "number");
      assertEquals(typeof parsed.memory_limit_mb, "number");
      assertEquals(parsed.language, "python3");
      assertEquals(parsed.file_name, "submission.py");

      // 验证 JSON 序列化结果在 LPUSH 中正确传递
      assertEquals(parsed.submission_id, "test-format-42");
      assertEquals(parsed.time_limit_ms, 3000);
    } finally {
      await fake.stop();
      resetRedisForTest();
      Deno.env.delete("REDIS_URL");
    }
  },
});
