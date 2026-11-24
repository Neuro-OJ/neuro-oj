/**
 * 用户自带模型（BYOK）：出网白名单、代理分支与共享额度隔离。
 */
import { assert, assertEquals, assertThrows } from "jsr:@std/assert@^1";
import { Hono } from "hono";
import { createLlmRouter } from "../src/routes/llm.ts";
import { createInternalRouter } from "../src/routes/internal.ts";
import {
  encryptSecret,
  type EvalTokenPayload,
  mintEvalToken,
} from "../src/crypto.ts";
import type { Db } from "../src/db.ts";
import {
  assertByokBaseUrl,
  BYOK_DISABLED,
  type UserProviderRow,
} from "../src/user-providers.ts";
import { UPSTREAM_BLOCKED } from "../src/upstream-guard.ts";
import {
  createFakeDb,
  FakeRedis,
  publicDns,
  requestChat,
  stubFetch,
  testConfig,
} from "./helpers.ts";

const HOSTS = new Set(["api.byok.test"]);

Deno.test("byok base_url: 白名单为空即关闭", () => {
  assertThrows(
    () => assertByokBaseUrl("https://api.byok.test/v1", new Set()),
    Error,
    BYOK_DISABLED,
  );
});

Deno.test("byok base_url: 只接受 https + 精确主机", () => {
  assertByokBaseUrl("https://api.byok.test/v1", HOSTS);
  for (
    const url of [
      "http://api.byok.test/v1",
      "https://evil.api.byok.test/v1",
      "https://api.byok.test.evil.com/v1",
      "https://user:pw@api.byok.test/v1",
      "https://127.0.0.1/v1",
      "not a url",
    ]
  ) {
    assertThrows(() => assertByokBaseUrl(url, HOSTS), Error, UPSTREAM_BLOCKED);
  }
});

async function userRow(
  overrides: Partial<UserProviderRow> = {},
): Promise<UserProviderRow> {
  return {
    user_id: "user-1",
    base_url: "https://api.byok.test/v1",
    model: "user-model",
    encrypted_api_key: await encryptSecret("sk-user-key", testConfig.storeKey),
    enabled: true,
    revision: 1,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    ...overrides,
  };
}

/** 在通用假 DB 上补一条 `llm_user_providers` 查询。 */
function withUserProvider(row: UserProviderRow | null) {
  const fake = createFakeDb(null);
  const inner = fake.db as unknown as (
    s: TemplateStringsArray,
    ...v: unknown[]
  ) => Promise<unknown>;
  const db = ((strings: TemplateStringsArray, ...values: unknown[]) => {
    if (strings.join("?").includes("FROM llm_user_providers")) {
      return Promise.resolve(row && values[0] === row.user_id ? [row] : []);
    }
    return inner(strings, ...values);
  }) as unknown as Db;
  Object.assign(db, {
    unsafe: () => Promise.resolve([]),
    begin: (op: (tx: Db) => Promise<unknown>) => op(db),
    reserve: () => Promise.resolve(db),
    release: () => {},
  });
  return { ...fake, db };
}

async function byokToken(providerId = "byok:user-1"): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const payload: EvalTokenPayload = {
    jti: crypto.randomUUID(),
    domain_id: "00000000-0000-4000-8000-000000000001",
    protocol_version: 3,
    attempt_id: "att-byok",
    submission_id: "sub-1",
    problem_id: "prob-1",
    user_id: "user-1",
    provider_id: providerId,
    allowed_models: ["default"],
    model_map: { default: "user-model" },
    iat: now - 10,
    exp: now + 3600,
    max_calls: 10,
    max_tokens: 1000,
  };
  return await mintEvalToken(payload, testConfig.serviceToken);
}

Deno.test("byok proxy: 用用户 Key 转发，只预占单次评测预算，不计成本", async () => {
  const { db, usageInserts, ledger } = withUserProvider(await userRow());
  const redis = new FakeRedis();
  const calls: { url: string; auth: string | null; model: string }[] = [];
  const restore = stubFetch((input, init) => {
    const body = JSON.parse(String(init?.body));
    calls.push({
      url: String(input),
      auth: new Headers(init?.headers).get("authorization"),
      model: body.model,
    });
    return Promise.resolve(
      new Response(
        JSON.stringify({
          choices: [{ message: { content: "pong" } }],
          usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 },
        }),
        { headers: { "content-type": "application/json" } },
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
    const res = await requestChat(app, await byokToken(), {
      model: "default",
      messages: [{ role: "user", content: "ping" }],
    });
    assertEquals(res.status, 200);
    assertEquals(calls.length, 1);
    assertEquals(calls[0].url, "https://api.byok.test/v1/chat/completions");
    assertEquals(calls[0].auth, "Bearer sk-user-key");
    assertEquals(calls[0].model, "user-model");
    assertEquals(usageInserts[0].provider_id, "byok:user-1");
    assertEquals(usageInserts[0].estimated_cost, 0);
    const [entry] = [...ledger.values()];
    const counters = entry.reservation as { key: string }[];
    assertEquals(counters.length, 3);
    for (const counter of counters) {
      assert(counter.key.includes(":attempt:att-byok:"), counter.key);
    }
  } finally {
    restore();
  }
});

Deno.test("byok proxy: token 的 provider 与 user 不一致时拒绝", async () => {
  const { db } = withUserProvider(await userRow());
  let fetched = 0;
  const restore = stubFetch(() => {
    fetched++;
    return Promise.reject(new Error("不得访问上游"));
  });
  try {
    const app = createLlmRouter({
      config: testConfig,
      db,
      redis: new FakeRedis(),
      resolveDns: publicDns,
    });
    const res = await requestChat(app, await byokToken("byok:user-2"), {
      model: "default",
      messages: [],
    });
    assertEquals(res.status, 400);
    assertEquals((await res.json()).error, "provider_not_found");
    assertEquals(fetched, 0);
  } finally {
    restore();
  }
});

Deno.test("byok proxy: 白名单移除后拒绝出网；停用后返回 provider_disabled", async () => {
  const restore = stubFetch(() => Promise.reject(new Error("不得访问上游")));
  try {
    const blocked = createLlmRouter({
      config: { ...testConfig, byokAllowedHosts: new Set(["other.test"]) },
      db: withUserProvider(await userRow()).db,
      redis: new FakeRedis(),
      resolveDns: publicDns,
    });
    const res = await requestChat(blocked, await byokToken(), {
      model: "default",
      messages: [],
    });
    assertEquals(res.status, 502);
    assertEquals((await res.json()).error, UPSTREAM_BLOCKED);

    const disabled = createLlmRouter({
      config: testConfig,
      db: withUserProvider(await userRow({ enabled: false })).db,
      redis: new FakeRedis(),
      resolveDns: publicDns,
    });
    const res2 = await requestChat(disabled, await byokToken(), {
      model: "default",
      messages: [],
    });
    assertEquals(res2.status, 403);
    assertEquals((await res2.json()).error, "provider_disabled");
  } finally {
    restore();
  }
});

Deno.test("byok proxy: 用户 Provider 解析到内网地址时拒绝", async () => {
  const restore = stubFetch(() => Promise.reject(new Error("不得访问上游")));
  try {
    const app = createLlmRouter({
      config: testConfig,
      db: withUserProvider(await userRow()).db,
      redis: new FakeRedis(),
      resolveDns: (_h, type) =>
        Promise.resolve(type === "A" ? ["10.0.0.5"] : []),
    });
    const res = await requestChat(app, await byokToken(), {
      model: "default",
      messages: [],
    });
    assertEquals(res.status, 502);
    assertEquals((await res.json()).error, UPSTREAM_BLOCKED);
  } finally {
    restore();
  }
});

Deno.test("byok internal: PUT 只写白名单字段，归属取自路径", async () => {
  const captured: unknown[][] = [];
  const db = ((strings: TemplateStringsArray, ...values: unknown[]) => {
    const sql = strings.join("?");
    if (sql.includes("INSERT INTO llm_user_providers")) {
      captured.push(values);
      return Promise.resolve([{
        user_id: values[0],
        base_url: values[1],
        model: values[2],
        encrypted_api_key: values[3],
        enabled: values[4],
        revision: 1,
        created_at: values[5],
        updated_at: values[6],
      }]);
    }
    return Promise.resolve([]);
  }) as unknown as Db;
  const app = new Hono().route(
    "/",
    createInternalRouter({ config: testConfig, db }),
  );
  const res = await app.request("/internal/user-providers/user-1", {
    method: "PUT",
    headers: {
      Authorization: `Bearer ${testConfig.serviceToken}`,
      "content-type": "application/json",
      "If-Match": "0",
    },
    body: JSON.stringify({
      base_url: "https://api.byok.test/v1",
      model: "m",
      api_key: "sk-0123456789abcdef",
      user_id: "victim",
      revision: 99,
      cost_per_1k_tokens: -5,
    }),
  });
  assertEquals(res.status, 201);
  const body = await res.json();
  assertEquals(body.data.provider_id, "byok:user-1");
  assertEquals(body.data.api_key_masked, "sk-****cdef");
  assertEquals(captured[0][0], "user-1");
  assertEquals(JSON.stringify(body).includes("sk-0123456789abcdef"), false);
});

Deno.test("byok internal: 白名单为空时拒绝保存", async () => {
  const db = (() => Promise.resolve([])) as unknown as Db;
  const app = new Hono().route(
    "/",
    createInternalRouter({
      config: { ...testConfig, byokAllowedHosts: new Set() },
      db,
    }),
  );
  const res = await app.request("/internal/user-providers/user-1", {
    method: "PUT",
    headers: {
      Authorization: `Bearer ${testConfig.serviceToken}`,
      "content-type": "application/json",
      "If-Match": "0",
    },
    body: JSON.stringify({
      base_url: "https://api.byok.test/v1",
      model: "m",
      api_key: "sk-x",
    }),
  });
  assertEquals(res.status, 400);
  assertEquals((await res.json()).error, BYOK_DISABLED);
});
