import { assert, assertEquals } from "jsr:@std/assert@^1";
import { maskApiKey, updateProvider } from "../src/providers.ts";
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

// ── 管理员 Provider 更新仍可改 enabled 与 cost（通用输入校验保留） ──

Deno.test("providers: 管理员 Provider 可更新 enabled 与 cost", async () => {
  const provider = await makeProvider(testConfig.storeKey);
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
