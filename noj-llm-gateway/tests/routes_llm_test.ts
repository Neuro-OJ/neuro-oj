import { assertEquals } from "jsr:@std/assert@^1";
import { createLlmRouter } from "../src/routes/llm.ts";
import {
  createFakeDb,
  FakeRedis,
  makeProvider,
  makeToken,
  requestChat,
  stubFetch,
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

Deno.test("llm route: 上游超时/网络错误返回 502 并记录 error", async () => {
  const provider = await makeProvider(testConfig.storeKey);
  const { db, usageInserts } = createFakeDb(provider);
  const redis = new FakeRedis();
  const app = createLlmRouter({ config: testConfig, db, redis });
  const token = await makeToken(testConfig);
  const restore = stubFetch(() => {
    throw new Error("timeout");
  });

  try {
    const res = await requestChat(app, token, {
      model: "deepseek-chat",
      messages: [{ role: "user", content: "ping" }],
    });

    assertEquals(res.status, 502);
    const body = await res.json();
    assertEquals(body.error, "upstream_error");
    assertEquals(usageInserts.length, 1);
    assertEquals(usageInserts[0].status, "error");
    assertEquals(usageInserts[0].error_code, "upstream_error");
  } finally {
    restore();
  }
});

Deno.test("llm route: 上游 5xx 透传状态码并记录 error", async () => {
  const provider = await makeProvider(testConfig.storeKey);
  const { db, usageInserts } = createFakeDb(provider);
  const redis = new FakeRedis();
  const app = createLlmRouter({ config: testConfig, db, redis });
  const token = await makeToken(testConfig);
  const restore = stubFetch(() =>
    Promise.resolve(
      new Response(JSON.stringify({ error: "boom" }), {
        status: 500,
        headers: { "content-type": "application/json" },
      }),
    )
  );

  try {
    const res = await requestChat(app, token, {
      model: "deepseek-chat",
      messages: [{ role: "user", content: "ping" }],
    });

    assertEquals(res.status, 500);
    const body = await res.json();
    assertEquals(body.error, "upstream_error");
    assertEquals(body.status, 500);
    assertEquals(usageInserts[0].status, "error");
    assertEquals(usageInserts[0].error_code, "500");
  } finally {
    restore();
  }
});

Deno.test("llm route: 上游畸形 JSON 不崩溃并记录 ok", async () => {
  const provider = await makeProvider(testConfig.storeKey);
  const { db, usageInserts } = createFakeDb(provider);
  const redis = new FakeRedis();
  const app = createLlmRouter({ config: testConfig, db, redis });
  const token = await makeToken(testConfig);
  const restore = stubFetch(() =>
    Promise.resolve(
      new Response("not-json", {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    )
  );

  try {
    const res = await requestChat(app, token, {
      model: "deepseek-chat",
      messages: [{ role: "user", content: "ping" }],
    });

    assertEquals(res.status, 200);
    assertEquals(await res.json(), null);
    assertEquals(usageInserts.length, 1);
    assertEquals(usageInserts[0].status, "ok");
    assertEquals(usageInserts[0].error_code, null);
  } finally {
    restore();
  }
});

Deno.test("llm route: 成功响应按 billed-token 审计", async () => {
  const provider = await makeProvider(testConfig.storeKey);
  const { db, usageInserts } = createFakeDb(provider);
  const redis = new FakeRedis();
  const app = createLlmRouter({ config: testConfig, db, redis });
  const token = await makeToken(testConfig);
  const upstream = {
    choices: [{ message: { role: "assistant", content: "pong" } }],
    usage: {
      prompt_tokens: 200,
      completion_tokens: 30,
      total_tokens: 230,
      prompt_tokens_details: { cached_tokens: 180 },
    },
  };
  const restore = stubFetch(() =>
    Promise.resolve(
      new Response(JSON.stringify(upstream), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    )
  );

  try {
    const res = await requestChat(app, token, {
      model: "deepseek-chat",
      messages: [{ role: "user", content: "ping" }],
      max_tokens: 5,
    });

    assertEquals(res.status, 200);
    assertEquals(usageInserts.length, 1);
    assertEquals(usageInserts[0].billed_prompt_tokens, 20);
    assertEquals(usageInserts[0].billed_total_tokens, 50);
    assertEquals(usageInserts[0].status, "ok");
    assertEquals(usageInserts[0].error_code, null);
  } finally {
    restore();
  }
});

Deno.test("llm route: settle 超限返回 429 并记录 rejected", async () => {
  const provider = await makeProvider(testConfig.storeKey);
  const { db, usageInserts } = createFakeDb(provider);
  const redis = new FakeRedis();
  redis.evalResults = ["ok", "limit_exceeded"];
  const app = createLlmRouter({ config: testConfig, db, redis });
  const token = await makeToken(testConfig);
  const upstream = {
    choices: [{ message: { role: "assistant", content: "pong" } }],
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
  };
  const restore = stubFetch(() =>
    Promise.resolve(
      new Response(JSON.stringify(upstream), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    )
  );

  try {
    const res = await requestChat(app, token, {
      model: "deepseek-chat",
      messages: [{ role: "user", content: "ping" }],
    });

    assertEquals(res.status, 429);
    assertEquals(usageInserts.length, 1);
    assertEquals(usageInserts[0].status, "rejected");
    assertEquals(usageInserts[0].error_code, "limit_exceeded");
  } finally {
    restore();
  }
});
