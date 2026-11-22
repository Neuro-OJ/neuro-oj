import IORedis from "ioredis";
import { assertEquals } from "jsr:@std/assert@^1";
import { cleanupRedisNamespace } from "../scripts/test-launcher.ts";
import {
  gatewayTestRedisPrefix,
  gatewayTestRedisUrl,
} from "./integration-env.ts";

function createRedis() {
  // @ts-ignore - ioredis 构造函数类型在 Deno 下解析受限
  return new IORedis(gatewayTestRedisUrl, {
    maxRetriesPerRequest: 2,
    lazyConnect: false,
  });
}

Deno.test("Gateway 启动器：两个真实 Redis run 互不消费且只清理目标 prefix", async () => {
  const firstPrefix = `${gatewayTestRedisPrefix}run-a:`;
  const secondPrefix = `${gatewayTestRedisPrefix}run-b:`;
  const firstKeys = Array.from(
    { length: 12 },
    (_, index) => `${firstPrefix}key:${index}`,
  );
  const secondKeys = Array.from(
    { length: 12 },
    (_, index) => `${secondPrefix}key:${index}`,
  );
  const client = createRedis();
  try {
    await Promise.all([
      ...firstKeys.map((key) => client.set(key, "first", "EX", 600)),
      ...secondKeys.map((key) => client.set(key, "second", "EX", 600)),
    ]);
    assertEquals(
      await Promise.all([
        client.get(firstKeys[0]!),
        client.get(secondKeys[0]!),
      ]),
      ["first", "second"],
    );

    await cleanupRedisNamespace(gatewayTestRedisUrl, firstPrefix);

    assertEquals(await client.get(firstKeys[0]!), null);
    assertEquals(await client.get(secondKeys[0]!), "second");
    assertEquals(
      await Promise.all(secondKeys.map((key) => client.get(key))),
      secondKeys.map(() => "second"),
    );
  } finally {
    await cleanupRedisNamespace(gatewayTestRedisUrl, firstPrefix);
    await cleanupRedisNamespace(gatewayTestRedisUrl, secondPrefix);
    await client.quit();
  }
});
