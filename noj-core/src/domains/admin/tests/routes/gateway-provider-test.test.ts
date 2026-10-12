import { assertEquals } from "jsr:@std/assert@^1";
import router, { describeProviderTestFailure } from "../../routes/gateway.ts";
import { LlmGatewayError } from "../../../gateway/services/llm.ts";

/**
 * 以桩替换 fetch 与 gateway 环境变量，捕获 core → gateway 的请求并返回指定响应。
 */
async function withGatewayStub(
  response: { status: number; body: unknown },
  fn: (calls: { url: string; body: unknown }[]) => Promise<void>,
): Promise<void> {
  const originalFetch = globalThis.fetch;
  const prevToken = Deno.env.get("NOJ_LLM_SERVICE_TOKEN");
  const prevUrl = Deno.env.get("NOJ_LLM_GATEWAY_URL");
  const calls: { url: string; body: unknown }[] = [];
  Deno.env.set("NOJ_LLM_SERVICE_TOKEN", "test-service-token");
  Deno.env.set("NOJ_LLM_GATEWAY_URL", "http://gateway.test");
  globalThis.fetch = (input, init) => {
    calls.push({
      url: String(input),
      body: init?.body ? JSON.parse(String(init.body)) : null,
    });
    return Promise.resolve(
      new Response(JSON.stringify(response.body), { status: response.status }),
    );
  };
  try {
    await fn(calls);
  } finally {
    globalThis.fetch = originalFetch;
    if (prevToken === undefined) Deno.env.delete("NOJ_LLM_SERVICE_TOKEN");
    else Deno.env.set("NOJ_LLM_SERVICE_TOKEN", prevToken);
    if (prevUrl === undefined) Deno.env.delete("NOJ_LLM_GATEWAY_URL");
    else Deno.env.set("NOJ_LLM_GATEWAY_URL", prevUrl);
  }
}

function postTest(id: string, body: unknown): Promise<Response> {
  return Promise.resolve(
    router.request(`/llm/providers/${id}/test`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
}

Deno.test("admin gateway: Provider 连接测试成功时返回 ok 并透传模型", async () => {
  await withGatewayStub(
    { status: 200, body: { data: { status: "ok" } } },
    async (calls) => {
      const res = await postTest("prov-1", { model: "  Qwen/Qwen3-8B " });
      assertEquals(res.status, 200);
      const json = await res.json();
      assertEquals(json.data.status, "ok");
      assertEquals(json.data.model, "Qwen/Qwen3-8B");
      assertEquals(typeof json.data.latency_ms, "number");
      assertEquals(calls.length, 1);
      assertEquals(
        calls[0].url,
        "http://gateway.test/internal/providers/prov-1/test",
      );
      assertEquals(calls[0].body, { model: "Qwen/Qwen3-8B" });
    },
  );
});

Deno.test("admin gateway: 上游鉴权失败作为测试结果返回而非 5xx", async () => {
  await withGatewayStub(
    { status: 502, body: { error: "provider_auth_failed" } },
    async () => {
      const res = await postTest("prov-1", { model: "Qwen/Qwen3-8B" });
      assertEquals(res.status, 200);
      const json = await res.json();
      assertEquals(json.data.status, "failed");
      assertEquals(json.data.code, "provider_auth_failed");
      assertEquals(json.data.message.includes("API Key"), true);
    },
  );
});

Deno.test("admin gateway: 连接测试失败原因映射", () => {
  for (
    const code of [
      "provider_auth_failed",
      "provider_rate_limited",
      "provider_unavailable",
      "provider_error",
      "provider_base_url_blocked",
    ]
  ) {
    assertEquals(
      describeProviderTestFailure(new LlmGatewayError(502, code))?.code,
      code,
    );
  }
  // Provider 不存在 / gateway 不可用 / 非 gateway 错误不视为测试结果
  assertEquals(
    describeProviderTestFailure(new LlmGatewayError(404, "provider_not_found")),
    null,
  );
  assertEquals(
    describeProviderTestFailure(
      new LlmGatewayError(503, "gateway_unavailable"),
    ),
    null,
  );
  assertEquals(describeProviderTestFailure(new Error("boom")), null);
});
