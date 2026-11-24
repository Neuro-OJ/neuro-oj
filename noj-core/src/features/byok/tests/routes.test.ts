/**
 * 用户自带模型（BYOK）：本人配置路由、评测凭据签发与比赛/作业拦截。
 *
 * gateway 以 fetch 替身模拟，只断言 core 侧的转发与映射。
 */
import { assert, assertEquals, assertRejects } from "jsr:@std/assert@^1";
import { decodeBase64 } from "@std/encoding/base64";
import { Hono } from "hono";
import { eq } from "drizzle-orm";
import { initRedisForTest, jsonRequest } from "../../../../tests/helper.ts";
import { resetDbForTest } from "../../../../tests/helpers/db.ts";
import { byokRouter } from "../routes.ts";
import { AppError } from "../../../shared/base/errors.ts";
import { signToken } from "../../../modules/access/identity/services/security/jwt.ts";
import { hashPassword } from "../../../modules/access/identity/services/security/password.ts";
import { getDb } from "../../../shared/db/connection.ts";
import { users } from "../../../shared/db/schema.ts";
import { buildJudgeTaskLlm } from "../../../modules/platform/gateway/services/llm-token.ts";
import { createSubmission } from "../../../modules/evaluations/services/submissions/submission-create.ts";
import type { RuntimeConfig } from "../../../modules/problems/index.ts";

await resetDbForTest();
await initRedisForTest();

const GATEWAY = "http://gateway.byok.test";
const SERVICE_TOKEN = "test-service-token-0123456789abcdef";

interface GatewayCall {
  method: string;
  path: string;
  ifMatch: string | null;
  body: unknown;
}

/** 替换全局 fetch 为假 gateway；返回调用记录与还原函数。 */
function stubGateway(
  handler: (call: GatewayCall) => { status: number; body?: unknown },
): { calls: GatewayCall[]; restore: () => void } {
  const original = globalThis.fetch;
  const oldUrl = Deno.env.get("NOJ_LLM_GATEWAY_URL");
  const oldToken = Deno.env.get("NOJ_LLM_SERVICE_TOKEN");
  Deno.env.set("NOJ_LLM_GATEWAY_URL", GATEWAY);
  Deno.env.set("NOJ_LLM_SERVICE_TOKEN", SERVICE_TOKEN);
  const calls: GatewayCall[] = [];
  globalThis.fetch =
    (async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      if (url.origin !== GATEWAY) return await original(input, init);
      const headers = new Headers(init?.headers);
      const call = {
        method: init?.method ?? "GET",
        path: url.pathname,
        ifMatch: headers.get("If-Match"),
        body: init?.body ? JSON.parse(String(init.body)) : undefined,
      };
      calls.push(call);
      const { status, body } = handler(call);
      return new Response(body === undefined ? null : JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;
  return {
    calls,
    restore: () => {
      globalThis.fetch = original;
      if (oldUrl === undefined) Deno.env.delete("NOJ_LLM_GATEWAY_URL");
      else Deno.env.set("NOJ_LLM_GATEWAY_URL", oldUrl);
      if (oldToken === undefined) Deno.env.delete("NOJ_LLM_SERVICE_TOKEN");
      else Deno.env.set("NOJ_LLM_SERVICE_TOKEN", oldToken);
    },
  };
}

function createTestApp() {
  const app = new Hono<{ Variables: { userId: string; userRole: string } }>();
  app.onError((err, c) => {
    if (err instanceof AppError) {
      return c.json(
        { error: err.message, code: err.code },
        err.statusCode as 400 | 404 | 409 | 429 | 503,
      );
    }
    console.error(err);
    return c.json({ error: "服务器内部错误" }, 500);
  });
  app.route("/api/v1", byokRouter);
  return app;
}

async function createTestUser(): Promise<string> {
  const id = crypto.randomUUID();
  const unique = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  await getDb().insert(users).values({
    id,
    username: `byok_${unique}`,
    email: `byok_${unique}@test.com`,
    password_hash: await hashPassword("TestByokPass1"),
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  });
  return id;
}

function view(userId: string, overrides: Record<string, unknown> = {}) {
  return {
    provider_id: `byok:${userId}`,
    base_url: "https://api.openai.com/v1",
    model: "gpt-user",
    api_key_masked: "sk-****abcd",
    enabled: true,
    revision: 1,
    created_at: "2026-11-24T00:00:00.000Z",
    updated_at: "2026-11-24T00:00:00.000Z",
    ...overrides,
  };
}

async function decryptToken(token: string): Promise<Record<string, unknown>> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(SERVICE_TOKEN),
  );
  const key = await crypto.subtle.importKey("raw", digest, "AES-GCM", false, [
    "decrypt",
  ]);
  const data = decodeBase64(token);
  const plain = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: data.slice(0, 12) },
    key,
    data.slice(12),
  );
  return JSON.parse(new TextDecoder().decode(plain));
}

const runtimeConfig = {
  evaluator: { time_limit_ms: 60_000 },
} as unknown as RuntimeConfig;

const pgTest = (name: string, fn: () => Promise<void>) =>
  Deno.test({ name, sanitizeResources: false, sanitizeOps: false, fn });

pgTest("byok route: 未登录返回 401", async () => {
  const res = await jsonRequest(createTestApp(), "/api/v1/me/llm-provider");
  assertEquals(res.status, 401);
});

pgTest("byok route: GET 透传实例开关与本人配置", async () => {
  const userId = await createTestUser();
  const gw = stubGateway(() => ({
    status: 200,
    body: {
      data: view(userId),
      enabled: true,
      allowed_hosts: ["api.openai.com"],
    },
  }));
  try {
    const res = await jsonRequest(createTestApp(), "/api/v1/me/llm-provider", {
      token: await signToken({ sub: userId, role: "user" }),
    });
    assertEquals(res.status, 200);
    const body = await res.json();
    assertEquals(body.data.enabled, true);
    assertEquals(body.data.provider.model, "gpt-user");
    assertEquals(gw.calls[0].path, `/internal/user-providers/${userId}`);
  } finally {
    gw.restore();
    await getDb().delete(users).where(eq(users.id, userId));
  }
});

pgTest("byok route: PUT 只转发白名单字段并带 If-Match", async () => {
  const userId = await createTestUser();
  const gw = stubGateway(() => ({ status: 201, body: { data: view(userId) } }));
  try {
    const res = await jsonRequest(createTestApp(), "/api/v1/me/llm-provider", {
      method: "PUT",
      token: await signToken({ sub: userId, role: "user" }),
      headers: { "If-Match": "0" },
      body: {
        base_url: " https://api.openai.com/v1 ",
        model: "gpt-user",
        api_key: "sk-secret",
        user_id: "victim",
        cost_per_1k_tokens: -1,
      },
    });
    assertEquals(res.status, 201);
    assertEquals(gw.calls[0].method, "PUT");
    assertEquals(gw.calls[0].path, `/internal/user-providers/${userId}`);
    assertEquals(gw.calls[0].ifMatch, "0");
    assertEquals(gw.calls[0].body, {
      base_url: "https://api.openai.com/v1",
      model: "gpt-user",
      api_key: "sk-secret",
    });
  } finally {
    gw.restore();
    await getDb().delete(users).where(eq(users.id, userId));
  }
});

pgTest("byok route: 缺 If-Match 与网关关闭分别返回 400", async () => {
  const userId = await createTestUser();
  const gw = stubGateway(() => ({
    status: 400,
    body: { error: "byok_disabled" },
  }));
  try {
    const token = await signToken({ sub: userId, role: "user" });
    const missing = await jsonRequest(
      createTestApp(),
      "/api/v1/me/llm-provider",
      { method: "PUT", token, body: { model: "m" } },
    );
    assertEquals(missing.status, 400);
    assertEquals((await missing.json()).code, "REVISION_REQUIRED");
    assertEquals(gw.calls.length, 0);

    const disabled = await jsonRequest(
      createTestApp(),
      "/api/v1/me/llm-provider",
      {
        method: "PUT",
        token,
        headers: { "If-Match": "0" },
        body: { model: "m" },
      },
    );
    assertEquals(disabled.status, 400);
    assertEquals((await disabled.json()).code, "BYOK_UNAVAILABLE");
  } finally {
    gw.restore();
    await getDb().delete(users).where(eq(users.id, userId));
  }
});

pgTest("byok route: 测试连接的上游失败以 failed 返回", async () => {
  const userId = await createTestUser();
  const gw = stubGateway(() => ({
    status: 502,
    body: { error: "provider_auth_failed" },
  }));
  try {
    const res = await jsonRequest(
      createTestApp(),
      "/api/v1/me/llm-provider/test",
      { method: "POST", token: await signToken({ sub: userId, role: "user" }) },
    );
    assertEquals(res.status, 200);
    const body = await res.json();
    assertEquals(body.data.status, "failed");
    assertEquals(body.data.code, "provider_auth_failed");
  } finally {
    gw.restore();
    await getDb().delete(users).where(eq(users.id, userId));
  }
});

Deno.test("byok token: 别名全部映射到用户模型，provider 为 byok:<user>", async () => {
  const gw = stubGateway(() => ({
    status: 200,
    body: { data: view("u-1"), enabled: true, allowed_hosts: [] },
  }));
  try {
    const llm = await buildJudgeTaskLlm(
      { models: ["default", "fast"] },
      "sub-1",
      "prob-1",
      "u-1",
      runtimeConfig,
      { attemptId: "att-1", byok: true },
    );
    assertEquals(llm.provider_id, "byok:u-1");
    assertEquals(llm.allowed_models, ["default", "fast"]);
    assertEquals(llm.model_map, { default: "gpt-user", fast: "gpt-user" });
    const payload = await decryptToken(llm.eval_token);
    assertEquals(payload.provider_id, "byok:u-1");
    assertEquals(payload.user_id, "u-1");
    // 只访问用户 Provider，不解析域配置、不读平台 Provider
    assertEquals(gw.calls.map((c) => c.path), ["/internal/user-providers/u-1"]);

    const defaultOnly = await buildJudgeTaskLlm(
      {},
      "sub-1",
      "prob-1",
      "u-1",
      runtimeConfig,
      { attemptId: "att-1", byok: true },
    );
    assertEquals(defaultOnly.allowed_models, ["gpt-user"]);
    assert(!defaultOnly.model_map);
  } finally {
    gw.restore();
  }
});

Deno.test("byok token: 实例关闭 / 未配置 / 已停用分别给出稳定错误码", async () => {
  for (
    const [body, code] of [
      [
        { data: view("u-1"), enabled: false, allowed_hosts: [] },
        "BYOK_UNAVAILABLE",
      ],
      [{ data: null, enabled: true, allowed_hosts: [] }, "BYOK_NOT_CONFIGURED"],
      [
        {
          data: view("u-1", { enabled: false }),
          enabled: true,
          allowed_hosts: [],
        },
        "BYOK_DISABLED",
      ],
    ] as const
  ) {
    const gw = stubGateway(() => ({ status: 200, body }));
    try {
      const error = await assertRejects(() =>
        buildJudgeTaskLlm({}, "s", "p", "u-1", runtimeConfig, {
          attemptId: "a",
          byok: true,
        })
      );
      assertEquals((error as AppError).code, code);
    } finally {
      gw.restore();
    }
  }
});

Deno.test("byok token: 冻结快照的 BYOK Provider 不属于提交者时拒绝", async () => {
  const gw = stubGateway(() => ({
    status: 200,
    body: { data: view("u-1"), enabled: true, allowed_hosts: [] },
  }));
  try {
    const error = await assertRejects(() =>
      buildJudgeTaskLlm({}, "s", "p", "u-1", runtimeConfig, {
        attemptId: "a",
        frozen: {
          domain_id: "00000000-0000-4000-8000-000000000001",
          provider_id: "byok:someone-else",
          model: "gpt-user",
          max_calls: 1,
          max_tokens: 1,
        },
      })
    );
    assertEquals((error as AppError).code, "BYOK_OWNER_MISMATCH");
    assertEquals(gw.calls.length, 0);
  } finally {
    gw.restore();
  }
});

Deno.test("byok submission: 比赛提交携带 use_own_llm_key 被拒", async () => {
  const error = await assertRejects(() =>
    createSubmission(
      "u-1",
      {
        problem_id: "p",
        language: "python",
        code: "print(1)",
        use_own_llm_key: true,
      },
      "contest-1",
    )
  );
  assertEquals((error as AppError).code, "BYOK_NOT_ALLOWED");
});
