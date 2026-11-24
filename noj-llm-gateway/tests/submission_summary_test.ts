/**
 * `/internal/usage/submission-summary` 聚合统计、attempt_id 隔离、P95 计算与
 * `include_messages` 脱敏开关测试。
 */
import {
  assertEquals,
  assertFalse,
  assertStringIncludes,
} from "jsr:@std/assert@^1";
import { createInternalRouter } from "../src/routes/internal.ts";
import {
  buildSubmissionUsageSummary,
  computeP95Latency,
  sanitizeMessagesForTrace,
} from "../src/usage-summary.ts";
import type { Db } from "../src/db.ts";
import type { GatewayConfig } from "../src/config.ts";

interface CapturedQuery {
  query: string;
  params: unknown[];
}

function makeSummaryFakeDb(
  rows: Record<string, unknown>[],
  captured: CapturedQuery[],
): Db {
  const db = Object.assign(
    () => Promise.resolve([]),
    {
      unsafe: (query: string, params: unknown) => {
        captured.push({ query, params: [...(params as unknown[])] });
        return Promise.resolve(rows);
      },
    },
  );
  return db as unknown as Db;
}

const testConfig = {
  serviceToken: "test-service-token",
  storeKey: "test-store-key",
} as unknown as GatewayConfig;

Deno.test("usage-summary: computeP95Latency 覆盖空数组、单条、无序与 20 条样本", () => {
  assertEquals(computeP95Latency([]), 0);
  assertEquals(computeP95Latency([120]), 120);
  // 20 条样本升序 10..200，ceil(20 * 0.95) - 1 = 18 → 第 19 个元素 190
  const twenty = Array.from({ length: 20 }, (_, i) => (20 - i) * 10);
  assertEquals(computeP95Latency(twenty), 190);
});

Deno.test("usage-summary: buildSubmissionUsageSummary 聚合统计与瀑布流 offset_ms", () => {
  const result = buildSubmissionUsageSummary([
    {
      id: "call-2",
      model: "gpt-4o",
      status: "error",
      error_code: "upstream_500",
      prompt_tokens: 100,
      completion_tokens: 0,
      cached_prompt_tokens: 0,
      total_tokens: 100,
      estimated_cost: 5,
      latency_ms: 450,
      created_at: "2026-11-24T10:00:01.250Z",
      request_params: { temperature: 0.2 },
      request_messages: [{ role: "user", content: "hi" }],
    },
    {
      id: "call-1",
      model: "deepseek-chat",
      status: "ok",
      error_code: null,
      prompt_tokens: 200,
      completion_tokens: 50,
      cached_prompt_tokens: 40,
      total_tokens: 250,
      estimated_cost: 12,
      latency_ms: 150,
      created_at: "2026-11-24T10:00:00.000Z",
      request_params: JSON.stringify({ max_tokens: 512 }),
      request_messages: [{ role: "system", content: "judge" }],
    },
    {
      id: "call-3",
      model: "deepseek-chat",
      status: "ok",
      error_code: null,
      prompt_tokens: 300,
      completion_tokens: 100,
      cached_prompt_tokens: 60,
      total_tokens: 400,
      estimated_cost: 20,
      latency_ms: 300,
      created_at: "2026-11-24T10:00:02.000Z",
      request_params: {},
      request_messages: [{ role: "user", content: "next" }],
    },
  ], { includeMessages: false });

  assertEquals(result.summary, {
    total_calls: 3,
    error_calls: 1,
    prompt_tokens: 600,
    completion_tokens: 150,
    cached_prompt_tokens: 100,
    total_tokens: 750,
    estimated_cost: 37,
    total_latency_ms: 900,
    avg_latency_ms: 300,
    p95_latency_ms: 450,
    models: [
      {
        model: "deepseek-chat",
        calls: 2,
        total_tokens: 650,
        estimated_cost: 32,
      },
      { model: "gpt-4o", calls: 1, total_tokens: 100, estimated_cost: 5 },
    ],
  });

  // 按 created_at ASC 排序并分配 1-based seq 与相对首条调用的 offset_ms
  assertEquals(result.traces.map((t) => t.id), ["call-1", "call-2", "call-3"]);
  assertEquals(result.traces.map((t) => t.seq), [1, 2, 3]);
  assertEquals(result.traces.map((t) => t.offset_ms), [0, 1250, 2000]);
  assertEquals(result.traces[0]!.request_params, { max_tokens: 512 });
  assertFalse("request_messages" in result.traces[0]!);
});

Deno.test("usage-summary: sanitizeMessagesForTrace 脱敏密钥并截断超长正文", () => {
  const longBody = "x".repeat(4500);
  const sanitized = sanitizeMessagesForTrace([
    {
      role: "user",
      content:
        `token Bearer secret_bearer_token_123 and sk-proj1234567890abcdef ${longBody}`,
      extra_secret: "should_be_dropped",
    },
  ]) as Array<Record<string, unknown>>;

  assertEquals(sanitized.length, 1);
  assertFalse("extra_secret" in sanitized[0]!);
  const content = String(sanitized[0]!.content);
  assertFalse(content.includes("secret_bearer_token_123"));
  assertFalse(content.includes("sk-proj1234567890abcdef"));
  assertStringIncludes(content, "Bearer [REDACTED]");
  assertStringIncludes(content, "sk-[REDACTED]");
  assertStringIncludes(content, "truncated");
});

Deno.test("internal/usage/submission-summary: 缺少 submission_id 与 attempt_id 返回 400", async () => {
  const app = createInternalRouter({
    config: testConfig,
    db: makeSummaryFakeDb([], []),
  });
  const res = await app.request("/internal/usage/submission-summary", {
    headers: { authorization: `Bearer ${testConfig.serviceToken}` },
  });
  assertEquals(res.status, 400);
  const body = await res.json() as { error: string };
  assertEquals(body.error, "submission_id_or_attempt_id_required");
});

Deno.test("internal/usage/submission-summary: attempt_id 隔离、域头透传与 include_messages 开关", async () => {
  const capturedDefault: CapturedQuery[] = [];
  const sampleRows = [
    {
      id: "c1",
      model: "deepseek-chat",
      status: "ok",
      error_code: null,
      prompt_tokens: 10,
      completion_tokens: 20,
      cached_prompt_tokens: 0,
      total_tokens: 30,
      estimated_cost: 1,
      latency_ms: 80,
      created_at: "2026-11-24T10:00:00.000Z",
      request_params: { temperature: 0 },
      request_messages: [{ role: "user", content: "Bearer abcdefgh123456" }],
    },
  ];

  const appDefault = createInternalRouter({
    config: testConfig,
    db: makeSummaryFakeDb(sampleRows, capturedDefault),
  });

  // 默认 include_messages=0：SQL 不查 request_messages，响应不含 request_messages
  const resDefault = await appDefault.request(
    "/internal/usage/submission-summary?submission_id=sub-1&attempt_id=att-2",
    {
      headers: {
        authorization: `Bearer ${testConfig.serviceToken}`,
        "X-Noj-Domain-Id": "domain-xyz",
      },
    },
  );
  assertEquals(resDefault.status, 200);
  const bodyDefault = await resDefault.json() as {
    data: {
      summary: { total_calls: number };
      traces: Array<Record<string, unknown>>;
    };
  };
  assertEquals(bodyDefault.data.summary.total_calls, 1);
  assertFalse("request_messages" in bodyDefault.data.traces[0]!);
  assertEquals(capturedDefault.length, 1);
  assertFalse(capturedDefault[0]!.query.includes("request_messages"));
  assertStringIncludes(capturedDefault[0]!.query, "domain_id = $1");
  assertStringIncludes(capturedDefault[0]!.query, "submission_id = $2");
  assertStringIncludes(capturedDefault[0]!.query, "attempt_id = $3");
  assertEquals(capturedDefault[0]!.params, [
    "domain-xyz",
    "sub-1",
    "att-2",
    1000,
  ]);

  // include_messages=1：SQL 查询 request_messages，响应包含脱敏后消息
  const capturedWithMsg: CapturedQuery[] = [];
  const appWithMsg = createInternalRouter({
    config: testConfig,
    db: makeSummaryFakeDb(sampleRows, capturedWithMsg),
  });
  const resWithMsg = await appWithMsg.request(
    "/internal/usage/submission-summary?attempt_id=att-2&include_messages=1",
    {
      headers: {
        authorization: `Bearer ${testConfig.serviceToken}`,
        "X-Noj-Domain-Id": "domain-xyz",
      },
    },
  );
  assertEquals(resWithMsg.status, 200);
  const bodyWithMsg = await resWithMsg.json() as {
    data: { traces: Array<{ request_messages?: Array<{ content: string }> }> };
  };
  assertStringIncludes(capturedWithMsg[0]!.query, "request_messages");
  assertStringIncludes(capturedWithMsg[0]!.query, "attempt_id = $2");
  assertEquals(capturedWithMsg[0]!.params, ["domain-xyz", "att-2", 1000]);
  assertEquals(
    bodyWithMsg.data.traces[0]!.request_messages?.[0]?.content,
    "Bearer [REDACTED]",
  );
});
