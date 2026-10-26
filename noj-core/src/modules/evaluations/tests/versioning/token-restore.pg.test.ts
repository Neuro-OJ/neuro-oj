import { assertEquals } from "jsr:@std/assert@^1";
import { getDb } from "../../../../shared/db/connection.ts";
import {
  getRedis,
  resetRedisForTest,
} from "../../../../shared/mq/connection.ts";
import { resetDbForTest } from "../../../../../tests/helpers/db.ts";
import { llmTokenRevocations } from "../../../../shared/db/schema.ts";
import {
  attemptTokenRevocationNow,
  enqueueAttemptTokenRevocation,
  restoreAttemptTokenRevocations,
  runPendingTokenRevocations,
  TOKEN_REVOCATIONS_READY_KEY,
} from "../../services/versioning/token-revocation.ts";

Deno.test("token restore[真实 PG/Redis]: done 吊销在标记丢失和旧世代后恢复，不刷新原有效期", async () => {
  await resetDbForTest();
  const db = getDb(), redis = getRedis();
  if (redis.status === "wait") await redis.connect();
  const attempts = [
    crypto.randomUUID(),
    crypto.randomUUID(),
    crypto.randomUUID(),
  ];
  try {
    for (const attemptId of attempts) {
      await db.transaction((tx) =>
        enqueueAttemptTokenRevocation(tx, { attemptId, ttlSeconds: 3600 })
      );
      assertEquals(await attemptTokenRevocationNow(attemptId), true);
      await redis.del(`llm:attempt:revoked:${attemptId}`);
    }
    await db.insert(llmTokenRevocations).values({
      id: crypto.randomUUID(),
      attempt_id: "expired",
      state: "done",
      ttl_seconds: 60,
      created_at: "2000-01-01T00:00:00.000Z",
    });
    await redis.set(TOKEN_REVOCATIONS_READY_KEY, "old-server");
    // 小批次强制跨页，所有 done 行均须恢复后才能发布当前世代 ready。
    await restoreAttemptTokenRevocations(1);
    const info = await redis.info!("server");
    const epoch = info.split("\n").find((line) => line.startsWith("run_id:"))!
      .slice(7).trim();
    assertEquals(await redis.get(TOKEN_REVOCATIONS_READY_KEY), epoch);
    for (const attemptId of attempts) {
      const key = `llm:attempt:revoked:${attemptId}`;
      assertEquals(await redis.get(key), "1");
      assertEquals((await redis.ttl(key)) <= 3600, true);
    }
    assertEquals(await redis.get("llm:attempt:revoked:expired"), null);
    await redis.del(`llm:attempt:revoked:${attempts[0]}`);
    assertEquals((await runPendingTokenRevocations()).processed, 0);
    assertEquals(await redis.get(`llm:attempt:revoked:${attempts[0]}`), "1");
  } finally {
    redis.disconnect();
    resetRedisForTest();
  }
});
