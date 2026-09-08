import { assertEquals } from "jsr:@std/assert@^1";
import { createLlmRouter } from "../src/routes/llm.ts";
import {
  createFakeDb,
  FakeRedis,
  makeProvider,
  makeToken,
  requestChat,
  testConfig,
} from "./helpers.ts";

Deno.test("llm route: 限流超限返回 429 并记录 rejected", async () => {
  const provider = await makeProvider(testConfig.storeKey);
  const { db, usageInserts } = createFakeDb(provider);
  const redis = new FakeRedis();
  redis.evalResults = ["limit_exceeded"];
  const app = createLlmRouter({ config: testConfig, db, redis });
  const token = await makeToken(testConfig);

  const res = await requestChat(app, token, {
    model: "deepseek-chat",
    messages: [{ role: "user", content: "ping" }],
    max_tokens: 5,
  });

  assertEquals(res.status, 429);
  const body = await res.json();
  assertEquals(body.error.code, "out_of_usage");
  assertEquals(usageInserts.length, 1);
  assertEquals(usageInserts[0].status, "rejected");
  assertEquals(usageInserts[0].error_code, "limit_exceeded");
});

Deno.test("llm route: 分钟速率超限返回 429 并记录 rejected", async () => {
  const provider = await makeProvider(testConfig.storeKey);
  const { db, usageInserts } = createFakeDb(provider);
  const redis = new FakeRedis();
  redis.evalResults = ["rate_limit_exceeded"];
  const app = createLlmRouter({ config: testConfig, db, redis });
  const token = await makeToken(testConfig);

  const res = await requestChat(app, token, {
    model: "deepseek-chat",
    messages: [{ role: "user", content: "ping" }],
  });

  assertEquals(res.status, 429);
  const body = await res.json();
  assertEquals(body.error.code, "out_of_usage");
  assertEquals(usageInserts[0].error_code, "rate_limit_exceeded");
});
