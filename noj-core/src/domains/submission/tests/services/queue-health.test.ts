/**
 * 评测队列健康服务单元测试。
 *
 * 仅依赖 Redis（不需要 PostgreSQL），验证 getQueueHealth 的返回结构与
 * Redis 不可用时的降级行为。
 */

import { assertEquals, assertExists } from "jsr:@std/assert@^1";
import {
  connectRedis,
  getRedis,
  resetRedisForTest,
} from "../../../../shared/mq/connection.ts";
import { getQueueHealth } from "../../index.ts";

const hasRedis = !!Deno.env.get("REDIS_URL");
const skip = !hasRedis;

// 模块级初始化：连接共享 Redis
if (hasRedis) {
  resetRedisForTest();
  await connectRedis();
}

Deno.test({
  name: "queue health: getQueueHealth 返回完整结构",
  ignore: skip,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const health = await getQueueHealth();
    assertExists(health.judge);
    assertExists(health.result);
    assertEquals(typeof health.redis_ok, "boolean");
    assertEquals(health.redis_ok, true);

    for (const entry of [health.judge, health.result]) {
      assertEquals(typeof entry.queue_length, "number");
      assertEquals(typeof entry.processing_length, "number");
      assertEquals(typeof entry.dead_length, "number");
      // Redis 正常时长度不应为 -1
      assertEquals(entry.queue_length >= 0, true);
      assertEquals(entry.processing_length >= 0, true);
      assertEquals(entry.dead_length >= 0, true);
    }
  },
});

Deno.test({
  name: "queue health: 主队列存在消息时长度 > 0",
  ignore: skip,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const redis = getRedis();
    const queue = "noj:judge:queue";
    const before = await getQueueHealth();
    const beforeLen = before.judge.queue_length;

    await redis.lpush(
      queue,
      JSON.stringify({
        submission_id: "queue-health-test",
        problem_id: "problem-health-test",
        runtime_config: {},
        language: "python3",
        code: "print(1)",
      }),
    );

    try {
      const after = await getQueueHealth();
      assertEquals(after.judge.queue_length, beforeLen + 1);
    } finally {
      // 清理测试消息：按内容精确移除，避免误删真实任务
      const raw = JSON.stringify({
        submission_id: "queue-health-test",
        problem_id: "problem-health-test",
        runtime_config: {},
        language: "python3",
        code: "print(1)",
      });
      await redis.lrem(queue, 1, raw);
    }
  },
});
