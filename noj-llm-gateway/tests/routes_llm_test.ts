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
  // G-04：调用前被拒不保存 prompt 原文，只留哈希
  assertEquals(usageInserts[0].request_messages, "[]");
  assertEquals(typeof usageInserts[0].prompt_hash, "string");
});

Deno.test("llm route: 调用前拒绝按提交+原因去重，重复拒绝不再落库（G-04）", async () => {
  const provider = await makeProvider(testConfig.storeKey);
  const { db, usageInserts } = createFakeDb(provider);
  const redis = new FakeRedis();
  redis.evalResults = [
    "rate_limit_exceeded",
    "rate_limit_exceeded",
    "rate_limit_exceeded",
    "limit_exceeded",
  ];
  const app = createLlmRouter({ config: testConfig, db, redis });
  const token = await makeToken(testConfig);
  const big = "x".repeat(32 * 1024);

  for (let i = 0; i < 4; i++) {
    const res = await requestChat(app, token, {
      model: "deepseek-chat",
      messages: [{ role: "user", content: big }],
    });
    assertEquals(res.status, 429);
  }
  // 三次 rate_limit_exceeded 只记一条；不同原因 limit_exceeded 另记一条
  assertEquals(usageInserts.length, 2);
  assertEquals(
    usageInserts.map((r) => r.error_code),
    ["rate_limit_exceeded", "limit_exceeded"],
  );
  for (const row of usageInserts) {
    assertEquals(row.request_messages, "[]");
  }
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

Deno.test("llm route: 已吊销的 eval_token 返回 401 token_revoked", async () => {
  const provider = await makeProvider(testConfig.storeKey);
  const { db } = createFakeDb(provider);
  const redis = new FakeRedis();
  // 模拟已吊销状态
  redis.get = (key: string) =>
    Promise.resolve(key.startsWith("llm:token:revoked:") ? "1" : null);
  const app = createLlmRouter({ config: testConfig, db, redis });
  const token = await makeToken(testConfig);

  const res = await requestChat(app, token, {
    model: "deepseek-chat",
    messages: [{ role: "user", content: "ping" }],
  });

  assertEquals(res.status, 401);
  const body = await res.json();
  assertEquals(body.error, "token_revoked");
});

Deno.test("llm route: 拒绝 stream: true 请求返回 400", async () => {
  const provider = await makeProvider(testConfig.storeKey);
  const { db } = createFakeDb(provider);
  const redis = new FakeRedis();
  const app = createLlmRouter({ config: testConfig, db, redis });
  const token = await makeToken(testConfig);

  const res = await requestChat(app, token, {
    model: "deepseek-chat",
    messages: [{ role: "user", content: "ping" }],
    stream: true,
  });

  assertEquals(res.status, 400);
  const body = await res.json();
  assertEquals(body.error, "stream_not_supported");
});

Deno.test("llm route: 超大上游响应触发 upstream_response_too_large 返回 502", async () => {
  const provider = await makeProvider(testConfig.storeKey);
  const { db, usageInserts } = createFakeDb(provider);
  const redis = new FakeRedis();
  const app = createLlmRouter({ config: testConfig, db, redis });
  const token = await makeToken(testConfig);

  // 构造流式返回超过 10MB 的 Response
  const stream = new ReadableStream({
    start(controller) {
      const chunk = new Uint8Array(2 * 1024 * 1024); // 2MB
      chunk.fill(65);
      for (let i = 0; i < 6; i++) {
        controller.enqueue(chunk); // 12MB total
      }
      controller.close();
    },
  });

  const restore = stubFetch(() =>
    Promise.resolve(
      new Response(stream, {
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

    assertEquals(res.status, 502);
    const body = await res.json();
    assertEquals(body.error, "upstream_response_too_large");
    assertEquals(usageInserts.length, 1);
    assertEquals(usageInserts[0].error_code, "upstream_response_too_large");
  } finally {
    restore();
  }
});
