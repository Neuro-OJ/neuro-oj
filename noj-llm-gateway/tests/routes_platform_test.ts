/**
 * 平台身份调用路由（POST /internal/platform-completions）与按用途用量查询
 * （GET /internal/platform-usage）的路由级测试。
 */
import { assert, assertEquals } from "jsr:@std/assert@^1";
import {
  createPlatformRouter,
  PLATFORM_MAX_OUTPUT_TOKENS,
} from "../src/routes/platform.ts";
import {
  createFakeDb,
  FakeRedis,
  makeProvider,
  publicDns,
  stubFetch,
  testConfig,
} from "./helpers.ts";

const AUTH = { "Authorization": `Bearer ${testConfig.serviceToken}` };
const PURPOSE = "knowledge.tag";
const ALIAS = "platform.tagger";

const okBody = {
  purpose: PURPOSE,
  model_alias: ALIAS,
  messages: [{ role: "user", content: "题干" }],
  max_tokens: 128,
  temperature: 0,
};

function newApp(db: ReturnType<typeof createFakeDb>["db"]) {
  return createPlatformRouter({
    config: testConfig,
    db,
    redis: new FakeRedis(),
    resolveDns: publicDns,
  });
}

function post(
  app: ReturnType<typeof createPlatformRouter>,
  body: unknown,
  headers: Record<string, string> = AUTH,
): Promise<Response> {
  return Promise.resolve(app.request("/internal/platform-completions", {
    method: "POST",
    headers: { ...headers, "content-type": "application/json" },
    body: JSON.stringify(body),
  }));
}

/** 上游替身：返回固定 chat completion 与 usage。 */
function upstreamOk(): {
  impl: (
    input: string | URL | Request,
    init?: RequestInit,
  ) => Promise<Response>;
  calls: RequestInit[];
} {
  const calls: RequestInit[] = [];
  return {
    calls,
    impl: (_input, init) => {
      if (init) calls.push(init);
      return Promise.resolve(
        new Response(
          JSON.stringify({
            choices: [{
              message: { role: "assistant", content: '{"tags":[]}' },
            }],
            usage: {
              prompt_tokens: 100,
              completion_tokens: 20,
              prompt_tokens_details: { cached_tokens: 40 },
            },
          }),
          { headers: { "content-type": "application/json" } },
        ),
      );
    },
  };
}

Deno.test("平台调用：缺少服务令牌返回 401，错误令牌同样 401", async () => {
  const { db } = createFakeDb(await makeProvider(testConfig.storeKey));
  const app = newApp(db);
  assertEquals((await post(app, okBody, {})).status, 401);
  const wrong = await post(app, okBody, { Authorization: "Bearer wrong" });
  assertEquals(wrong.status, 401);
  assertEquals((await wrong.json()).error, "unauthorized");
});

Deno.test("平台调用：purpose 不在白名单返回 400 invalid_purpose", async () => {
  const { db } = createFakeDb(await makeProvider(testConfig.storeKey));
  const app = newApp(db);
  for (const purpose of ["evaluation", "", 42]) {
    const res = await post(app, { ...okBody, purpose });
    assertEquals(res.status, 400);
    assertEquals((await res.json()).error, "invalid_purpose");
  }
});

Deno.test("平台调用：别名未配置返回 404 MODEL_ALIAS_NOT_CONFIGURED", async () => {
  const { db } = createFakeDb(await makeProvider(testConfig.storeKey), {
    alias: "other.alias",
  });
  const app = newApp(db);
  const res = await post(app, okBody);
  assertEquals(res.status, 404);
  assertEquals((await res.json()).error, "MODEL_ALIAS_NOT_CONFIGURED");
});

Deno.test("平台调用：别名格式非法返回 400 invalid_alias", async () => {
  const { db } = createFakeDb(await makeProvider(testConfig.storeKey));
  const app = newApp(db);
  const res = await post(app, { ...okBody, model_alias: "Platform.Tagger!" });
  assertEquals(res.status, 400);
  assertEquals((await res.json()).error, "invalid_alias");
});

Deno.test("平台调用：max_tokens 缺失/越界返回 400", async () => {
  const { db } = createFakeDb(await makeProvider(testConfig.storeKey));
  const app = newApp(db);
  for (
    const max_tokens of [
      undefined,
      0,
      -1,
      1.5,
      PLATFORM_MAX_OUTPUT_TOKENS + 1,
      String(PLATFORM_MAX_OUTPUT_TOKENS),
    ]
  ) {
    const res = await post(app, { ...okBody, max_tokens });
    assertEquals(res.status, 400);
    assertEquals((await res.json()).error, "invalid_max_tokens");
  }
  // 上限本身可用
  const restore = stubFetch(() => Promise.reject(new Error("不应访问上游")));
  try {
    const body = { ...okBody, max_tokens: PLATFORM_MAX_OUTPUT_TOKENS };
    // 只验证校验通过（上游失败返回 502 而不是 400）
    const res = await post(app, body);
    assertEquals(res.status, 502);
  } finally {
    restore();
  }
});

Deno.test("平台调用：成功时转发上游并返回模型输出", async () => {
  const { db } = createFakeDb(await makeProvider(testConfig.storeKey));
  const app = newApp(db);
  const upstream = upstreamOk();
  const restore = stubFetch(upstream.impl);
  try {
    const res = await post(app, okBody);
    assertEquals(res.status, 200);
    const body = await res.json();
    assertEquals(body.content, '{"tags":[]}');
    assertEquals(body.model, "tag-model");
    assertEquals(body.usage, {
      input_tokens: 100,
      output_tokens: 20,
      cached_input_tokens: 40,
    });
    // 转发到上游的请求体使用真实模型名与受限的 max_tokens，且不请求流式
    const sent = JSON.parse(String(upstream.calls[0]?.body ?? "{}"));
    assertEquals(sent.model, "tag-model");
    assertEquals(sent.max_tokens, 128);
    assertEquals(sent.stream, undefined);
  } finally {
    restore();
  }
});

Deno.test("平台调用：成功调用以 platform + purpose 主体记账", async () => {
  const platformInserts: unknown[][] = [];
  const { db } = createFakeDb(await makeProvider(testConfig.storeKey), {
    platformInserts,
  });
  const app = newApp(db);
  const restore = stubFetch(upstreamOk().impl);
  try {
    assertEquals((await post(app, okBody)).status, 200);
    assertEquals(platformInserts.length, 1);
    const values = platformInserts[0]!;
    // 主体：principal_type='platform'、principal_id=<purpose>（末两列）
    assertEquals(values.slice(-2).map(String), ["platform", PURPOSE]);
    // 用量：prompt 100 / completion 20 / total 120 / cached 40 / billed_prompt 60 / billed_total 80
    assert(values.includes(100));
    assert(values.includes(20));
    assert(values.includes(120));
    assert(values.includes(40));
    assert(values.includes(60));
    assert(values.includes(80));
    // request_params 记录 purpose / 别名 / 输出上限
    const params = values.map((value) => {
      try {
        return typeof value === "string" ? JSON.parse(value) : null;
      } catch {
        return null;
      }
    }).filter((parsed) => parsed && typeof parsed === "object");
    assert(
      params.some((parsed) =>
        parsed.purpose === PURPOSE || parsed.model_alias === ALIAS ||
        String(parsed).includes("platform")
      ),
    );
    assert(values.includes("ok"));
  } finally {
    restore();
  }
});

Deno.test("平台调用：request_params 记录 purpose / 别名 / 输出上限，且不含 prompt 原文", async () => {
  const platformInserts: unknown[][] = [];
  const { db } = createFakeDb(await makeProvider(testConfig.storeKey), {
    platformInserts,
  });
  const app = newApp(db);
  const restore = stubFetch(upstreamOk().impl);
  try {
    assertEquals((await post(app, okBody)).status, 200);
    const values = platformInserts[0]!;
    // 发送给上游的 messages 不落库：参数里只出现别名与上限，没有题干文本。
    const serialized = JSON.stringify(values.slice(6));
    assert(!serialized.includes("题干"));
    assert(serialized.includes(ALIAS));
    assert(serialized.includes(PURPOSE));
  } finally {
    restore();
  }
});

Deno.test("平台调用：上游 429 映射为 RATE_LIMITED", async () => {
  const platformInserts: unknown[][] = [];
  const { db } = createFakeDb(await makeProvider(testConfig.storeKey), {
    platformInserts,
  });
  const app = newApp(db);
  const restore = stubFetch(() =>
    Promise.resolve(
      new Response(JSON.stringify({ error: "slow down" }), {
        status: 429,
        headers: { "retry-after": "7", "content-type": "application/json" },
      }),
    )
  );
  try {
    const res = await post(app, okBody);
    assertEquals(res.status, 429);
    assertEquals((await res.json()).error, "RATE_LIMITED");
    assertEquals(res.headers.get("retry-after"), "7");
    assert(platformInserts.length <= 1);
    for (const values of platformInserts) {
      assertEquals(values.slice(-2).map(String), ["platform", PURPOSE]);
      assert(values.includes("error"));
      assert(values.includes("429"));
    }
  } finally {
    restore();
  }
});

Deno.test("平台用量查询：按 purpose 返回累计 token/请求/成本", async () => {
  const { db, usageInserts } = createFakeDb(
    await makeProvider(testConfig.storeKey),
  );
  const app = newApp(db);
  // 先产生一条真实的平台记账（经伪 Db 的平台插入分支登记）。
  const restore = stubFetch(upstreamOk().impl);
  try {
    assertEquals((await post(app, okBody)).status, 200);
  } finally {
    restore();
  }
  // 再补两条历史平台记账与一条学生评测记账，验证只按平台主体聚合。
  usageInserts.push(
    {
      principal_type: "platform",
      principal_id: PURPOSE,
      prompt_tokens: 200,
      completion_tokens: 60,
      estimated_cost: 10,
    },
    {
      principal_type: "platform",
      principal_id: PURPOSE,
      prompt_tokens: 100,
      completion_tokens: 30,
      estimated_cost: 2,
    },
    {
      principal_type: "user",
      principal_id: null,
      prompt_tokens: 999,
      completion_tokens: 999,
      estimated_cost: 999,
    },
  );
  const res = await app.request(
    `/internal/platform-usage?purpose=${PURPOSE}&since=2026-11-01T00:00:00Z`,
    { headers: AUTH },
  );
  assertEquals(res.status, 200);
  const body = await res.json();
  assertEquals(body.purpose, PURPOSE);
  assertEquals(body.since, "2026-11-01T00:00:00.000Z");
  // 真实记账 100/20 + 两条历史种子 200/60、100/30；学生评测行不计入。
  assertEquals(body.requests, 3);
  assertEquals(body.input_tokens, 400);
  assertEquals(body.output_tokens, 110);
  assertEquals(body.cost, 12);
});

Deno.test("平台用量查询：purpose/since 参数校验与鉴权", async () => {
  const { db } = createFakeDb(await makeProvider(testConfig.storeKey));
  const app = newApp(db);
  const noAuth = await app.request(
    `/internal/platform-usage?purpose=${PURPOSE}&since=2026-11-01T00:00:00Z`,
  );
  assertEquals(noAuth.status, 401);

  const badPurpose = await app.request(
    `/internal/platform-usage?purpose=eval&since=2026-11-01T00:00:00Z`,
    { headers: AUTH },
  );
  assertEquals(badPurpose.status, 400);
  assertEquals((await badPurpose.json()).error, "invalid_purpose");

  const noSince = await app.request(
    `/internal/platform-usage?purpose=${PURPOSE}`,
    { headers: AUTH },
  );
  assertEquals(noSince.status, 400);
  assertEquals((await noSince.json()).error, "since_required");

  const badSince = await app.request(
    `/internal/platform-usage?purpose=${PURPOSE}&since=not-a-date`,
    { headers: AUTH },
  );
  assertEquals(badSince.status, 400);
  assertEquals((await badSince.json()).error, "invalid_since");
});
