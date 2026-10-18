// 仅对独立本机 Redis 运行，验证生产 UI 的跨副本缓存与真实连接故障降级。
import { strict as assert } from "node:assert";
import { Redis } from "ioredis";

const redisUrl = Deno.env.get("BFF_TEST_REDIS_URL");
assert(
  redisUrl && ["127.0.0.1", "localhost"].includes(new URL(redisUrl).hostname),
  "请通过 BFF_TEST_REDIS_URL 指定本机测试 Redis",
);
const prefix = `noj:test:bff:${crypto.randomUUID()}`;
let metadataReads = 0;
const core = Deno.serve(
  { hostname: "127.0.0.1", port: 0, onListen() {} },
  (request) => {
    const path = new URL(request.url).pathname;
    if (path === "/api/v1/domains/cache-test") {
      return Response.json({
        data: {
          slug: "cache-test",
          actor_id: null,
          permissions: [],
          configuration: { features: { community: false, assignment: false } },
        },
      });
    }
    if (path === "/api/v1/site/meta") {
      assert.equal(
        request.headers.get("authorization"),
        null,
        "公共元信息必须匿名回源",
      );
      metadataReads++;
      return Response.json({ data: { icp_number: "缓存验证" } });
    }
    if (path.endsWith("/problems")) {
      return Response.json({
        total: 0,
        items: [],
      });
    }
    return Response.json({ data: [] });
  },
);
const children = [];
async function start(connection) {
  const listener = Deno.listen({ hostname: "127.0.0.1", port: 0 });
  const port = listener.addr.port;
  listener.close();
  const child = new Deno.Command(Deno.execPath(), {
    args: [
      "run",
      "-A",
      "--unstable-byonm",
      "--unstable-node-globals",
      ".output/server/index.mjs",
    ],
    env: {
      HOST: "127.0.0.1",
      PORT: String(port),
      NODE_ENV: "production",
      NUXT_API_BASE: `http://127.0.0.1:${core.addr.port}`,
      NUXT_BFF_REDIS_URL: connection,
      NUXT_BFF_CACHE_PREFIX: prefix,
    },
    stdout: "null",
    stderr: "inherit",
  }).spawn();
  children.push(child);
  const url = `http://127.0.0.1:${port}/api/bff/v1/domains/cache-test/home`;
  for (let i = 0; i < 80; i++) {
    try {
      const r = await fetch(url);
      await r.arrayBuffer();
      if (r.ok) return url;
    } catch { /* 等待服务 */ }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("生产 UI 未就绪");
}
const redis = new Redis(redisUrl, { maxRetriesPerRequest: 0 });
try {
  const first = await start(redisUrl);
  const warmed = await fetch(first);
  await warmed.arrayBuffer();
  const second = await start(redisUrl);
  metadataReads = 0;
  const response = await fetch(second);
  const result = await response.json();
  assert.equal(response.status, 200);
  assert(response.headers.get("server-timing")?.includes('cache;desc="hit"'));
  assert.equal(result.sections.siteMeta.data.data.icp_number, "缓存验证");
  assert.equal(metadataReads, 0, "第二副本必须命中同一 Redis 缓存");
  const keys = await redis.keys(`${prefix}:*site-meta`);
  assert.equal(keys.length, 1);
  const ttl = await redis.ttl(keys[0]);
  assert(ttl > 0 && ttl <= 30, `TTL 应为 30 秒以内，实际 ${ttl}`);
  const unavailable = await start("redis://127.0.0.1:1");
  metadataReads = 0;
  const fallback = await fetch(unavailable);
  await fallback.arrayBuffer();
  assert.equal(fallback.status, 200);
  assert(
    fallback.headers.get("server-timing")?.includes('cache;desc="bypass"'),
  );
  assert.equal(metadataReads, 1);
  console.log(
    JSON.stringify({
      replicas: 2,
      secondReplicaMetadataReads: 0,
      ttl,
      redisFailureStatus: fallback.status,
    }),
  );
} finally {
  for (const child of children) {
    try {
      child.kill("SIGTERM");
    } catch { /* 已退出 */ }
    await child.status;
  }
  const keys = await redis.keys(`${prefix}:*`).catch(() => []);
  if (keys.length) await redis.del(...keys);
  redis.disconnect();
  await core.shutdown();
}
