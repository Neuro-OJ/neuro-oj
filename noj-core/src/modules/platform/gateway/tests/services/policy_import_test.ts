/** Gateway 政策导入的显式幂等与超时恢复合同测试。 */
import { assertEquals } from "jsr:@std/assert@^1";
import {
  type GatewayPolicySnapshot,
  importGatewayPolicySnapshot,
} from "../../services/llm.ts";

const snapshot: GatewayPolicySnapshot = {
  revision: 0,
  day: { max_calls: 10, max_tokens: 1000, max_cost: 3 },
  month: { max_calls: null, max_tokens: null, max_cost: 7 },
  updated_at: "2026-10-21T00:00:00.000Z",
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function setGatewayEnv(): () => void {
  const oldUrl = Deno.env.get("NOJ_LLM_GATEWAY_URL");
  const oldToken = Deno.env.get("NOJ_LLM_SERVICE_TOKEN");
  Deno.env.set("NOJ_LLM_GATEWAY_URL", "http://gateway.policy.test");
  Deno.env.set("NOJ_LLM_SERVICE_TOKEN", "policy-import-test-token-012345");
  return () => {
    if (oldUrl === undefined) Deno.env.delete("NOJ_LLM_GATEWAY_URL");
    else Deno.env.set("NOJ_LLM_GATEWAY_URL", oldUrl);
    if (oldToken === undefined) Deno.env.delete("NOJ_LLM_SERVICE_TOKEN");
    else Deno.env.set("NOJ_LLM_SERVICE_TOKEN", oldToken);
  };
}

Deno.test("policy import: 存量快照只应用一次，重复导入不覆盖新政策", async () => {
  const restoreEnv = setGatewayEnv();
  const originalFetch = globalThis.fetch;
  let revision = 0;
  let currentPolicy: unknown = snapshot;
  const operations = new Map<string, { revision: number; policy: unknown }>();
  globalThis.fetch = (async (input, init) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    if (url.pathname === "/internal/policy" && request.method === "PUT") {
      const operationId = request.headers.get("X-Noj-Operation-Id")!;
      const existing = operations.get(operationId);
      if (existing) {
        return jsonResponse({
          data: {
            operation_id: operationId,
            status: "applied",
            revision: existing.revision,
            policy: existing.policy,
          },
        });
      }
      assertEquals(
        Number(request.headers.get("X-Noj-Expected-Revision")),
        revision,
      );
      const policy = JSON.parse(await request.text());
      revision += 1;
      currentPolicy = policy;
      operations.set(operationId, { revision, policy });
      return jsonResponse({
        data: {
          operation_id: operationId,
          status: "applied",
          revision,
          policy,
        },
      });
    }
    throw new Error(`unexpected fetch ${request.method} ${request.url}`);
  }) as typeof fetch;
  try {
    const first = await importGatewayPolicySnapshot(snapshot, "admin-1");
    assertEquals(first, { revision: 1, imported: true });

    // 模拟迁移后管理员已经把 Gateway 政策更新到更高 revision。
    revision = 2;
    currentPolicy = {
      day: { max_calls: 2, max_tokens: 200, max_cost: 1 },
      month: snapshot.month,
    };
    const newerPolicy = currentPolicy;

    const second = await importGatewayPolicySnapshot(snapshot, "admin-1");
    assertEquals(second, { revision: 1, imported: true });
    assertEquals(currentPolicy, newerPolicy);
  } finally {
    globalThis.fetch = originalFetch;
    restoreEnv();
  }
});

Deno.test("policy import: PUT 超时后按原 operation ID 查询，不换 ID 重试写入", async () => {
  const restoreEnv = setGatewayEnv();
  const originalFetch = globalThis.fetch;
  const calls: string[] = [];
  let operationId = "";
  globalThis.fetch = (async (input, init) => {
    await Promise.resolve();
    const request = new Request(input, init);
    const url = new URL(request.url);
    calls.push(`${request.method} ${url.pathname}`);
    if (request.method === "PUT") {
      operationId = request.headers.get("X-Noj-Operation-Id") ?? "";
      throw new DOMException("gateway response timed out", "TimeoutError");
    }
    assertEquals(
      url.pathname,
      `/internal/operations/${encodeURIComponent(operationId)}`,
    );
    return jsonResponse({
      data: {
        operation_id: operationId,
        status: "applied",
        revision: 4,
      },
    });
  }) as typeof fetch;
  try {
    const result = await importGatewayPolicySnapshot(snapshot, "admin-1");
    assertEquals(result, { revision: 4, imported: true });
    assertEquals(calls.length, 2);
    assertEquals(calls[0]?.startsWith("PUT /internal/policy"), true);
    assertEquals(calls[1]?.startsWith("GET /internal/operations/"), true);
  } finally {
    globalThis.fetch = originalFetch;
    restoreEnv();
  }
});
