import { assert, assertEquals } from "jsr:@std/assert@^1";
import {
  maskApiKey,
  updateProvider,
  validateByokBaseUrl,
} from "../src/providers.ts";
import { decryptSecret } from "../src/crypto.ts";
import { createFakeDb, makeProvider, testConfig } from "./helpers.ts";

Deno.test("providers: maskApiKey masks plaintext key suffix", () => {
  assertEquals(maskApiKey("sk-1234567890abcdef"), "sk-****cdef");
  assertEquals(maskApiKey("short"), "****");
});

Deno.test("providers: 更新使用参数数组绑定，支持单字段、多字段与空更新", async () => {
  for (
    const input of [
      { name: "新名称" },
      {
        name: "新名称",
        model: "新模型",
        enabled: false,
        cost_per_1k_tokens: 2,
        api_key: "sk-new-test-key",
      },
      {},
    ]
  ) {
    const provider = await makeProvider(testConfig.storeKey);
    const { db } = createFakeDb(provider);
    let calls = 0;
    const unsafe = (query: string, params: unknown, ...rest: unknown[]) => {
      calls++;
      assert(Array.isArray(params), "postgres.js 的第二个参数必须是绑定数组");
      assertEquals(rest.length, 0, "不得将参数展开到 options 等位置");
      const fields = [...query.matchAll(/(\w+) = \$(\d+)/g)];
      assertEquals(fields.length, params.length);
      for (const [, field, index] of fields) {
        const value = params[Number(index) - 1];
        if (field === "id") {
          assertEquals(value, provider.id);
        } else {
          Object.assign(provider, { [field]: value });
        }
      }
      return Promise.resolve([]);
    };
    db.unsafe = unsafe as typeof db.unsafe;
    const result = await updateProvider(
      db,
      provider.id,
      input,
      testConfig.storeKey,
    );
    assertEquals(calls, 1);
    assertEquals(result.name, input.name ?? "test");
    assertEquals(result.model, input.model ?? "deepseek-chat");
    assertEquals(result.enabled, input.enabled ?? true);
    assertEquals(result.cost_per_1k_tokens, input.cost_per_1k_tokens ?? 1);
    assert(!("api_key" in result));
    assert(!("encrypted_api_key" in result));
    const expectedKey = input.api_key ?? "sk-test";
    assertEquals(
      await decryptSecret(provider.encrypted_api_key, testConfig.storeKey),
      expectedKey,
    );
    assertEquals(result.api_key_masked, maskApiKey(expectedKey));
  }
});

Deno.test("providers: BYOK base URL rejects unsafe targets", () => {
  assertEquals(
    validateByokBaseUrl("https://api.openai.com/v1"),
    "https://api.openai.com/v1",
  );
  for (
    const value of [
      "http://api.openai.com",
      "https://localhost",
      "https://127.0.0.1",
      "https://169.254.169.254",
      "https://api.openai.com:8443",
      "https://evil.example",
    ]
  ) {
    try {
      validateByokBaseUrl(value);
      throw new Error(`expected target to be rejected: ${value}`);
    } catch (error) {
      if (
        !(error instanceof Error) ||
        error.message !== "provider_target_rejected"
      ) {
        throw error;
      }
    }
  }
});

// ── 2026-09-21 修复：BYOK 更新路径的 mass assignment ──
// 触发条件：普通用户 PUT /api/v1/users/me/llm-providers/:id，body 带 enabled
// 或 cost_per_1k_tokens（core 路由原样转发请求体，TS 泛型运行时被擦除）。
async function byokRow(storeKey: string) {
  const p = await makeProvider(storeKey);
  // created_by !== "0" 表示用户自建（BYOK）
  return { ...p, created_by: "user-1" };
}

Deno.test("providers: BYOK 更新拒绝 enabled（用户不得自行解禁）", async () => {
  const provider = await byokRow(testConfig.storeKey);
  const { db } = createFakeDb(provider);
  let reachedUpdate = false;
  const unsafe = (query: string, params: unknown, ...rest: unknown[]) => {
    void query;
    void params;
    void rest;
    reachedUpdate = true;
    return Promise.resolve([]);
  };
  db.unsafe = unsafe as unknown as typeof db.unsafe;
  try {
    await updateProvider(
      db,
      provider.id,
      { enabled: true },
      testConfig.storeKey,
    );
    throw new Error("expected provider_invalid");
  } catch (error) {
    if (!(error instanceof Error) || error.message !== "provider_invalid") {
      throw error;
    }
  }
  assertEquals(reachedUpdate, false, "不得执行到 UPDATE");
});

Deno.test("providers: BYOK 更新拒绝负 cost（防止配额退款）", async () => {
  const provider = await byokRow(testConfig.storeKey);
  const { db } = createFakeDb(provider);
  const unsafe = (query: string, params: unknown, ...rest: unknown[]) => {
    void query;
    void params;
    void rest;
    return Promise.resolve([]);
  };
  db.unsafe = unsafe as unknown as typeof db.unsafe;
  for (const bad of [-1, -100000]) {
    try {
      await updateProvider(
        db,
        provider.id,
        { cost_per_1k_tokens: bad },
        testConfig.storeKey,
      );
      throw new Error(`expected provider_invalid for ${bad}`);
    } catch (error) {
      if (!(error instanceof Error) || error.message !== "provider_invalid") {
        throw error;
      }
    }
  }
});

Deno.test("providers: BYOK 更新仍允许白名单字段", async () => {
  const provider = await byokRow(testConfig.storeKey);
  const { db } = createFakeDb(provider);
  const unsafe = (query: string, params: unknown) => {
    const fields = [...query.matchAll(/(\w+) = \$(\d+)/g)];
    for (const [, field, index] of fields) {
      const value = (params as unknown[])[Number(index) - 1];
      if (field !== "id") Object.assign(provider, { [field]: value });
    }
    return Promise.resolve([]);
  };
  db.unsafe = unsafe as unknown as typeof db.unsafe;
  const result = await updateProvider(
    db,
    provider.id,
    { name: "改名", model: "gpt-4o-mini" },
    testConfig.storeKey,
  );
  assertEquals(result.name, "改名");
  assertEquals(result.model, "gpt-4o-mini");
});

Deno.test("providers: 管理员 Provider（created_by=0）仍可更新 enabled 与 cost", async () => {
  const provider = await makeProvider(testConfig.storeKey); // created_by = "0"
  const { db } = createFakeDb(provider);
  const unsafe = (query: string, params: unknown) => {
    const fields = [...query.matchAll(/(\w+) = \$(\d+)/g)];
    for (const [, field, index] of fields) {
      const value = (params as unknown[])[Number(index) - 1];
      if (field !== "id") Object.assign(provider, { [field]: value });
    }
    return Promise.resolve([]);
  };
  db.unsafe = unsafe as unknown as typeof db.unsafe;
  const result = await updateProvider(
    db,
    provider.id,
    { enabled: false, cost_per_1k_tokens: 3 },
    testConfig.storeKey,
  );
  assertEquals(result.enabled, false);
  assertEquals(result.cost_per_1k_tokens, 3);
});
