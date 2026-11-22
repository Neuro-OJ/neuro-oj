/**
 * 平台身份模型调用客户端：成功与各错误码映射（mock fetch，不需要数据库）。
 */
import {
  assert,
  assertEquals,
  assertInstanceOf,
  assertRejects,
} from "jsr:@std/assert@^1";
import {
  BadRequestError,
  ServiceUnavailableError,
} from "../../../../../shared/base/errors.ts";
import { LlmGatewayError } from "../../services/llm.ts";
import {
  KNOWLEDGE_TAG_MODEL_ALIAS,
  mapPlatformCompletionError,
  PLATFORM_MAX_OUTPUT_TOKENS,
  platformCompletion,
  PlatformCompletionError,
  queryPlatformUsage,
} from "../../index.ts";

interface GatewayStub {
  /** 已发送的请求（method 与 URL / body）。 */
  // deno-lint-ignore no-explicit-any
  calls: { method: string; url: string; body: any; headers: Headers }[];
  /** 设置下一次响应。 */
  respond: (status: number, body: unknown) => void;
  /** 让下一次请求抛网络错误。 */
  fail: () => void;
}

/** 用 fetch 替身运行 fn，结束后恢复环境变量与全局 fetch。 */
async function withGateway(
  fn: (stub: GatewayStub) => Promise<void>,
): Promise<void> {
  const originalFetch = globalThis.fetch;
  const oldToken = Deno.env.get("NOJ_LLM_SERVICE_TOKEN");
  const oldUrl = Deno.env.get("NOJ_LLM_GATEWAY_URL");
  Deno.env.set("NOJ_LLM_SERVICE_TOKEN", "test-service-token");
  Deno.env.set("NOJ_LLM_GATEWAY_URL", "http://gateway.test");
  const stub: GatewayStub & {
    next: { status: number; body: unknown } | "network-error";
  } = {
    calls: [],
    next: { status: 200, body: {} },
    respond(status, body) {
      this.next = { status, body };
    },
    fail() {
      this.next = "network-error";
    },
  };
  // deno-lint-ignore no-explicit-any
  (globalThis as any).fetch = (
    input: string | URL | Request,
    init?: RequestInit,
  ) => {
    const url = String(input);
    const body: unknown = init?.body ? JSON.parse(String(init.body)) : null;
    stub.calls.push({
      method: init?.method ?? "GET",
      url,
      body,
      headers: new Headers(init?.headers),
    });
    if (stub.next === "network-error") {
      return Promise.reject(new TypeError("connection refused"));
    }
    return Promise.resolve(
      new Response(JSON.stringify(stub.next.body), {
        status: stub.next.status,
        headers: { "content-type": "application/json" },
      }),
    );
  };
  try {
    await fn(stub);
  } finally {
    // deno-lint-ignore no-explicit-any
    (globalThis as any).fetch = originalFetch;
    if (oldToken === undefined) Deno.env.delete("NOJ_LLM_SERVICE_TOKEN");
    else Deno.env.set("NOJ_LLM_SERVICE_TOKEN", oldToken);
    if (oldUrl === undefined) Deno.env.delete("NOJ_LLM_GATEWAY_URL");
    else Deno.env.set("NOJ_LLM_GATEWAY_URL", oldUrl);
  }
}

const okBody = {
  content: '{"tags":[]}',
  model: "tag-model",
  usage: { input_tokens: 120, output_tokens: 30, cached_input_tokens: 20 },
  cost: 3,
};

const input = {
  purpose: "knowledge.tag" as const,
  model_alias: KNOWLEDGE_TAG_MODEL_ALIAS,
  messages: [{ role: "user" as const, content: "题干" }],
  max_tokens: 256,
  temperature: 0,
  response_format: { type: "json_object" },
};

Deno.test("platformCompletion：成功时透传内容、用量并以服务令牌鉴权", async () => {
  await withGateway(async (stub) => {
    stub.respond(200, okBody);
    const result = await platformCompletion(input);
    assertEquals(result.content, '{"tags":[]}');
    assertEquals(result.model, "tag-model");
    assertEquals(result.usage, {
      input_tokens: 120,
      output_tokens: 30,
      cached_input_tokens: 20,
    });
    assertEquals(result.cost, 3);
    assertEquals(stub.calls.length, 1);
    const call = stub.calls[0]!;
    assertEquals(call.method, "POST");
    assertEquals(
      call.url,
      "http://gateway.test/internal/platform-completions",
    );
    assertEquals(
      call.headers.get("Authorization"),
      "Bearer test-service-token",
    );
    assertEquals(call.body.purpose, "knowledge.tag");
    assertEquals(call.body.model_alias, "platform.tagger");
    assertEquals(call.body.max_tokens, 256);
    assertEquals(call.body.response_format, { type: "json_object" });
  });
});

Deno.test("platformCompletion：别名未配置映射为 MODEL_ALIAS_NOT_CONFIGURED", async () => {
  await withGateway(async (stub) => {
    stub.respond(404, { error: "MODEL_ALIAS_NOT_CONFIGURED" });
    const error = await assertRejects(
      () => platformCompletion(input),
      PlatformCompletionError,
    );
    assertInstanceOf(error, LlmGatewayError);
    assertEquals(error.status, 404);
    assertEquals(error.code, "MODEL_ALIAS_NOT_CONFIGURED");
    const mapped = mapPlatformCompletionError(error);
    assertInstanceOf(mapped, BadRequestError);
    assertEquals(mapped.code, "MODEL_ALIAS_NOT_CONFIGURED");
  });
});

Deno.test("platformCompletion：上游/排队限流映射为 429", async () => {
  for (
    const [status, code] of [[429, "RATE_LIMITED"], [
      429,
      "PROVIDER_RATE_LIMITED",
    ]] as const
  ) {
    await withGateway(async (stub) => {
      stub.respond(status, { error: code });
      const error = await assertRejects(
        () => platformCompletion(input),
        PlatformCompletionError,
      );
      assertEquals(error.code, code);
      const mapped = mapPlatformCompletionError(error);
      assertEquals(mapped.statusCode, 429);
      assertEquals(mapped.code, code);
    });
  }
});

Deno.test("platformCompletion：上游故障与网关不可达映射为 503", async () => {
  await withGateway(async (stub) => {
    stub.respond(502, { error: "UPSTREAM_ERROR" });
    const error = await assertRejects(
      () => platformCompletion(input),
      PlatformCompletionError,
    );
    assertEquals(error.code, "UPSTREAM_ERROR");
    assertInstanceOf(
      mapPlatformCompletionError(error),
      ServiceUnavailableError,
    );
  });
  await withGateway(async (stub) => {
    stub.fail();
    const error = await assertRejects(
      () => platformCompletion(input),
      PlatformCompletionError,
    );
    assertEquals(error.code, "gateway_unavailable");
    assertInstanceOf(
      mapPlatformCompletionError(error),
      ServiceUnavailableError,
    );
  });
});

Deno.test("platformCompletion：max_tokens 越界在本地即拒绝，不访问网关", async () => {
  await withGateway(async (stub) => {
    for (
      const max_tokens of [
        0,
        -1,
        PLATFORM_MAX_OUTPUT_TOKENS + 1,
        1.5,
      ]
    ) {
      await assertRejects(
        () => platformCompletion({ ...input, max_tokens }),
        BadRequestError,
      );
    }
    await assertRejects(
      () => platformCompletion({ ...input, messages: [] }),
      BadRequestError,
    );
    assertEquals(stub.calls.length, 0);
  });
});

Deno.test("queryPlatformUsage：透传 purpose/since 并解析累计值", async () => {
  await withGateway(async (stub) => {
    stub.respond(200, {
      purpose: "knowledge.tag",
      since: "2026-11-01T00:00:00.000Z",
      input_tokens: 400,
      output_tokens: 110,
      requests: 3,
      cost: 12,
    });
    const result = await queryPlatformUsage(
      "knowledge.tag",
      "2026-11-01T00:00:00Z",
    );
    assertEquals(result, {
      purpose: "knowledge.tag",
      since: "2026-11-01T00:00:00.000Z",
      input_tokens: 400,
      output_tokens: 110,
      requests: 3,
      cost: 12,
    });
    const call = stub.calls[0]!;
    assertEquals(call.method, "GET");
    assert(call.url.includes("/internal/platform-usage?purpose=knowledge.tag"));
    assert(call.url.includes("since=2026-11-01T00%3A00%3A00Z"));
  });
});

Deno.test("queryPlatformUsage：网关错误以 PlatformCompletionError 抛出", async () => {
  await withGateway(async (stub) => {
    stub.respond(400, { error: "invalid_purpose" });
    const error = await assertRejects(
      () => queryPlatformUsage("knowledge.tag", new Date()),
      PlatformCompletionError,
    );
    assertEquals(error.code, "invalid_purpose");
    assertEquals(error.status, 400);
  });
});
