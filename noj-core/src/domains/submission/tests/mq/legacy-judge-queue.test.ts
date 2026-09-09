/**
 * 旧单队列迁移单元测试。
 *
 * 覆盖：
 * - `withLegacyPriority` 为旧消息补 priority（已有则保持不变，坏消息返回 null）；
 * - 旧主队列 / 旧 processing 列表中的消息被搬到 medium 队列；
 * - 无法解析的消息保留原位、不阻断其他消息迁移；
 * - 迁移可重入（第二次运行不重复投递）。
 *
 * 依赖：fake Redis（通过 REDIS_URL 环境变量注入）。
 */

import { assertEquals } from "jsr:@std/assert@^1";
import {
  getRedis,
  resetRedisForTest,
} from "../../../../shared/mq/connection.ts";
import {
  JUDGE_QUEUES,
  LEGACY_JUDGE_QUEUE,
} from "../../../../shared/mq/judge-queues.ts";
import {
  LEGACY_PROCESSING_QUEUE,
  migrateLegacyJudgeQueue,
  withLegacyPriority,
} from "../../mq/legacy-judge-queue.ts";
import { startFakeRedis } from "./_setup.ts";

function legacyRaw(submissionId: string): string {
  return JSON.stringify({
    submission_id: submissionId,
    problem_id: "1001",
    user_id: "u-1",
    runtime_config: {
      evaluator: {
        image: "noj-evaluator-python",
        command: "python3 /workspace/evaluate.py",
        time_limit_ms: 5000,
        memory_limit_mb: 512,
      },
      solution: {
        image: "noj-solution-python",
        call_timeout_ms: 2000,
        memory_limit_mb: 512,
      },
    },
    language: "python3",
    code: "print(1)",
  });
}

Deno.test("legacy-judge-queue: withLegacyPriority 补 medium 且幂等", () => {
  const raw = legacyRaw("s-1");
  const migrated = withLegacyPriority(raw);
  assertEquals(migrated !== null, true);
  assertEquals(JSON.parse(migrated!).priority, "medium");
  // 已有 priority 的消息原样返回
  const withPriority = JSON.stringify({ ...JSON.parse(raw), priority: "high" });
  assertEquals(withLegacyPriority(withPriority), withPriority);
  // 坏消息返回 null
  assertEquals(withLegacyPriority("not-json"), null);
});

Deno.test({
  name: "legacy-judge-queue: 旧主队列与 processing 均迁移到 medium",
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

      await redis.lpush(LEGACY_JUDGE_QUEUE, legacyRaw("main-1"));
      await redis.lpush(LEGACY_JUDGE_QUEUE, legacyRaw("main-2"));
      await redis.lpush(LEGACY_PROCESSING_QUEUE, legacyRaw("proc-1"));
      await redis.lpush(LEGACY_JUDGE_QUEUE, "not-json");

      const result = await migrateLegacyJudgeQueue();
      assertEquals(result.fromMain, 2);
      assertEquals(result.fromProcessing, 1);
      assertEquals(result.unparsable, 1);

      const medium = fake.getMessages(JUDGE_QUEUES.medium);
      assertEquals(medium.length, 3);
      for (const message of medium) {
        assertEquals(JSON.parse(message).priority, "medium");
      }
      // 坏消息保留在旧队列，等待人工处理
      assertEquals(fake.getMessages(LEGACY_JUDGE_QUEUE).length, 1);
      assertEquals(fake.getMessages(LEGACY_PROCESSING_QUEUE).length, 0);

      // 可重入：第二次迁移不再搬运任何消息
      const second = await migrateLegacyJudgeQueue();
      assertEquals(second.fromMain, 0);
      assertEquals(second.fromProcessing, 0);
      assertEquals(fake.getMessages(JUDGE_QUEUES.medium).length, 3);
    } finally {
      await fake.stop();
      resetRedisForTest();
      Deno.env.delete("REDIS_URL");
    }
  },
});
