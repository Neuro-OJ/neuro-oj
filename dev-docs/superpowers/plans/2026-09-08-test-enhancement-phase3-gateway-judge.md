# Phase 3: noj-llm-gateway + noj-judge 测试补强 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将 noj-llm-gateway 与 noj-judge 的测试覆盖补强到目标水平（gateway ≥80%、judge ≥80%），重点覆盖限流/计费/Provider 错误分支与 judge 的 ZIP/资源/结果/错误/并发及 Docker 异常场景。

**Architecture:** 本计划分两条线：gateway 侧新增 Hono 路由级测试（fake Db/Redis + fetch stub）与 replay fixture 扩展；judge 侧在现有 `#[cfg(test)]` 单元测试基础上补 ZIP 限额、资源收敛、结果解析、BYOK 错误映射、drain 取消，并新增一个 Docker E2E 异常测试文件。所有测试均不改变现有业务行为，只做可测试性小重构（提取纯函数、给 ZIP 解压增加可配置限额测试入口）。

**Tech Stack:** Deno 2 + Hono（gateway）、Rust + Tokio + bollard + zip（judge）、cargo nextest、Docker E2E。

**Spec:** `dev-docs/superpowers/specs/2026-09-08-test-enhancement-roadmap-design.md`

## Global Constraints

- 遵守 AGENTS.md：提交必须 GPG 签名；提交信息用 Conventional Commits 中文描述；禁止修改 deno.lock / Cargo.lock 手动内容。
- Deno 测试必须通过 `deno task` 封装命令运行，禁止手拼 `deno test` 绕过脚本（noj-core 用 `deno task test:domain <domain>`，noj-ui 用 `deno task test`，noj-llm-gateway 用 `deno task test`，noj-judge 用 `cargo nextest run --all-targets`）。
- 中文注释、英文标识符。
- 每个任务以可独立测试的交付物结束，并包含 Commit 步骤（使用 jj：`jj describe -m "..."`，不要 push）。

---

### Task 1: Gateway 配置缺失/非法密钥测试

**Files:**
- Modify: `noj-llm-gateway/tests/config_test.ts`

**Interfaces:**
- Consumes: `loadConfig(env)` from `../src/config.ts`
- Produces: 覆盖 `NOJ_LLM_SERVICE_TOKEN` / `NOJ_LLM_STORE_KEY` / `DATABASE_URL` / `REDIS_URL` 缺失与空值抛错的回归测试

- [ ] **Step 1: Write the failing test**

在 `tests/config_test.ts` 末尾追加：

```ts
Deno.test("config: 缺少 SERVICE_TOKEN 时拒绝启动", () => {
  assertThrows(
    () => loadConfig({ ...baseEnv, NOJ_LLM_SERVICE_TOKEN: "" }),
    Error,
    "NOJ_LLM_SERVICE_TOKEN",
  );
});

Deno.test("config: SERVICE_TOKEN 长度不足 16 时拒绝启动", () => {
  assertThrows(
    () => loadConfig({ ...baseEnv, NOJ_LLM_SERVICE_TOKEN: "short" }),
    Error,
    "NOJ_LLM_SERVICE_TOKEN",
  );
});

Deno.test("config: 缺少 STORE_KEY 时拒绝启动", () => {
  assertThrows(
    () => loadConfig({ ...baseEnv, NOJ_LLM_STORE_KEY: "" }),
    Error,
    "NOJ_LLM_STORE_KEY",
  );
});

Deno.test("config: STORE_KEY 长度不足 16 时拒绝启动", () => {
  assertThrows(
    () => loadConfig({ ...baseEnv, NOJ_LLM_STORE_KEY: "short" }),
    Error,
    "NOJ_LLM_STORE_KEY",
  );
});

Deno.test("config: 缺少 DATABASE_URL 时拒绝启动", () => {
  assertThrows(
    () => loadConfig({ ...baseEnv, DATABASE_URL: "" }),
    Error,
    "DATABASE_URL",
  );
});

Deno.test("config: REDIS_URL 为空时拒绝启动", () => {
  assertThrows(
    () => loadConfig({ ...baseEnv, REDIS_URL: "" }),
    Error,
    "REDIS_URL",
  );
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd noj-llm-gateway && deno task test -- --filter "config:"`
Expected: 新测试全部 FAIL（当前 `loadConfig` 对空 `REDIS_URL` 不会抛错，其余缺失项已抛错但尚无测试锁定）。

- [ ] **Step 3: Write minimal implementation**

本任务只补测试，不修改生产代码；`loadConfig` 现有实现已满足除空 `REDIS_URL` 外的断言。若 Step 2 显示 `REDIS_URL` 空值未抛错，则修改 `src/config.ts` 中校验逻辑：

```ts
  if (!redisUrl) {
    throw new Error("REDIS_URL 未设置，noj-llm-gateway 无法启动");
  }
```

（当前代码已有该行；若已存在则无需改动。）

- [ ] **Step 4: Run test to verify it passes**

Run: `cd noj-llm-gateway && deno task test -- --filter "config:"`
Expected: 全部 PASS。

- [ ] **Step 5: Commit**

```bash
cd /home/xyber-nova/Github/neuro-oj
jj describe -m "test(gateway): 补充配置缺失与密钥长度不足测试"
```

---

### Task 2: Gateway 限流/429 路由测试（含测试辅助模块）

**Files:**
- Create: `noj-llm-gateway/tests/helpers.ts`
- Create: `noj-llm-gateway/tests/routes_llm_test.ts`

**Interfaces:**
- Consumes: `createLlmRouter` from `../src/routes/llm.ts`, `mintEvalToken` from `../src/crypto.ts`, `RedisClient` from `../src/redis.ts`, `Db` from `../src/db.ts`
- Produces: `FakeRedis`、`createFakeDb`、`makeProvider`、`testConfig`、`makeToken`、`requestChat`、`stubFetch` 供 Task 3/4/5 复用

- [ ] **Step 1: Write the failing test**

创建 `tests/helpers.ts`：

```ts
// 路由测试共享辅助：fake Redis / fake Db / 测试配置 / fetch stub。
import type { Db } from "../src/db.ts";
import type { GatewayConfig } from "../src/config.ts";
import type { ProviderRow } from "../src/providers.ts";
import type { RedisClient } from "../src/redis.ts";
import {
  encryptSecret,
  mintEvalToken,
  type EvalTokenPayload,
} from "../src/crypto.ts";
import { createLlmRouter } from "../src/routes/llm.ts";

export class FakeRedis implements RedisClient {
  evalResults: string[] = [];

  async incr(): Promise<number> {
    return 1;
  }

  async incrby(): Promise<number> {
    return 1;
  }

  async expire(): Promise<number> {
    return 1;
  }

  async get(): Promise<string | null> {
    return null;
  }

  async set(): Promise<unknown> {
    return "OK";
  }

  async sadd(): Promise<number> {
    return 0;
  }

  async scard(): Promise<number> {
    return 0;
  }

  async eval(): Promise<unknown> {
    return this.evalResults.shift() ?? "ok";
  }
}

export function createFakeDb(provider: ProviderRow | null): {
  db: Db;
  usageInserts: Record<string, unknown>[];
} {
  const usageInserts: Record<string, unknown>[] = [];
  const db = ((
    strings: TemplateStringsArray,
    ...values: unknown[]
  ) => {
    const sql = strings.join("?");
    if (sql.includes("FROM llm_providers")) {
      return Promise.resolve(provider ? [provider] : []);
    }
    if (sql.includes("FROM llm_quotas")) {
      return Promise.resolve([]);
    }
    if (sql.includes("INSERT INTO llm_usage")) {
      const cols = [
        "id", "submission_id", "problem_id", "user_id", "provider_id",
        "model", "request_messages", "request_params", "prompt_tokens",
        "completion_tokens", "total_tokens", "cached_prompt_tokens",
        "billed_prompt_tokens", "billed_total_tokens", "estimated_cost",
        "latency_ms", "status", "error_code", "prompt_hash", "created_at",
      ];
      const row: Record<string, unknown> = {};
      for (let i = 0; i < cols.length; i++) {
        row[cols[i]] = values[i];
      }
      usageInserts.push(row);
      return Promise.resolve([]);
    }
    return Promise.resolve([]);
  }) as unknown as Db;
  (db as unknown as { unsafe: unknown }).unsafe = async () => [];
  return { db, usageInserts };
}

export async function makeProvider(storeKey: string): Promise<ProviderRow> {
  return {
    id: "prov-1",
    name: "test",
    base_url: "https://api.openai.com/v1",
    model: "deepseek-chat",
    cost_per_1k_tokens: 1,
    encrypted_api_key: await encryptSecret("sk-test", storeKey),
    enabled: true,
    created_by: "0",
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };
}

export const testConfig: GatewayConfig = {
  port: 8001,
  userRateLimitPerMinute: 60,
  ipRateLimitPerMinute: 60,
  serviceToken: "test-service-token-0123456789",
  storeKey: "test-store-key-0123456789",
  databaseUrl: "postgres://fake",
  redisUrl: "redis://fake",
};

export async function makeToken(
  config: GatewayConfig = testConfig,
  model = "deepseek-chat",
): Promise<string> {
  const payload: EvalTokenPayload = {
    jti: crypto.randomUUID(),
    submission_id: "sub-1",
    problem_id: "prob-1",
    user_id: "user-1",
    provider_id: "prov-1",
    allowed_models: [model],
    iat: Math.floor(Date.now() / 1000) - 10,
    exp: Math.floor(Date.now() / 1000) + 3600,
    max_calls: 10,
    max_tokens: 1000,
  };
  return await mintEvalToken(payload, config.serviceToken);
}

export async function requestChat(
  app: ReturnType<typeof createLlmRouter>,
  token: string,
  body: unknown,
): Promise<Response> {
  return await app.request("/v1/chat/completions", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
}

export function stubFetch(
  impl: (input: string | URL | Request, init?: RequestInit) => Promise<Response>,
): () => void {
  const original = globalThis.fetch;
  // deno-lint-ignore no-explicit-any
  (globalThis as any).fetch = impl;
  return () => {
    // deno-lint-ignore no-explicit-any
    (globalThis as any).fetch = original;
  };
}
```

创建 `tests/routes_llm_test.ts`：

```ts
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd noj-llm-gateway && deno task test -- --filter "llm route:"`
Expected: FAIL（`tests/routes_llm_test.ts` 不存在或 `helpers.ts` 不存在，Deno 报模块未找到）。

- [ ] **Step 3: Write minimal implementation**

本任务只新增测试与辅助模块，不修改生产代码。若 Step 2 显示路由行为与断言不符（例如 429 body 结构不同），以当前 `src/routes/llm.ts` 的 `openAiLimitError` 为准调整断言。

- [ ] **Step 4: Run test to verify it passes**

Run: `cd noj-llm-gateway && deno task test -- --filter "llm route:"`
Expected: 2 个测试全部 PASS。

- [ ] **Step 5: Commit**

```bash
cd /home/xyber-nova/Github/neuro-oj
jj describe -m "test(gateway): 新增限流 429 路由测试与共享测试辅助"
```

---

### Task 3: Gateway Provider 错误分支路由测试（超时/5xx/畸形响应）

**Files:**
- Modify: `noj-llm-gateway/tests/routes_llm_test.ts`

**Interfaces:**
- Consumes: `stubFetch`、`createFakeDb`、`FakeRedis`、`makeProvider`、`makeToken`、`requestChat`、`testConfig` from `./helpers.ts`
- Produces: 覆盖 `upstream_error`、5xx 透传、畸形 JSON 不崩溃的回归测试

- [ ] **Step 1: Write the failing test**

在 `tests/routes_llm_test.ts` 末尾追加：

```ts
Deno.test("llm route: 上游超时/网络错误返回 502 并记录 error", async () => {
  const provider = await makeProvider(testConfig.storeKey);
  const { db, usageInserts } = createFakeDb(provider);
  const redis = new FakeRedis();
  const app = createLlmRouter({ config: testConfig, db, redis });
  const token = await makeToken(testConfig);
  const restore = stubFetch(async () => {
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
  const restore = stubFetch(async () => {
    return new Response(JSON.stringify({ error: "boom" }), {
      status: 500,
      headers: { "content-type": "application/json" },
    });
  });

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
  const restore = stubFetch(async () => {
    return new Response("not-json", {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  });

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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd noj-llm-gateway && deno task test -- --filter "llm route:"`
Expected: 新 3 个测试 FAIL（尚未添加）。

- [ ] **Step 3: Write minimal implementation**

本任务只新增测试，不修改生产代码。若 Step 2 显示畸形 JSON 当前返回非 200，则说明生产行为与预期不符；按“不改变现有业务行为”原则，以实际行为修正断言（当前实现为 `c.json(upstreamBody)`，`upstreamBody` 为 `null`，返回 200 `null`）。

- [ ] **Step 4: Run test to verify it passes**

Run: `cd noj-llm-gateway && deno task test -- --filter "llm route:"`
Expected: 5 个路由测试全部 PASS。

- [ ] **Step 5: Commit**

```bash
cd /home/xyber-nova/Github/neuro-oj
jj describe -m "test(gateway): 补充 Provider 超时/5xx/畸形响应路由测试"
```

---

### Task 4: Gateway billed-token 计费与审计路由测试

**Files:**
- Modify: `noj-llm-gateway/tests/routes_llm_test.ts`

**Interfaces:**
- Consumes: `stubFetch`、`createFakeDb`、`FakeRedis`、`makeProvider`、`makeToken`、`requestChat`、`testConfig` from `./helpers.ts`
- Produces: 验证成功路径按 `billed_total_tokens` 审计、settle 超限返回 429 的回归测试

- [ ] **Step 1: Write the failing test**

在 `tests/routes_llm_test.ts` 末尾追加：

```ts
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
  const restore = stubFetch(async () => {
    return new Response(JSON.stringify(upstream), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  });

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
  const restore = stubFetch(async () => {
    return new Response(JSON.stringify(upstream), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  });

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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd noj-llm-gateway && deno task test -- --filter "llm route:"`
Expected: 新 2 个测试 FAIL（尚未添加）。

- [ ] **Step 3: Write minimal implementation**

本任务只新增测试，不修改生产代码。若 Step 2 显示 billed 字段与预期不符，以 `src/billing.ts` 的 `calcBilledUsage` 实际输出为准修正断言。

- [ ] **Step 4: Run test to verify it passes**

Run: `cd noj-llm-gateway && deno task test -- --filter "llm route:"`
Expected: 7 个路由测试全部 PASS。

- [ ] **Step 5: Commit**

```bash
cd /home/xyber-nova/Github/neuro-oj
jj describe -m "test(gateway): 补充 billed-token 计费与 settle 超限审计测试"
```

---

### Task 5: Gateway replay fixtures 扩展与回放测试

**Files:**
- Create: `noj-llm-gateway/tests/replay/fixtures/deepseek-chat.json`
- Create: `noj-llm-gateway/tests/replay/fixtures/qwen-plus.json`
- Create: `noj-llm-gateway/tests/replay/fixtures/openai-gpt-4o.json`
- Create: `noj-llm-gateway/tests/replay/fixtures/upstream-500.json`
- Create: `noj-llm-gateway/tests/replay/fixtures/malformed.json`
- Modify: `noj-llm-gateway/tests/replay_test.ts`

**Interfaces:**
- Consumes: `createFakeDb`、`FakeRedis`、`makeProvider`、`makeToken`、`requestChat`、`testConfig`、`stubFetch` from `./helpers.ts`
- Produces: 多 Provider 与错误分支的 replay fixture 及一个可驱动路由的回放测试

- [ ] **Step 1: Write the failing test**

创建 5 个 fixture 文件：

`tests/replay/fixtures/deepseek-chat.json`：

```json
{
  "model": "deepseek-chat",
  "request": {
    "messages": [{ "role": "user", "content": "ping" }],
    "max_tokens": 5
  },
  "response": {
    "choices": [{ "message": { "role": "assistant", "content": "pong" } }]
  }
}
```

`tests/replay/fixtures/qwen-plus.json`：

```json
{
  "model": "qwen-plus",
  "request": {
    "messages": [{ "role": "user", "content": "1+1=?" }],
    "max_tokens": 10
  },
  "response": {
    "choices": [{ "message": { "role": "assistant", "content": "2" } }]
  }
}
```

`tests/replay/fixtures/openai-gpt-4o.json`：

```json
{
  "model": "gpt-4o",
  "request": {
    "messages": [{ "role": "user", "content": "hello" }],
    "max_tokens": 8
  },
  "response": {
    "choices": [{ "message": { "role": "assistant", "content": "Hello!" } }],
    "usage": {
      "prompt_tokens": 12,
      "completion_tokens": 3,
      "total_tokens": 15,
      "prompt_tokens_details": { "cached_tokens": 5 }
    }
  }
}
```

`tests/replay/fixtures/upstream-500.json`：

```json
{
  "model": "deepseek-chat",
  "request": {
    "messages": [{ "role": "user", "content": "ping" }],
    "max_tokens": 5
  },
  "response": {
    "choices": []
  },
  "upstream_status": 500
}
```

`tests/replay/fixtures/malformed.json`：

```json
{
  "model": "deepseek-chat",
  "request": {
    "messages": [{ "role": "user", "content": "ping" }],
    "max_tokens": 5
  },
  "response": {
    "choices": []
  },
  "malformed": true
}
```

修改 `tests/replay_test.ts` 为：

```ts
// LLM 回放测试：无 key 可跑，验证录制 fixture 的结构与内容，并可用 fixture 驱动代理路由。

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

const FIXTURE_DIR = new URL("./replay/fixtures/", import.meta.url).pathname;

interface ReplayFixture {
  model: string;
  request: {
    messages: { role: string; content: string }[];
    max_tokens?: number;
  };
  response: {
    choices: { message: { role: string; content: string } }[];
    usage?: {
      prompt_tokens?: number;
      completion_tokens?: number;
      total_tokens?: number;
      prompt_tokens_details?: { cached_tokens?: number };
    };
  };
  upstream_status?: number;
  malformed?: boolean;
}

async function readFixture(name: string): Promise<ReplayFixture> {
  return JSON.parse(
    await Deno.readTextFile(new URL(name, FIXTURE_DIR).pathname),
  ) as ReplayFixture;
}

Deno.test("replay: 多 Provider fixture 结构可读", async () => {
  for (const name of [
    "simple-chat.json",
    "deepseek-chat.json",
    "qwen-plus.json",
    "openai-gpt-4o.json",
    "upstream-500.json",
    "malformed.json",
  ]) {
    const fixture = await readFixture(name);
    assertEquals(typeof fixture.model, "string");
    assertEquals(Array.isArray(fixture.request.messages), true);
    assertEquals(Array.isArray(fixture.response.choices), true);
  }
});

Deno.test("replay: 错误分支 fixture 标记正确", async () => {
  const upstream500 = await readFixture("upstream-500.json");
  assertEquals(upstream500.upstream_status, 500);
  const malformed = await readFixture("malformed.json");
  assertEquals(malformed.malformed, true);
});

Deno.test("replay: simple-chat fixture 可驱动代理路由", async () => {
  const fixture = await readFixture("simple-chat.json");
  const provider = await makeProvider(testConfig.storeKey);
  const { db } = createFakeDb(provider);
  const redis = new FakeRedis();
  const app = createLlmRouter({ config: testConfig, db, redis });
  const token = await makeToken(testConfig, fixture.model);
  const restore = stubFetch(async () => {
    return new Response(JSON.stringify(fixture.response), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  });

  try {
    const res = await requestChat(app, token, {
      model: fixture.model,
      messages: fixture.request.messages,
      max_tokens: fixture.request.max_tokens,
    });
    assertEquals(res.status, 200);
    const body = await res.json();
    assertEquals(body.choices[0].message.content, "pong");
  } finally {
    restore();
  }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd noj-llm-gateway && deno task test -- --filter "replay:"`
Expected: 新测试 FAIL（fixture 文件不存在或 `replay_test.ts` 尚未引用 helpers）。

- [ ] **Step 3: Write minimal implementation**

本任务只新增 fixture 与测试，不修改生产代码。若 `simple-chat.json` 的 model 与 `makeToken` 默认 model 不一致，已在测试中显式传 `fixture.model`。

- [ ] **Step 4: Run test to verify it passes**

Run: `cd noj-llm-gateway && deno task test -- --filter "replay:"`
Expected: 全部 PASS。

- [ ] **Step 5: Commit**

```bash
cd /home/xyber-nova/Github/neuro-oj
jj describe -m "test(gateway): 扩展 replay fixture 覆盖多 Provider 与错误分支"
```

---

### Task 6: Judge ZIP 解析边界单元测试（含可配置限额重构）

**Files:**
- Modify: `noj-judge/src/sandbox/container.rs`

**Interfaces:**
- Consumes: `zip::ZipArchive`、`MAX_ZIP_ENTRIES`、`MAX_FILE_SIZE`、`MAX_TOTAL_SIZE`
- Produces: 新增 `extract_zip_entries_reader_with_limits(reader, max_entries, max_file_size, max_total_size)` 测试入口；生产入口 `extract_zip_entries_from_file` 行为不变

- [ ] **Step 1: Write the failing test**

在 `src/sandbox/container.rs` 的 `mod tests` 中追加：

```rust
    use std::io::Write;

    fn make_zip(entries: &[(&str, &[u8])]) -> Vec<u8> {
        let cursor = std::io::Cursor::new(Vec::new());
        let mut zip = zip::ZipWriter::new(cursor);
        let options = zip::write::SimpleFileOptions::default();
        for (name, data) in entries {
            zip.start_file(*name, options).unwrap();
            zip.write_all(data).unwrap();
        }
        zip.finish().unwrap().into_inner()
    }

    #[test]
    fn test_extract_zip_rejects_path_traversal() {
        let bytes = make_zip(&[("../escape.py", b"x")]);
        let err = extract_zip_entries_reader_with_limits(
            std::io::Cursor::new(bytes),
            10,
            1024,
            1024,
        )
        .unwrap_err();
        assert!(err.to_string().contains("非法路径"));
    }

    #[test]
    fn test_extract_zip_rejects_absolute_path() {
        let bytes = make_zip(&[("/etc/passwd", b"x")]);
        let err = extract_zip_entries_reader_with_limits(
            std::io::Cursor::new(bytes),
            10,
            1024,
            1024,
        )
        .unwrap_err();
        assert!(err.to_string().contains("非法路径"));
    }

    #[test]
    fn test_extract_zip_rejects_duplicate_entries() {
        let bytes = make_zip(&[("a.py", b"1"), ("a.py", b"2")]);
        let err = extract_zip_entries_reader_with_limits(
            std::io::Cursor::new(bytes),
            10,
            1024,
            1024,
        )
        .unwrap_err();
        assert!(err.to_string().contains("重复"));
    }

    #[test]
    fn test_extract_zip_rejects_too_many_entries() {
        let bytes = make_zip(&[("f0.py", b"x"), ("f1.py", b"x"), ("f2.py", b"x")]);
        let err = extract_zip_entries_reader_with_limits(
            std::io::Cursor::new(bytes),
            2,
            1024,
            1024,
        )
        .unwrap_err();
        assert!(err.to_string().contains("条目数"));
    }

    #[test]
    fn test_extract_zip_rejects_single_file_too_large() {
        let bytes = make_zip(&[("big.bin", &[0u8; 5])]);
        let err = extract_zip_entries_reader_with_limits(
            std::io::Cursor::new(bytes),
            10,
            4,
            1024,
        )
        .unwrap_err();
        assert!(err.to_string().contains("单文件"));
    }

    #[test]
    fn test_extract_zip_rejects_total_too_large() {
        let bytes = make_zip(&[("a.bin", &[0u8; 5]), ("b.bin", &[0u8; 5])]);
        let err = extract_zip_entries_reader_with_limits(
            std::io::Cursor::new(bytes),
            10,
            1024,
            8,
        )
        .unwrap_err();
        assert!(err.to_string().contains("总大小"));
    }

    #[test]
    fn test_extract_zip_accepts_within_limits() {
        let bytes = make_zip(&[("a.py", b"x"), ("b.py", b"y")]);
        let entries = extract_zip_entries_reader_with_limits(
            std::io::Cursor::new(bytes),
            2,
            4,
            8,
        )
        .unwrap();
        assert_eq!(entries.len(), 2);
        assert_eq!(entries[0].file_name, "a.py");
        assert_eq!(entries[1].data, b"y");
    }
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd noj-judge && cargo nextest run --all-targets -E 'test(test_extract_zip_)'`
Expected: FAIL（`extract_zip_entries_reader_with_limits` 不存在，编译错误）。

- [ ] **Step 3: Write minimal implementation**

修改 `src/sandbox/container.rs`：

将现有 `extract_zip_entries_reader` 改为调用带限额版本，并新增带限额函数：

```rust
fn extract_zip_entries_reader<R: Read + Seek>(reader: R) -> Result<Vec<ZipEntry>> {
    extract_zip_entries_reader_with_limits(
        reader,
        MAX_ZIP_ENTRIES,
        MAX_FILE_SIZE,
        MAX_TOTAL_SIZE,
    )
}

fn extract_zip_entries_reader_with_limits<R: Read + Seek>(
    reader: R,
    max_entries: usize,
    max_file_size: u64,
    max_total_size: u64,
) -> Result<Vec<ZipEntry>> {
    let mut archive = zip::ZipArchive::new(reader).context("打开 zip 文件失败")?;

    if archive.len() > max_entries {
        anyhow::bail!(
            "ZIP 条目数 {} 超过最大限制 {}",
            archive.len(),
            max_entries
        );
    }

    let mut entries = Vec::with_capacity(archive.len());
    let mut total_size: u64 = 0;
    let mut seen_paths = std::collections::HashSet::new();

    for i in 0..archive.len() {
        let mut file = archive.by_index(i).context("读取 zip 条目失败")?;
        let original_name = file.name().to_string();
        let is_dir = file.is_dir();

        // 路径穿越防护
        if original_name.split(['/', '\\']).any(|part| part == "..")
            || original_name.starts_with('/')
        {
            anyhow::bail!("ZIP 条目包含非法路径: {}", original_name);
        }

        // 目录条目：跳过文件大小校验和内容读取，直接记录
        if is_dir {
            if !seen_paths.insert(original_name.clone()) {
                anyhow::bail!("ZIP 条目重复: {}", original_name);
            }
            entries.push(ZipEntry {
                file_name: original_name,
                data: Vec::new(),
                is_dir: true,
            });
            continue;
        }

        // Overlapping entries 防护
        if !seen_paths.insert(original_name.clone()) {
            anyhow::bail!("ZIP 条目重复: {}", original_name);
        }

        // NOJ-193：解压限额以实际读取字节数为准，不信任 zip 条目声明大小。
        let declared_size = file.size();
        let capacity = usize::try_from(declared_size.min(max_file_size + 1)).unwrap_or(0);
        let mut buf = Vec::with_capacity(capacity);
        let mut limited = (&mut file).take(max_file_size + 1);
        limited.read_to_end(&mut buf)?;

        if buf.len() as u64 > max_file_size {
            anyhow::bail!(
                "ZIP 条目 {} 实际解压大小 {} 超过最大限制 {}",
                original_name,
                buf.len(),
                max_file_size
            );
        }

        total_size = total_size.saturating_add(buf.len() as u64);
        if total_size > max_total_size {
            anyhow::bail!(
                "ZIP 解压总大小 {} 超过最大限制 {}",
                total_size,
                max_total_size
            );
        }

        entries.push(ZipEntry {
            file_name: original_name,
            data: buf,
            is_dir: false,
        });
    }

    Ok(entries)
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd noj-judge && cargo nextest run --all-targets -E 'test(test_extract_zip_)'`
Expected: 全部 PASS。

- [ ] **Step 5: Commit**

```bash
cd /home/xyber-nova/Github/neuro-oj
jj describe -m "test(judge): 补充 ZIP 路径穿越/条目数/大小限制单元测试"
```

---

### Task 7: Judge 资源限制与白名单校验单元测试

**Files:**
- Modify: `noj-judge/src/dual/mod.rs`

**Interfaces:**
- Consumes: `clamp_runtime_config`、`image_allowed`、`validate_runtime_config`（模块内私有函数）
- Produces: 锁定资源硬上限收敛与镜像/命令/网络白名单行为的回归测试

- [ ] **Step 1: Write the failing test**

在 `src/dual/mod.rs` 的 `mod tests` 末尾追加：

```rust
    #[test]
    fn test_clamp_runtime_config_caps_time_and_memory() {
        use crate::types::{EvaluatorRuntime, SolutionRuntime};

        let rc = RuntimeConfig {
            evaluator: EvaluatorRuntime {
                image: "noj-evaluator".to_string(),
                command: "python3 /workspace/evaluate.py".to_string(),
                time_limit_ms: 999_999,
                memory_limit_mb: 9999,
                network: None,
            },
            solution: SolutionRuntime {
                image: "noj-solution".to_string(),
                call_timeout_ms: 999_999,
                memory_limit_mb: 9999,
            },
        };
        let clamped = clamp_runtime_config(&rc, 5000, 1000);
        assert_eq!(clamped.evaluator.time_limit_ms, 5000);
        assert_eq!(clamped.solution.call_timeout_ms, 1000);
        assert_eq!(clamped.evaluator.memory_limit_mb, 4096);
        assert_eq!(clamped.solution.memory_limit_mb, 4096);
    }

    #[test]
    fn test_image_allowed_checks_basename_prefix() {
        assert!(image_allowed("noj-evaluator:latest", "noj-"));
        assert!(image_allowed("registry.example.com/noj-evaluator:latest", "noj-"));
        assert!(!image_allowed("other:latest", "noj-"));
        assert!(!image_allowed("", "noj-"));
        assert!(!image_allowed("noj-../evil", "noj-"));
    }

    #[test]
    fn test_validate_runtime_config_rejects_bad_image() {
        use crate::types::{EvaluatorRuntime, SolutionRuntime};

        let rc = RuntimeConfig {
            evaluator: EvaluatorRuntime {
                image: "evil:latest".to_string(),
                command: "python3 x".to_string(),
                time_limit_ms: 1000,
                memory_limit_mb: 256,
                network: None,
            },
            solution: SolutionRuntime {
                image: "noj-solution".to_string(),
                call_timeout_ms: 1000,
                memory_limit_mb: 256,
            },
        };
        let err = validate_runtime_config(
            "sid-1",
            &rc,
            false,
            "noj-",
            &["python3".to_string()],
        )
        .unwrap_err();
        assert!(err.to_string().contains("镜像"));
    }

    #[test]
    fn test_validate_runtime_config_rejects_network_when_disallowed() {
        use crate::types::{EvaluatorRuntime, SolutionRuntime};

        let rc = RuntimeConfig {
            evaluator: EvaluatorRuntime {
                image: "noj-evaluator".to_string(),
                command: "python3 x".to_string(),
                time_limit_ms: 1000,
                memory_limit_mb: 256,
                network: Some(crate::types::EvaluatorNetwork { enabled: true }),
            },
            solution: SolutionRuntime {
                image: "noj-solution".to_string(),
                call_timeout_ms: 1000,
                memory_limit_mb: 256,
            },
        };
        let err = validate_runtime_config(
            "sid-2",
            &rc,
            false,
            "noj-",
            &["python3".to_string()],
        )
        .unwrap_err();
        assert!(err.to_string().contains("网络"));
    }
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd noj-judge && cargo nextest run --all-targets -E 'test(test_clamp_runtime_config_caps_time_and_memory|test_image_allowed_checks_basename_prefix|test_validate_runtime_config_)'`
Expected: 新测试 FAIL（尚未添加）。

- [ ] **Step 3: Write minimal implementation**

本任务只新增测试，不修改生产代码；`clamp_runtime_config`、`image_allowed`、`validate_runtime_config` 已存在。

- [ ] **Step 4: Run test to verify it passes**

Run: `cd noj-judge && cargo nextest run --all-targets -E 'test(test_clamp_runtime_config_caps_time_and_memory|test_image_allowed_checks_basename_prefix|test_validate_runtime_config_)'`
Expected: 全部 PASS。

- [ ] **Step 5: Commit**

```bash
cd /home/xyber-nova/Github/neuro-oj
jj describe -m "test(judge): 补充资源硬上限收敛与白名单校验测试"
```

---

### Task 8: Judge 结果解析边界单元测试

**Files:**
- Modify: `noj-judge/src/dual/mod.rs`

**Interfaces:**
- Consumes: `build_judge_result`（模块内私有函数）
- Produces: 锁定 score 收敛、status 映射、details 缺省行为的回归测试

- [ ] **Step 1: Write the failing test**

在 `src/dual/mod.rs` 的 `mod tests` 末尾追加：

```rust
    #[test]
    fn test_build_judge_result_clamps_score() {
        let r = build_judge_result(
            "sid-clamp",
            &serde_json::json!({"score": 99999, "details": {}}),
            "",
            "",
            None,
        );
        assert_eq!(r.score, 10000);

        let r2 = build_judge_result(
            "sid-clamp2",
            &serde_json::json!({"score": -5, "details": {}}),
            "",
            "",
            None,
        );
        assert_eq!(r2.score, 0);
    }

    #[test]
    fn test_build_judge_result_maps_error_statuses() {
        for status in [
            "error",
            "SystemError",
            "TimeLimitExceeded",
            "MemoryLimitExceeded",
            "RuntimeError",
        ] {
            let r = build_judge_result(
                "sid-status",
                &serde_json::json!({"status": status, "score": 0}),
                "",
                "",
                None,
            );
            assert_eq!(r.status, "error", "status={}", status);
        }
        for status in ["Accepted", "WrongAnswer", "finished"] {
            let r = build_judge_result(
                "sid-status2",
                &serde_json::json!({"status": status, "score": 0}),
                "",
                "",
                None,
            );
            assert_eq!(r.status, "finished", "status={}", status);
        }
    }

    #[test]
    fn test_build_judge_result_missing_details_is_null() {
        let r = build_judge_result(
            "sid-details",
            &serde_json::json!({"score": 1}),
            "",
            "",
            None,
        );
        assert_eq!(r.details, serde_json::Value::Null);
    }
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd noj-judge && cargo nextest run --all-targets -E 'test(test_build_judge_result_clamps_score|test_build_judge_result_maps_error_statuses|test_build_judge_result_missing_details_is_null)'`
Expected: 新测试 FAIL（尚未添加）。

- [ ] **Step 3: Write minimal implementation**

本任务只新增测试，不修改生产代码；`build_judge_result` 已实现 score clamp 与 status 映射。

- [ ] **Step 4: Run test to verify it passes**

Run: `cd noj-judge && cargo nextest run --all-targets -E 'test(test_build_judge_result_clamps_score|test_build_judge_result_maps_error_statuses|test_build_judge_result_missing_details_is_null)'`
Expected: 全部 PASS。

- [ ] **Step 5: Commit**

```bash
cd /home/xyber-nova/Github/neuro-oj
jj describe -m "test(judge): 补充结果解析 score 收敛与状态映射测试"
```

---

### Task 9: Judge BYOK 错误路径单元测试（含映射函数提取）

**Files:**
- Modify: `noj-judge/src/dual/mod.rs`

**Interfaces:**
- Consumes: `handle_user_llm_capability`、`JudgeTaskLlm`
- Produces: 新增纯函数 `user_llm_error_frame(id, code, message) -> Value` 与 `map_user_llm_gateway_error(status, gateway_code) -> &'static str`，供后续测试与生产共用

- [ ] **Step 1: Write the failing test**

在 `src/dual/mod.rs` 的 `mod tests` 末尾追加：

```rust
    #[test]
    fn test_user_llm_error_frame_shape() {
        let f = user_llm_error_frame("id-1", "BYOK_QUOTA_EXCEEDED", "用户模型请求失败");
        assert_eq!(f["type"], "error");
        assert_eq!(f["id"], "id-1");
        assert_eq!(f["code"], "BYOK_QUOTA_EXCEEDED");
        assert_eq!(f["message"], "用户模型请求失败");
    }

    #[test]
    fn test_map_user_llm_gateway_error() {
        assert_eq!(
            map_user_llm_gateway_error(429, Some("limit_exceeded")),
            "BYOK_QUOTA_EXCEEDED"
        );
        assert_eq!(
            map_user_llm_gateway_error(429, Some("rate_limit_exceeded")),
            "BYOK_QUOTA_EXCEEDED"
        );
        assert_eq!(
            map_user_llm_gateway_error(400, Some("provider_disabled")),
            "BYOK_CONFIG_UNAVAILABLE"
        );
        assert_eq!(
            map_user_llm_gateway_error(400, Some("provider_not_found")),
            "BYOK_CONFIG_UNAVAILABLE"
        );
        assert_eq!(
            map_user_llm_gateway_error(400, Some("provider_target_rejected")),
            "BYOK_PROVIDER_TARGET_REJECTED"
        );
        assert_eq!(map_user_llm_gateway_error(401, None), "BYOK_GATEWAY_UNAVAILABLE");
        assert_eq!(map_user_llm_gateway_error(403, None), "BYOK_GATEWAY_UNAVAILABLE");
        assert_eq!(map_user_llm_gateway_error(500, None), "BYOK_PROVIDER_ERROR");
    }

    #[tokio::test]
    async fn test_user_llm_capability_missing_id_returns_error() {
        use bollard::container::LogOutput;
        use tokio::io::AsyncReadExt;

        let (sink, mut source) = tokio::io::duplex(8192);
        let mut writer: std::pin::Pin<Box<dyn tokio::io::AsyncWrite + Send + Unpin>> =
            Box::pin(sink);
        let frame = serde_json::json!({
            "type": "capability",
            "name": "request_user_llm_completion",
            "args": ["hello"]
        });
        handle_user_llm_capability(&mut writer, &frame, None)
            .await
            .unwrap();

        let mut buf = [0u8; 1024];
        let n = tokio::time::timeout(Duration::from_secs(1), source.read(&mut buf))
            .await
            .expect("读取 BYOK 错误帧超时")
            .unwrap();
        let text = String::from_utf8_lossy(&buf[..n]).to_string();
        assert!(text.contains("BYOK_REQUEST_INVALID"));
    }

    #[tokio::test]
    async fn test_user_llm_capability_invalid_prompt_returns_error() {
        use bollard::container::LogOutput;
        use tokio::io::AsyncReadExt;

        let (sink, mut source) = tokio::io::duplex(8192);
        let mut writer: std::pin::Pin<Box<dyn tokio::io::AsyncWrite + Send + Unpin>> =
            Box::pin(sink);
        let llm = JudgeTaskLlm {
            gateway_url: "http://gateway:8001".to_string(),
            eval_token: "token".to_string(),
            provider_id: "prov-1".to_string(),
            allowed_models: vec!["qwen-plus".to_string()],
        };
        let frame = serde_json::json!({
            "type": "capability",
            "id": "byok-1",
            "name": "request_user_llm_completion",
            "args": [123]
        });
        handle_user_llm_capability(&mut writer, &frame, Some(&llm))
            .await
            .unwrap();

        let mut buf = [0u8; 1024];
        let n = tokio::time::timeout(Duration::from_secs(1), source.read(&mut buf))
            .await
            .expect("读取 BYOK 错误帧超时")
            .unwrap();
        let text = String::from_utf8_lossy(&buf[..n]).to_string();
        assert!(text.contains("BYOK_PROMPT_INVALID"));
    }

    #[tokio::test]
    async fn test_user_llm_capability_prompt_too_large_returns_error() {
        use bollard::container::LogOutput;
        use tokio::io::AsyncReadExt;

        let (sink, mut source) = tokio::io::duplex(8192);
        let mut writer: std::pin::Pin<Box<dyn tokio::io::AsyncWrite + Send + Unpin>> =
            Box::pin(sink);
        let llm = JudgeTaskLlm {
            gateway_url: "http://gateway:8001".to_string(),
            eval_token: "token".to_string(),
            provider_id: "prov-1".to_string(),
            allowed_models: vec!["qwen-plus".to_string()],
        };
        let big_prompt = "x".repeat(32 * 1024 + 1);
        let frame = serde_json::json!({
            "type": "capability",
            "id": "byok-2",
            "name": "request_user_llm_completion",
            "args": [big_prompt]
        });
        handle_user_llm_capability(&mut writer, &frame, Some(&llm))
            .await
            .unwrap();

        let mut buf = [0u8; 1024];
        let n = tokio::time::timeout(Duration::from_secs(1), source.read(&mut buf))
            .await
            .expect("读取 BYOK 错误帧超时")
            .unwrap();
        let text = String::from_utf8_lossy(&buf[..n]).to_string();
        assert!(text.contains("BYOK_PROMPT_TOO_LARGE"));
    }
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd noj-judge && cargo nextest run --all-targets -E 'test(test_user_llm_|test_map_user_llm_gateway_error)'`
Expected: FAIL（`user_llm_error_frame` / `map_user_llm_gateway_error` 不存在，编译错误）。

- [ ] **Step 3: Write minimal implementation**

在 `src/dual/mod.rs` 中新增两个纯函数，并修改 `handle_user_llm_capability` 使用它们。

在 `handle_user_llm_capability` 函数前新增：

```rust
/// 构造 BYOK 错误帧。
fn user_llm_error_frame(id: &str, code: &str, message: &str) -> Value {
    serde_json::json!({
        "type": "error",
        "id": id,
        "code": code,
        "message": message,
    })
}

/// 将 gateway 非成功响应映射为 BYOK 错误码。
fn map_user_llm_gateway_error(status: u16, gateway_code: Option<&str>) -> &'static str {
    match gateway_code {
        Some("limit_exceeded" | "rate_limit_exceeded") => "BYOK_QUOTA_EXCEEDED",
        Some("provider_disabled" | "provider_not_found") => "BYOK_CONFIG_UNAVAILABLE",
        Some("provider_target_rejected") => "BYOK_PROVIDER_TARGET_REJECTED",
        _ if status == 401 || status == 403 => "BYOK_GATEWAY_UNAVAILABLE",
        _ => "BYOK_PROVIDER_ERROR",
    }
}
```

修改 `handle_user_llm_capability`：

- 删除内部 `let error_frame = |code: &str, message: &str| { ... };` 闭包。
- 将所有 `error_frame(...)` 调用替换为 `user_llm_error_frame(id, ...)`。
- 将非成功响应映射块替换为：

```rust
    if !status.is_success() {
        let gateway_code = body.get("error").and_then(Value::as_str);
        let code = map_user_llm_gateway_error(status.as_u16(), gateway_code);
        return forward_frame(sol_input, &user_llm_error_frame(id, code, "用户模型请求失败"))
            .await;
    }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd noj-judge && cargo nextest run --all-targets -E 'test(test_user_llm_|test_map_user_llm_gateway_error)'`
Expected: 全部 PASS。

- [ ] **Step 5: Commit**

```bash
cd /home/xyber-nova/Github/neuro-oj
jj describe -m "test(judge): 提取 BYOK 错误映射纯函数并补充错误路径测试"
```

---

### Task 10: Judge 并发/取消 drain 单元测试

**Files:**
- Modify: `noj-judge/src/drain.rs`

**Interfaces:**
- Consumes: `drain_tasks` from `crate::drain`
- Produces: 验证 drain 超时后 abort 挂起任务的回归测试

- [ ] **Step 1: Write the failing test**

在 `src/drain.rs` 的 `mod tests` 末尾追加：

```rust
    #[tokio::test]
    async fn test_drain_aborts_hung_tasks_after_timeout() {
        let mut tasks: FuturesUnordered<tokio::task::JoinHandle<()>> = FuturesUnordered::new();
        tasks.push(tokio::spawn(async {
            tokio::time::sleep(Duration::from_secs(3600)).await;
        }));

        let start = std::time::Instant::now();
        drain_tasks(&mut tasks, 0).await;

        assert!(
            start.elapsed() < Duration::from_secs(5),
            "drain 超时后应立即 abort，不应等待挂起任务"
        );
        assert!(tasks.is_empty(), "abort 后 tasks 应被消费清空");
    }
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd noj-judge && cargo nextest run --all-targets -E 'test(test_drain_aborts_hung_tasks_after_timeout)'`
Expected: FAIL（尚未添加）。

- [ ] **Step 3: Write minimal implementation**

本任务只新增测试，不修改生产代码；`drain_tasks` 已实现超时 abort。

- [ ] **Step 4: Run test to verify it passes**

Run: `cd noj-judge && cargo nextest run --all-targets -E 'test(test_drain_aborts_hung_tasks_after_timeout)'`
Expected: PASS。

- [ ] **Step 5: Commit**

```bash
cd /home/xyber-nova/Github/neuro-oj
jj describe -m "test(judge): 补充 drain 超时 abort 挂起任务测试"
```

---

### Task 11: Judge Docker E2E 异常场景测试

**Files:**
- Create: `noj-judge/tests/e2e_abnormal.rs`

**Interfaces:**
- Consumes: `common::{get_docker, is_e2e_enabled, ensure_sdk_images}`、`noj_judge::dual::evaluate_dual_with_cpu_limit`、`noj_judge::types::{EvaluatorRuntime, RuntimeConfig, SolutionRuntime}`
- Produces: 评测器崩溃、无结果、双容器失败、支持包缺失的 Docker E2E 回归测试

- [ ] **Step 1: Write the failing test**

创建 `tests/e2e_abnormal.rs`：

```rust
//! 双容器异常场景 E2E：评测器崩溃、无结果、双容器失败、支持包缺失。
mod common;

use std::time::Duration;

use common::{get_docker, is_e2e_enabled};
use noj_judge::types::{EvaluatorRuntime, RuntimeConfig, SolutionRuntime};

async fn sdk_runtime(evaluator_cmd: &str, time_limit_ms: u64) -> RuntimeConfig {
    RuntimeConfig {
        evaluator: EvaluatorRuntime {
            image: "noj-e2e-sdk-evaluator:latest".to_string(),
            command: evaluator_cmd.to_string(),
            time_limit_ms,
            memory_limit_mb: 256,
            network: None,
        },
        solution: SolutionRuntime {
            image: "noj-e2e-sdk-solution:latest".to_string(),
            call_timeout_ms: 5000,
            memory_limit_mb: 128,
        },
    }
}

/// 评测器崩溃（非零退出且无 ---RESULT---）→ SystemError。
#[ignore]
#[serial_test::serial]
#[tokio::test]
async fn evaluator_crash_no_result_returns_system_error() {
    if !is_e2e_enabled() {
        return;
    }
    let docker = get_docker().expect("docker");
    common::ensure_sdk_images(&docker).await.unwrap();

    let runtime_config = sdk_runtime(
        r#"python3 -c "import sys; sys.stderr.write('boom\n'); sys.exit(1)""#,
        15000,
    )
    .await;

    let result = tokio::time::timeout(
        Duration::from_secs(30),
        noj_judge::dual::evaluate_dual_with_cpu_limit(
            docker,
            "e2e-evaluator-crash",
            &runtime_config,
            "def solve(): return 1",
            None,
            None,
            None,
            None,
            1000,
            true,
            "bridge",
            "noj-",
            &["python3".to_string()],
            300_000,
            60_000,
        ),
    )
    .await
    .expect("评测 30s 外层超时")
    .expect("评测应正常返回");

    assert_eq!(result.status, "error", "评测器崩溃应归 SystemError: {:?}", result);
}

/// 评测器正常退出但无 ---RESULT--- → SystemError。
#[ignore]
#[serial_test::serial]
#[tokio::test]
async fn evaluator_no_result_exit0_returns_system_error() {
    if !is_e2e_enabled() {
        return;
    }
    let docker = get_docker().expect("docker");
    common::ensure_sdk_images(&docker).await.unwrap();

    let runtime_config = sdk_runtime(r#"python3 -c "print('done')""#, 15000).await;

    let result = tokio::time::timeout(
        Duration::from_secs(30),
        noj_judge::dual::evaluate_dual_with_cpu_limit(
            docker,
            "e2e-evaluator-no-result",
            &runtime_config,
            "def solve(): return 1",
            None,
            None,
            None,
            None,
            1000,
            true,
            "bridge",
            "noj-",
            &["python3".to_string()],
            300_000,
            60_000,
        ),
    )
    .await
    .expect("评测 30s 外层超时")
    .expect("评测应正常返回");

    assert_eq!(result.status, "error", "无 RESULT 应归 SystemError: {:?}", result);
}

/// 双容器创建失败（镜像不存在）→ evaluate_dual 返回 Err。
#[ignore]
#[serial_test::serial]
#[tokio::test]
async fn dual_container_failure_returns_err() {
    if !is_e2e_enabled() {
        return;
    }
    let docker = get_docker().expect("docker");

    let runtime_config = RuntimeConfig {
        evaluator: EvaluatorRuntime {
            image: "noj-missing-image:latest".to_string(),
            command: "python3 x".to_string(),
            time_limit_ms: 5000,
            memory_limit_mb: 256,
            network: None,
        },
        solution: SolutionRuntime {
            image: "noj-missing-image:latest".to_string(),
            call_timeout_ms: 1000,
            memory_limit_mb: 128,
        },
    };

    let result = noj_judge::dual::evaluate_dual_with_cpu_limit(
        docker,
        "e2e-dual-failure",
        &runtime_config,
        "",
        None,
        None,
        None,
        None,
        1000,
        true,
        "bridge",
        "noj-",
        &["python3".to_string()],
        300_000,
        60_000,
    )
    .await;

    assert!(result.is_err(), "镜像不存在应导致 Err: {:?}", result);
}

/// 支持包缺失时，不依赖支持包的评测仍可 finished。
#[ignore]
#[serial_test::serial]
#[tokio::test]
async fn support_package_missing_still_finished() {
    if !is_e2e_enabled() {
        return;
    }
    let docker = get_docker().expect("docker");
    common::ensure_sdk_images(&docker).await.unwrap();

    let runtime_config = sdk_runtime(
        r#"python3 -c "import sys,json; sys.stdout.write('---RESULT---\n'); sys.stdout.write(json.dumps({'score':10000,'details':{}})); sys.stdout.flush()""#,
        15000,
    )
    .await;

    let result = tokio::time::timeout(
        Duration::from_secs(30),
        noj_judge::dual::evaluate_dual_with_cpu_limit(
            docker,
            "e2e-support-missing",
            &runtime_config,
            "def solve(): return 1",
            None,
            None,
            None,
            None,
            1000,
            true,
            "bridge",
            "noj-",
            &["python3".to_string()],
            300_000,
            60_000,
        ),
    )
    .await
    .expect("评测 30s 外层超时")
    .expect("评测应正常返回");

    assert_eq!(result.status, "finished", "无支持包也应 finished: {:?}", result);
    assert_eq!(result.score, 10000);
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd noj-judge && NOJ_RUN_E2E=1 cargo nextest run --all-targets --test e2e_abnormal --run-ignored ignored-only`
Expected: 新测试 FAIL（文件不存在，编译错误）。

- [ ] **Step 3: Write minimal implementation**

本任务只新增 E2E 测试，不修改生产代码。若 Docker 环境不可用，测试会因 `NOJ_RUN_E2E` 未设置而直接返回；CI 中按 `NOJ_RUN_E2E=1` 运行。

- [ ] **Step 4: Run test to verify it passes**

Run: `cd noj-judge && NOJ_RUN_E2E=1 cargo nextest run --all-targets --test e2e_abnormal --run-ignored ignored-only`
Expected: 4 个测试全部 PASS（需要 Docker daemon 与网络构建 SDK 镜像）。

- [ ] **Step 5: Commit**

```bash
cd /home/xyber-nova/Github/neuro-oj
jj describe -m "test(judge): 新增 Docker E2E 异常场景测试"
```

---

## Self-Review

- **Spec coverage:** Phase 3 的 gateway 限流/额度/并发/429、billed-token 计费与审计、Provider 错误分支、配置/密钥缺失、replay 扩展均已覆盖（Task 1-5）；judge 的 ZIP 边界、资源限制、结果解析、错误路径、并发/取消、Docker E2E 异常均已覆盖（Task 6-11）。
- **Placeholder scan:** 所有步骤均给出实际命令与代码，无 TBD/TODO。
- **Type consistency:** gateway 测试统一使用 `tests/helpers.ts` 导出的 `FakeRedis`/`createFakeDb`/`makeProvider`/`testConfig`/`makeToken`/`requestChat`/`stubFetch`；judge 测试直接使用模块内私有函数，签名与生产代码一致。
