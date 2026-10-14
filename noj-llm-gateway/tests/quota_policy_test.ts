import { assertEquals, assertRejects } from "jsr:@std/assert@^1";
import { capDomainQuota, loadCurrentQuotaCaps } from "../src/quota-policy.ts";
import { createLlmRouter } from "../src/routes/llm.ts";
import {
  createFakeDb,
  FakeRedis,
  makeProvider,
  makeToken,
  publicDns,
  requestChat,
  testConfig,
} from "./helpers.ts";

Deno.test("实例政策：每次读取当前上限，null不解除数值上限", async () => {
  const original = globalThis.fetch;
  let limit = 10, calls = 0;
  globalThis.fetch = (input, init) => {
    assertEquals(
      String(input),
      "http://core.test.invalid/api/v1/internal/llm/quota-caps",
    );
    assertEquals(
      new Headers(init?.headers).get("Authorization"),
      "Bearer " + testConfig.serviceToken,
    );
    calls++;
    return Promise.resolve(
      new Response(
        JSON.stringify({
          data: {
            day: { max_calls: limit, max_tokens: null, max_cost: 3 },
            month: { max_calls: null, max_tokens: null, max_cost: null },
          },
        }),
        { headers: { "content-type": "application/json" } },
      ),
    );
  };
  try {
    const first = await loadCurrentQuotaCaps(testConfig);
    assertEquals(first.day.max_calls, 10);
    limit = 0;
    const second = await loadCurrentQuotaCaps(testConfig);
    assertEquals(second.day.max_calls, 0);
    assertEquals(calls, 2);
    assertEquals(
      capDomainQuota(
        { max_calls: null, max_tokens: 100, max_cost: 1 },
        second.day,
      ),
      { max_calls: 0, max_tokens: 100, max_cost: 1 },
    );
    globalThis.fetch = () => Promise.reject(new Error("offline"));
    await assertRejects(
      () => loadCurrentQuotaCaps(testConfig),
      Error,
      "quota_policy_unavailable",
    );
  } finally {
    globalThis.fetch = original;
  }
});

Deno.test("实例政策不可用：新调用503，未预占、未访问上游", async () => {
  const provider = await makeProvider(testConfig.storeKey);
  const { db, usageInserts } = createFakeDb(provider), redis = new FakeRedis();
  const app = createLlmRouter({
    config: testConfig,
    db,
    redis,
    resolveDns: publicDns,
  });
  const original = globalThis.fetch;
  let upstreamCalls = 0;
  globalThis.fetch = (input) => {
    if (String(input).endsWith("/api/v1/internal/llm/quota-caps")) {
      return Promise.resolve(new Response("{}", { status: 503 }));
    }
    upstreamCalls++;
    return Promise.resolve(new Response("{}"));
  };
  try {
    const response = await requestChat(app, await makeToken(testConfig), {
      model: "deepseek-chat",
      messages: [],
    });
    assertEquals(response.status, 503);
    assertEquals((await response.json()).error, "quota_policy_unavailable");
    assertEquals(upstreamCalls, 0);
    assertEquals(redis.evalKeys.length, 0);
    assertEquals(usageInserts.length, 0);
  } finally {
    globalThis.fetch = original;
  }
});
