import { assertEquals } from "jsr:@std/assert@^1";
import { createLlmRouter } from "../src/routes/llm.ts";
import {
  createFakeDb,
  FakeRedis,
  makeProvider,
  makeToken,
  publicDns,
  requestChat,
  stubFetch,
  testConfig,
} from "./helpers.ts";

Deno.test("llm route: 限流超限返回 429 并记录 rejected", async () => {
  const provider = await makeProvider(testConfig.storeKey);
  const { db, usageInserts } = createFakeDb(provider);
  const redis = new FakeRedis();
  redis.evalResults = ["limit_exceeded"];
  const app = createLlmRouter({
    config: testConfig,
    db,
    redis,
    resolveDns: publicDns,
  });
  const token = await makeToken(testConfig);

  const restore = stubFetch(() =>
    Promise.reject(new Error("额度不足不得调用上游"))
  );
  let res: Response;
  try {
    res = await requestChat(app, token, {
      model: "deepseek-chat",
      messages: [{ role: "user", content: "ping" }],
      max_tokens: 5,
    });
  } finally {
    restore();
  }

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
  const app = createLlmRouter({
    config: testConfig,
    db,
    redis,
    resolveDns: publicDns,
  });
  const token = await makeToken(testConfig);
  const big = "x".repeat(32 * 1024);

  const restore = stubFetch(() =>
    Promise.reject(new Error("额度不足不得调用上游"))
  );
  try {
    for (let i = 0; i < 4; i++) {
      const res = await requestChat(app, token, {
        model: "deepseek-chat",
        messages: [{ role: "user", content: big }],
      });
      assertEquals(res.status, 429);
    }
  } finally {
    restore();
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
  const app = createLlmRouter({
    config: testConfig,
    db,
    redis,
    resolveDns: publicDns,
  });
  const token = await makeToken(testConfig);

  const restore = stubFetch(() =>
    Promise.reject(new Error("额度不足不得调用上游"))
  );
  let res: Response;
  try {
    res = await requestChat(app, token, {
      model: "deepseek-chat",
      messages: [{ role: "user", content: "ping" }],
    });
  } finally {
    restore();
  }

  assertEquals(res.status, 429);
  const body = await res.json();
  assertEquals(body.error.code, "out_of_usage");
  assertEquals(usageInserts[0].error_code, "rate_limit_exceeded");
});

Deno.test("llm route: 上游超时/网络错误返回 502 并记录 error", async () => {
  const provider = await makeProvider(testConfig.storeKey);
  const { db, usageInserts } = createFakeDb(provider);
  const redis = new FakeRedis();
  const app = createLlmRouter({
    config: testConfig,
    db,
    redis,
    resolveDns: publicDns,
  });
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
  const app = createLlmRouter({
    config: testConfig,
    db,
    redis,
    resolveDns: publicDns,
  });
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
  const app = createLlmRouter({
    config: testConfig,
    db,
    redis,
    resolveDns: publicDns,
  });
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
  const app = createLlmRouter({
    config: testConfig,
    db,
    redis,
    resolveDns: publicDns,
  });
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
  const app = createLlmRouter({
    config: testConfig,
    db,
    redis,
    resolveDns: publicDns,
  });
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
    Promise.resolve(key.startsWith("llm:attempt:revoked:") ? "1" : null);
  const app = createLlmRouter({
    config: testConfig,
    db,
    redis,
    resolveDns: publicDns,
  });
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
  const app = createLlmRouter({
    config: testConfig,
    db,
    redis,
    resolveDns: publicDns,
  });
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
  const app = createLlmRouter({
    config: testConfig,
    db,
    redis,
    resolveDns: publicDns,
  });
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

Deno.test("llm route: Provider RPM 超限排队超时返回 429 + Retry-After，且不扣用户额度", async () => {
  const provider = {
    ...(await makeProvider(testConfig.storeKey)),
    domain_id: "school-timeout",
    rpm_limit: 1,
  };
  const { db, usageInserts } = createFakeDb(provider);
  const redis = new FakeRedis();
  // 节流脚本始终返回「队首，2 秒后窗口才有余量」，其后是退出排队脚本的返回
  redis.evalResults = [[0, 2000, 0], [0, 2000, 0], [0, 2000, 0], 1];
  const restore = stubFetch(() => {
    throw new Error("排队超时的请求不应转发上游");
  });
  try {
    const app = createLlmRouter({
      config: { ...testConfig, providerQueueTimeoutMs: 30 },
      db,
      redis,
      resolveDns: publicDns,
    });
    const token = await makeToken(testConfig, "fast", {
      domainId: provider.domain_id,
      modelMap: { fast: "upstream-school-model" },
    });
    const res = await requestChat(app, token, {
      model: "fast",
      messages: [{ role: "user", content: "ping" }],
      max_tokens: 5,
    });

    assertEquals(res.status, 429);
    assertEquals(res.headers.get("retry-after"), "2");
    const body = await res.json();
    assertEquals(body.error.code, "provider_queue_timeout");
    assertEquals(usageInserts.length, 1);
    assertEquals(usageInserts[0].status, "rejected");
    assertEquals(usageInserts[0].error_code, "provider_queue_timeout");
    assertEquals(usageInserts[0].domain_id, provider.domain_id);
    assertEquals(usageInserts[0].model, "upstream-school-model");
    assertEquals(
      JSON.parse(String(usageInserts[0].request_params)).model_alias,
      "fast",
    );
    // 只调用了 Provider 节流脚本（键均为 llm:provider:{prov-1}:*），未执行用户额度扣减
    for (const keys of redis.evalKeys) {
      assertEquals(
        keys.every((k) => k.startsWith("llm:provider:{prov-1}:")),
        true,
      );
    }
  } finally {
    restore();
  }
});

Deno.test("llm route: 未配置 RPM/TPM 时不访问 Provider 节流", async () => {
  const provider = await makeProvider(testConfig.storeKey);
  const { db } = createFakeDb(provider);
  const redis = new FakeRedis();
  const restore = stubFetch(() =>
    Promise.resolve(
      new Response(
        JSON.stringify({
          choices: [{ message: { content: "pong" } }],
          usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 },
        }),
        { status: 200 },
      ),
    )
  );
  try {
    const app = createLlmRouter({
      config: testConfig,
      db,
      redis,
      resolveDns: publicDns,
    });
    const token = await makeToken(testConfig);
    const res = await requestChat(app, token, {
      model: "deepseek-chat",
      messages: [{ role: "user", content: "ping" }],
      max_tokens: 5,
    });
    assertEquals(res.status, 200);
    assertEquals(
      redis.evalKeys.some((keys) =>
        keys.some((k) => k.startsWith("llm:provider:"))
      ),
      false,
    );
  } finally {
    restore();
  }
});

Deno.test("llm route: 模型别名转发前改写为真实模型名，审计记录真实名与别名", async () => {
  const provider = {
    ...(await makeProvider(testConfig.storeKey)),
    domain_id: "school-alias",
    rpm_limit: 60,
    tpm_limit: 1000,
  };
  const { db, usageInserts } = createFakeDb(provider);
  const redis = new FakeRedis();
  redis.evalResults = [[1, 0, 0]];
  let upstreamModel = "";
  const restore = stubFetch((_url, init) => {
    upstreamModel = JSON.parse(String(init?.body)).model;
    return Promise.resolve(
      new Response(
        JSON.stringify({
          choices: [{ message: { content: "ok" } }],
          usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 },
        }),
        { status: 200 },
      ),
    );
  });
  try {
    const app = createLlmRouter({
      config: testConfig,
      db,
      redis,
      resolveDns: publicDns,
    });
    const token = await makeToken(testConfig, "fast", {
      domainId: provider.domain_id,
      modelMap: { fast: "Qwen/Qwen3-8B" },
    });
    const res = await requestChat(app, token, {
      model: "fast",
      messages: [{ role: "user", content: "ping" }],
      max_tokens: 5,
    });
    assertEquals(res.status, 200);
    assertEquals(upstreamModel, "Qwen/Qwen3-8B");
    assertEquals(usageInserts.at(-1)?.domain_id, provider.domain_id);
    assertEquals(usageInserts.at(-1)?.model, "Qwen/Qwen3-8B");
    const params = usageInserts.at(-1)?.request_params;
    const parsed = typeof params === "string" ? JSON.parse(params) : params;
    assertEquals((parsed as Record<string, unknown>).model_alias, "fast");
    assertEquals(
      redis.evalKeys.some((keys) => keys.includes("llm:provider:{prov-1}:rpm")),
      true,
    );
  } finally {
    restore();
  }
});

Deno.test("llm route: v3 别名 token 不越过 Provider 使用域或停用状态", async () => {
  const provider = {
    ...(await makeProvider(testConfig.storeKey)),
    domain_id: "school-a",
  };
  const { db, usageInserts } = createFakeDb(provider);
  const redis = new FakeRedis();
  const app = createLlmRouter({
    config: testConfig,
    db,
    redis,
    resolveDns: publicDns,
  });
  const restore = stubFetch(() => {
    throw new Error("无权使用 Provider 时不得调用上游");
  });
  try {
    const token = (domainId: string) =>
      makeToken(testConfig, "fast", {
        domainId,
        modelMap: { fast: "frozen-model" },
      });
    const body = {
      model: "fast",
      messages: [{ role: "user", content: "ping" }],
    };
    const foreign = await requestChat(app, await token("school-b"), body);
    assertEquals(foreign.status, 400);
    assertEquals((await foreign.json()).error, "provider_not_found");
    provider.enabled = false;
    const disabled = await requestChat(app, await token("school-a"), body);
    assertEquals(disabled.status, 403);
    assertEquals((await disabled.json()).error, "provider_disabled");
    assertEquals(usageInserts.length, 0);
    assertEquals(redis.evalKeys.length, 0);
  } finally {
    restore();
  }
});

Deno.test("llm route: model_map 缺少别名映射时拒绝（403）", async () => {
  const provider = await makeProvider(testConfig.storeKey);
  const { db } = createFakeDb(provider);
  const app = createLlmRouter({
    config: testConfig,
    db,
    redis: new FakeRedis(),
    resolveDns: publicDns,
  });
  const token = await makeToken(testConfig, "fast", {
    modelMap: { other: "x" },
  });
  const res = await requestChat(app, token, {
    model: "fast",
    messages: [{ role: "user", content: "ping" }],
  });
  assertEquals(res.status, 403);
});
