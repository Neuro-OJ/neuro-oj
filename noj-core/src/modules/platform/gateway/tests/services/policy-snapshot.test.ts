/**
 * Gateway 政策迁移快照测试（P5）。
 *
 * 验证 Core 侧导出/导入/核对的行为：
 * - 导出只读，不修改 `domain_llm_quota_caps`；
 * - 缺省/非法设置导出空政策（迁移起点）；
 * - 导入使用稳定 operation ID（同摘要重复导入命中同一操作）；
 * - 核对读取 Gateway 当前政策。
 *
 * 网络调用通过替换 `globalThis.fetch` 拦截，断言请求路径、头与幂等键。
 */
import { assertEquals } from "jsr:@std/assert@^1";
import { eq } from "drizzle-orm";
import { getDb } from "../../../../../shared/db/connection.ts";
import { resetDbForTest } from "../../../../../../tests/helpers/db.ts";
import { systemSettings } from "../../../../../shared/db/schema.ts";
import {
  _resetSystemSettingsForTest,
  refreshSettingsCache,
} from "../../../system/index.ts";
import {
  exportGatewayPolicySnapshot,
  importGatewayPolicySnapshot,
  readGatewayPolicy,
} from "../../services/llm.ts";

// 这些用例只验证请求构造与幂等键，不访问真实 Gateway；显式设置内部凭据，
// 避免依赖运行环境是否恰好配置了 NOJ_LLM_SERVICE_TOKEN。
Deno.env.set("NOJ_LLM_SERVICE_TOKEN", "test-service-token-policy-snapshot");
Deno.env.set("NOJ_LLM_GATEWAY_URL", "http://gateway.test.invalid");

const CAPS = {
  day: { max_calls: 10, max_tokens: 1000, max_cost: 3 },
  month: { max_calls: null, max_tokens: null, max_cost: 7 },
};

async function setCapsSetting(value: unknown): Promise<void> {
  // 设置值在 DB 中是「JSON 字符串的 JSON 字面量」：registry type=text 存的是
  // 一个字符串，字符串内容本身是政策 JSON。
  await getDb().insert(systemSettings).values({
    key: "domain_llm_quota_caps",
    value: JSON.stringify(JSON.stringify(value)),
    updated_at: new Date().toISOString(),
  }).onConflictDoUpdate({
    target: systemSettings.key,
    set: { value: JSON.stringify(JSON.stringify(value)) },
  });
  // 必须真实重载缓存（不能只 cache.delete：未命中不会回查 DB）。
  await refreshSettingsCache();
}

/** 拦截 gateway 内部请求并记录。 */
function withFetchStub(
  handler: (url: string, init?: RequestInit) => Response,
  fn: (calls: Array<{ url: string; init?: RequestInit }>) => Promise<void>,
): Promise<void> {
  const original = globalThis.fetch;
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init });
    return Promise.resolve(handler(url, init));
  }) as typeof fetch;
  return fn(calls).finally(() => {
    globalThis.fetch = original;
  });
}

Deno.test("gateway policy snapshot: 导出只读且保留旧设置", async () => {
  await resetDbForTest();
  await setCapsSetting(CAPS);
  const before = await getDb().select().from(systemSettings).where(
    eq(systemSettings.key, "domain_llm_quota_caps"),
  );
  const snapshot = await exportGatewayPolicySnapshot();
  assertEquals(snapshot.day.max_calls, 10);
  assertEquals(snapshot.month.max_cost, 7);
  // 旧设置没有 revision：迁移起点固定 0。
  assertEquals(snapshot.revision, 0);
  const after = await getDb().select().from(systemSettings).where(
    eq(systemSettings.key, "domain_llm_quota_caps"),
  );
  assertEquals(after[0].value, before[0].value);
});

Deno.test("gateway policy snapshot: 缺省设置导出空政策", async () => {
  await resetDbForTest();
  await refreshSettingsCache();
  const snapshot = await exportGatewayPolicySnapshot();
  assertEquals(snapshot.day, {
    max_calls: null,
    max_tokens: null,
    max_cost: null,
  });
  assertEquals(snapshot.month, {
    max_calls: null,
    max_tokens: null,
    max_cost: null,
  });
});

Deno.test("gateway policy snapshot: 导入使用稳定 operation ID 与预期 revision", async () => {
  await resetDbForTest();
  const snapshot = {
    revision: 0,
    day: CAPS.day,
    month: CAPS.month,
    updated_at: new Date().toISOString(),
  };
  await withFetchStub(
    () =>
      new Response(
        JSON.stringify({ data: { revision: 1, status: "applied" } }),
        { headers: { "content-type": "application/json" } },
      ),
    async (calls) => {
      const first = await importGatewayPolicySnapshot(snapshot, "admin-1");
      const second = await importGatewayPolicySnapshot(snapshot, "admin-1");
      assertEquals(first.revision, 1);
      assertEquals(second.revision, 1);
      assertEquals(calls.length, 2);
      assertEquals(calls[0].url.endsWith("/internal/policy"), true);
      const headers = new Headers(calls[0].init?.headers);
      assertEquals(headers.get("X-Noj-Expected-Revision"), "0");
      assertEquals(headers.get("X-Noj-Actor-Id"), "admin-1");
      // 同一快照必须生成同一 operation ID：重复导入不会覆盖更新政策。
      assertEquals(
        headers.get("X-Noj-Operation-Id"),
        new Headers(calls[1].init?.headers).get("X-Noj-Operation-Id"),
      );
      assertEquals(
        headers.get("X-Noj-Operation-Id")!.startsWith("policy-import-"),
        true,
      );
    },
  );
});

Deno.test("gateway policy snapshot: 核对读取 Gateway 当前政策", async () => {
  await resetDbForTest();
  await withFetchStub(
    () =>
      new Response(
        JSON.stringify({
          data: {
            revision: 3,
            day: CAPS.day,
            month: CAPS.month,
            updated_at: "2026-10-21T00:00:00.000Z",
          },
        }),
        { headers: { "content-type": "application/json" } },
      ),
    async (calls) => {
      const policy = await readGatewayPolicy();
      assertEquals(policy.revision, 3);
      assertEquals(policy.day.max_tokens, 1000);
      assertEquals(calls[0].url.endsWith("/internal/policy"), true);
    },
  );
});
