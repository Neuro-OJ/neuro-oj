import { assertEquals, assertRejects, assertThrows } from "jsr:@std/assert@^1";
import { capDomainQuota, loadCurrentQuotaCaps } from "../src/quota-policy.ts";
import {
  canonicalPolicyJson,
  emptyPolicyCaps,
  readCurrentPolicy,
  validateCaps,
} from "../src/policy-operations.ts";
import type { Db } from "../src/db.ts";
import { createFakeDb, makeProvider, testConfig } from "./helpers.ts";

/** 构造只响应 llm_policy 查询的假连接。 */
function fakePolicyDb(
  row:
    | {
      revision: number;
      day_max_calls: number | null;
      day_max_tokens: number | null;
      day_max_cost: number | null;
      month_max_calls: number | null;
      month_max_tokens: number | null;
      month_max_cost: number | null;
      updated_at: string;
    }
    | null,
): Db {
  return ((strings: TemplateStringsArray) => {
    const sql = strings.join("?");
    if (sql.includes("FROM llm_policy")) {
      return Promise.resolve(row ? [row] : []);
    }
    return Promise.resolve([]);
  }) as unknown as Db;
}

const POLICY_ROW = {
  revision: 4,
  day_max_calls: 10,
  day_max_tokens: 1000,
  day_max_cost: 3,
  month_max_calls: null,
  month_max_tokens: null,
  month_max_cost: 7,
  updated_at: "2026-10-21T00:00:00.000Z",
};

Deno.test("实例政策：本地读取当前上限，null 不解除数值上限", async () => {
  // 本地权威：不发起任何 Core 请求。
  const original = globalThis.fetch;
  let fetchCalls = 0;
  globalThis.fetch = () => {
    fetchCalls++;
    return Promise.reject(new Error("不应访问网络"));
  };
  try {
    const first = await loadCurrentQuotaCaps(fakePolicyDb(POLICY_ROW));
    assertEquals(first.day.max_calls, 10);
    assertEquals(first.day.max_tokens, 1000);
    assertEquals(first.day.max_cost, 3);
    assertEquals(first.month.max_cost, 7);
    assertEquals(fetchCalls, 0);

    assertEquals(
      capDomainQuota(
        { max_calls: null, max_tokens: 100, max_cost: 1 },
        first.day,
      ),
      { max_calls: 10, max_tokens: 100, max_cost: 1 },
    );
  } finally {
    globalThis.fetch = original;
  }
});

Deno.test("实例政策：缺行时返回空政策且 revision=0", async () => {
  const policy = await readCurrentPolicy(fakePolicyDb(null));
  assertEquals(policy.revision, 0);
  assertEquals(policy.day, {
    max_calls: null,
    max_tokens: null,
    max_cost: null,
  });
  assertEquals(policy.month, {
    max_calls: null,
    max_tokens: null,
    max_cost: null,
  });
});

Deno.test("实例政策：非法上限被拒绝", () => {
  const invalid = [
    { day: { max_calls: -1 }, month: {} },
    { day: { max_calls: 1.5 }, month: {} },
    { day: { max_tokens: "10" }, month: {} },
    { day: null, month: {} },
    { month: {} },
  ];
  for (const input of invalid) {
    assertThrows(() => validateCaps(input), Error, "INVALID_POLICY_CAPS");
  }
  // 缺省字段视为 null；合法输入原样返回。
  const ok = validateCaps({
    day: { max_calls: 5, max_tokens: null },
    month: { max_cost: 0 },
  });
  assertEquals(ok.day.max_calls, 5);
  assertEquals(ok.day.max_tokens, null);
  assertEquals(ok.day.max_cost, null);
  assertEquals(ok.month.max_cost, 0);
});

Deno.test("实例政策：规范化 JSON 字段顺序稳定", () => {
  const a = emptyPolicyCaps();
  const b = { month: { ...a.month }, day: { ...a.day } };
  assertEquals(canonicalPolicyJson(a), canonicalPolicyJson(b));
});

Deno.test("实例政策不可用：新调用 503，未预占、未访问上游", async () => {
  const { createLlmRouter } = await import("../src/routes/llm.ts");
  const { FakeRedis, makeToken, publicDns, requestChat } = await import(
    "./helpers.ts"
  );
  const provider = await makeProvider(testConfig.storeKey);
  const { db, usageInserts } = createFakeDb(provider);
  // 让政策读取抛错：模拟持久政策不可读（DB 故障）。
  const brokenDb = ((
    strings: TemplateStringsArray,
    ...values: unknown[]
  ) => {
    if (strings.join("?").includes("FROM llm_policy")) {
      return Promise.reject(new Error("db_down"));
    }
    return (db as unknown as (
      s: TemplateStringsArray,
      ...v: unknown[]
    ) => Promise<unknown>)(strings, ...values);
  }) as unknown as Db;
  (brokenDb as unknown as { begin: unknown }).begin = (
    operation: (tx: Db) => Promise<unknown>,
  ) => operation(brokenDb);
  (brokenDb as unknown as { unsafe: unknown }).unsafe = () =>
    Promise.resolve([]);

  const app = createLlmRouter({
    config: testConfig,
    db: brokenDb,
    redis: new FakeRedis(),
    resolveDns: publicDns,
  });
  const original = globalThis.fetch;
  let upstreamCalls = 0;
  globalThis.fetch = () => {
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
    assertEquals(usageInserts.length, 0);
  } finally {
    globalThis.fetch = original;
  }
});

Deno.test("实例政策：Core 离线不影响政策读取", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = () => Promise.reject(new Error("core_offline"));
  try {
    const caps = await loadCurrentQuotaCaps(fakePolicyDb(POLICY_ROW));
    assertEquals(caps.day.max_calls, 10);
  } finally {
    globalThis.fetch = original;
  }
});
