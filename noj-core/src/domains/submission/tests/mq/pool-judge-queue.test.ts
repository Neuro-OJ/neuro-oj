import { assertEquals, assertRejects } from "jsr:@std/assert@^1";
import {
  getRedis,
  resetRedisForTest,
} from "../../../../shared/mq/connection.ts";
import { migratePoolJudgeQueues } from "../../mq/pool-judge-queue.ts";
import { startFakeRedis } from "./_setup.ts";
import fixture from "../../../../../../noj-tests/fixtures/judge-task.contract.json" with {
  type: "json",
};
import oiFixture from "../../../../../../noj-tests/fixtures/judge-task-oi.contract.json" with {
  type: "json",
};

// 使用启动时配置的专用 Redis；其他 MQ 用例会临时替换环境变量。
const testRedis = Deno.env.get("NOJ_TEST_SCHEDULING_REDIS_URL") ??
  Deno.env.get("REDIS_URL");
Deno.test({
  name: "资源池迁移：排空保护、原子搬运、优先级、死信及幂等",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    // CI 使用真实 Redis 验证 Lua；离线模式执行相同搬运契约，绝不静默跳过。
    const fake = testRedis ? undefined : startFakeRedis();
    resetRedisForTest();
    Deno.env.set("REDIS_URL", testRedis ?? fake!.url);
    const redis = getRedis();
    await redis.connect();
    const prefix = `noj:test:pool-migration:${crypto.randomUUID()}`;
    const keys = [
      prefix,
      `${prefix}:processing`,
      `${prefix}:high`,
      `${prefix}:medium`,
      `${prefix}:low`,
      `${prefix}:dead`,
      `${prefix}:layout`,
      `${prefix}:pool-migration-lock`,
      `${prefix}:ai:high`,
      `${prefix}:oi-wasm:medium`,
    ];
    try {
      await redis.lpush(`${prefix}:processing`, "claimed");
      await assertRejects(
        () => migratePoolJudgeQueues(prefix),
        Error,
        "尚未排空",
      );
      await redis.del(`${prefix}:processing`);
      await redis.lpush(
        prefix,
        JSON.stringify({ ...fixture, priority: "high", run_id: "original" }),
      );
      await redis.lpush(
        `${prefix}:medium`,
        JSON.stringify({ ...oiFixture, priority: undefined }),
      );
      await redis.lpush(prefix, "invalid JSON");
      await migratePoolJudgeQueues(prefix);
      const ai = JSON.parse(
        (await redis.lrange(`${prefix}:ai:high`, 0, -1))[0],
      );
      assertEquals(ai.resource_pool, "ai");
      assertEquals(ai.scheduling_version, 1);
      assertEquals(ai.run_id, "original");
      assertEquals(await redis.llen(`${prefix}:oi-wasm:medium`), 1);
      assertEquals(await redis.lrange(`${prefix}:dead`, 0, -1), [
        "invalid JSON",
      ]);
      assertEquals(await redis.get(`${prefix}:layout`), "pools");
      await migratePoolJudgeQueues(prefix);
      assertEquals(await redis.llen(`${prefix}:ai:high`), 1);
      assertEquals(await redis.llen(prefix), 0);
    } finally {
      for (const key of keys) await redis.del(key);
      resetRedisForTest();
      await fake?.stop();
    }
  },
});
