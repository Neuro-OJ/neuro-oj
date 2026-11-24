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

  // 按推算起始时间 start_ms = created_at_ms - latency_ms 升序排序并计算相对最早起始时间的 offset_ms
  assertEquals(result.traces.map((t) => t.id), ["call-1", "call-2", "call-3"]);
  assertEquals(result.traces.map((t) => t.seq), [1, 2, 3]);
  assertEquals(result.traces.map((t) => t.offset_ms), [0, 950, 1850]);
  assertEquals(result.traces[0]!.request_params, { max_tokens: 512 });
  assertFalse("request_messages" in result.traces[0]!);
});

Deno.test("usage-summary: 并发重叠调用按 start_ms 排序并计算正确瀑布流 offset_ms", () => {
  // Call A: 10:00:00.000 开始，耗时 1000ms（10:00:01.000 完成）
  // Call B: 10:00:00.200 开始，耗时 300ms（10:00:00.500 完成 -> created_at 早于 A！）
  // Call C: 10:00:00.200 开始，耗时 600ms（10:00:00.800 完成）
  const result = buildSubmissionUsageSummary([
    {
      id: "call-b",
      model: "gpt-4o",
      status: "ok",
      prompt_tokens: 10,
      completion_tokens: 5,
      total_tokens: 15,
      estimated_cost: 1,
      latency_ms: 300,
      created_at: "2026-11-24T10:00:00.500Z",
    },
    {
      id: "call-c",
      model: "gpt-4o",
      status: "ok",
      prompt_tokens: 10,
      completion_tokens: 5,
      total_tokens: 15,
      estimated_cost: 1,
      latency_ms: 600,
      created_at: "2026-11-24T10:00:00.800Z",
    },
    {
      id: "call-a",
      model: "deepseek-chat",
      status: "ok",
      prompt_tokens: 20,
      completion_tokens: 10,
      total_tokens: 30,
      estimated_cost: 2,
      latency_ms: 1000,
      created_at: "2026-11-24T10:00:01.000Z",
    },
  ]);

  assertEquals(result.traces.map((t) => t.id), ["call-a", "call-b", "call-c"]);
  assertEquals(result.traces.map((t) => t.seq), [1, 2, 3]);
  assertEquals(result.traces.map((t) => t.offset_ms), [0, 200, 200]);
});

Deno.test("usage-summary: 超过 limit/1000 行时全量统计不截断，仅截断返回的 traces 列表", () => {
  const baseMs = Date.parse("2026-11-24T10:00:00.000Z");
  const rows = Array.from({ length: 1005 }, (_, i) => ({
    id: `row-${String(i + 1).padStart(4, "0")}`,
    model: i % 2 === 0 ? "deepseek-chat" : "gpt-4o",
    status: i === 1004 ? "error" : "ok",
    prompt_tokens: 10,
    completion_tokens: 5,
    cached_prompt_tokens: 2,
    total_tokens: 15,
    estimated_cost: 1,
    latency_ms: i === 1004 ? 999 : 100,
    created_at: new Date(baseMs + (i + 1) * 1000).toISOString(),
  }));

  // 默认上限 1000：summary 统计全部 1005 条（包含末尾高延迟与失败行），traces 返回前 1000 条
  const defaultRes = buildSubmissionUsageSummary(rows);
  assertEquals(defaultRes.summary.total_calls, 1005);
  assertEquals(defaultRes.summary.error_calls, 1);
  assertEquals(defaultRes.summary.total_tokens, 1005 * 15);
  assertEquals(defaultRes.summary.estimated_cost, 1005);
  assertEquals(defaultRes.summary.total_latency_ms, 1004 * 100 + 999);
  assertEquals(defaultRes.traces.length, 1000);
  assertEquals(defaultRes.traces[0]!.id, "row-0001");
  assertEquals(defaultRes.traces[999]!.id, "row-1000");

  // 自定义 limit=5：summary 仍覆盖全部 1005 条，traces 截断为 5 条
  const limitedRes = buildSubmissionUsageSummary(rows, { limit: 5 });
  assertEquals(limitedRes.summary.total_calls, 1005);
  assertEquals(limitedRes.summary.total_tokens, 1005 * 15);
  assertEquals(limitedRes.traces.length, 5);
  assertEquals(limitedRes.traces.map((t) => t.seq), [1, 2, 3, 4, 5]);
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
  ]);
  assertFalse(capturedDefault[0]!.query.includes("LIMIT"));

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
  assertEquals(capturedWithMsg[0]!.params, ["domain-xyz", "att-2"]);
  assertEquals(
    bodyWithMsg.data.traces[0]!.request_messages?.[0]?.content,
    "Bearer [REDACTED]",
  );
});
