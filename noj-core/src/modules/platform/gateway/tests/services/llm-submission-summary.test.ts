import { assertEquals } from "jsr:@std/assert@^1";
import { getSubmissionLlmSummary } from "../../services/llm.ts";

function withEnv(
  vars: Record<string, string | undefined>,
  fn: () => Promise<void>,
): Promise<void> {
  const backup = new Map<string, string | undefined>();
  for (const [k, v] of Object.entries(vars)) {
    backup.set(k, Deno.env.get(k));
    if (v === undefined) Deno.env.delete(k);
    else Deno.env.set(k, v);
  }
  return fn().finally(() => {
    for (const [k, v] of backup.entries()) {
      if (v === undefined) Deno.env.delete(k);
      else Deno.env.set(k, v);
    }
  });
}

Deno.test("getSubmissionLlmSummary: 未配置 token 时优雅降级为 available=false", async () => {
  await withEnv({ NOJ_LLM_SERVICE_TOKEN: undefined }, async () => {
    const res = await getSubmissionLlmSummary({ submission_id: "sub-1" });
    assertEquals(res, { available: false, data: null });
  });
});

Deno.test("getSubmissionLlmSummary: Gateway 返回 500 或网络失败时优雅降级", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = () =>
    Promise.resolve(
      new Response(JSON.stringify({ error: "internal_error" }), {
        status: 500,
      }),
    );
  try {
    await withEnv(
      {
        NOJ_LLM_SERVICE_TOKEN: "test-token-1234567890",
        NOJ_LLM_GATEWAY_URL: "http://127.0.0.1:8001",
      },
      async () => {
        const res = await getSubmissionLlmSummary({
          submission_id: "sub-1",
          attempt_id: "att-1",
          include_messages: true,
        }, "domain-abc");
        assertEquals(res, { available: false, data: null });
      },
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test("getSubmissionLlmSummary: 成功透传参数与域头并返回 summary/traces", async () => {
  const originalFetch = globalThis.fetch;
  let capturedUrl = "";
  let capturedDomain = "";
  const payload = {
    data: {
      summary: {
        total_calls: 1,
        error_calls: 0,
        prompt_tokens: 10,
        completion_tokens: 5,
        cached_prompt_tokens: 0,
        total_tokens: 15,
        estimated_cost: 1,
        total_latency_ms: 50,
        avg_latency_ms: 50,
        p95_latency_ms: 50,
        models: [{
          model: "deepseek-chat",
          calls: 1,
          total_tokens: 15,
          estimated_cost: 1,
        }],
      },
      traces: [],
    },
  };
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    capturedUrl = String(input);
    const headers = new Headers(init?.headers);
    capturedDomain = headers.get("X-Noj-Domain-Id") ?? "";
    return Promise.resolve(
      new Response(JSON.stringify(payload), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
  }) as typeof fetch;

  try {
    await withEnv(
      {
        NOJ_LLM_SERVICE_TOKEN: "test-token-1234567890",
        NOJ_LLM_GATEWAY_URL: "http://gateway.local",
      },
      async () => {
        const res = await getSubmissionLlmSummary(
          {
            submission_id: "sub-1",
            attempt_id: "att-1",
            include_messages: true,
          },
          "domain-xyz",
        );
        assertEquals(res, { available: true, data: payload.data });
        assertEquals(
          capturedUrl,
          "http://gateway.local/internal/usage/submission-summary?submission_id=sub-1&attempt_id=att-1&include_messages=1",
        );
        assertEquals(capturedDomain, "domain-xyz");
      },
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});
