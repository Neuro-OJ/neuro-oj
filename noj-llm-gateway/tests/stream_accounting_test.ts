/** P5.3 流式记账：正常结束、客户端中断和上游中断都不重发上游。 */
import { assert, assertEquals, assertRejects } from "jsr:@std/assert@^1";
import {
  createFakeDb,
  FakeRedis,
  makeProvider,
  makeToken,
  publicDns,
  requestChat,
  stubFetch,
  testConfig,
} from "./helpers.ts";
import { createLlmRouter } from "../src/routes/llm.ts";

const encoder = new TextEncoder();

async function waitUntil(
  predicate: () => boolean,
  message: string,
): Promise<void> {
  for (let index = 0; index < 50; index++) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert(false, message);
}

function streamResponse(chunks: string[]): Response {
  let index = 0;
  return new Response(
    new ReadableStream<Uint8Array>({
      pull(controller) {
        const chunk = chunks[index++];
        if (chunk === undefined) controller.close();
        else controller.enqueue(encoder.encode(chunk));
      },
    }),
    {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    },
  );
}

Deno.test("stream accounting: 正常结束读取最终 usage 并结算", async () => {
  const provider = await makeProvider(testConfig.storeKey);
  const { db, usageInserts, ledger } = createFakeDb(provider);
  let upstreamCalls = 0;
  let upstreamRequest: Record<string, unknown> | undefined;
  const restore = stubFetch((_input, init) => {
    upstreamCalls++;
    upstreamRequest = JSON.parse(String(init?.body)) as Record<string, unknown>;
    return Promise.resolve(
      streamResponse([
        'data: {"choices":[{"delta":{"content":"hello"}}]}\n\n',
        'data: {"choices":[],"usage":{"prompt_tokens":4,"completion_tokens":3,"total_tokens":7}}\n\n',
        "data: [DONE]\n\n",
      ]),
    );
  });
  try {
    const app = createLlmRouter({
      config: testConfig,
      db,
      redis: new FakeRedis(),
      resolveDns: publicDns,
    });
    const token = await makeToken(testConfig);
    const response = await requestChat(app, token, {
      model: "deepseek-chat",
      messages: [{ role: "user", content: "hello" }],
      stream: true,
    });
    const body = await response.text();

    assertEquals(response.status, 200);
    assert(body.includes("hello"));
    assertEquals(upstreamCalls, 1);
    assertEquals(
      (upstreamRequest?.stream_options as Record<string, unknown>)
        .include_usage,
      true,
    );
    assertEquals(usageInserts.length, 1);
    assertEquals(usageInserts[0]?.status, "ok");
    assertEquals(usageInserts[0]?.billed_total_tokens, 7);
    assertEquals([...ledger.values()][0]?.state, "settled");
  } finally {
    restore();
  }
});

Deno.test("stream accounting: 客户端中断标记 unknown 且不重发上游", async () => {
  const provider = await makeProvider(testConfig.storeKey);
  const { db, usageInserts, ledger } = createFakeDb(provider);
  let upstreamCalls = 0;
  const restore = stubFetch(() => {
    upstreamCalls++;
    return Promise.resolve(
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(
              encoder.encode(
                'data: {"choices":[{"delta":{"content":"partial"}}]}\n\n',
              ),
            );
          },
        }),
        { status: 200, headers: { "content-type": "text/event-stream" } },
      ),
    );
  });
  try {
    const app = createLlmRouter({
      config: testConfig,
      db,
      redis: new FakeRedis(),
      resolveDns: publicDns,
    });
    const token = await makeToken(testConfig);
    const response = await requestChat(app, token, {
      model: "deepseek-chat",
      messages: [{ role: "user", content: "partial" }],
      stream: true,
    });
    const reader = response.body!.getReader();
    await reader.read();
    await reader.cancel("test_client_closed");
    await waitUntil(
      () => usageInserts.length === 1,
      "客户端中断后应写入 unknown 审计",
    );

    assertEquals(upstreamCalls, 1);
    assertEquals(usageInserts[0]?.status, "error");
    assertEquals(usageInserts[0]?.error_code, "client_closed_stream");
    assertEquals([...ledger.values()][0]?.state, "unknown");
  } finally {
    restore();
  }
});

Deno.test("stream accounting: 上游无 body 标记 unknown 且不重发上游", async () => {
  const provider = await makeProvider(testConfig.storeKey);
  const { db, usageInserts, ledger } = createFakeDb(provider);
  let upstreamCalls = 0;
  const restore = stubFetch(() => {
    upstreamCalls++;
    return Promise.resolve(
      new Response(null, {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      }),
    );
  });
  try {
    const app = createLlmRouter({
      config: testConfig,
      db,
      redis: new FakeRedis(),
      resolveDns: publicDns,
    });
    const token = await makeToken(testConfig);
    const response = await requestChat(app, token, {
      model: "deepseek-chat",
      messages: [{ role: "user", content: "empty" }],
      stream: true,
    });
    await response.arrayBuffer();
    await waitUntil(
      () => usageInserts.length === 1,
      "上游无 body 后应写入 unknown 审计",
    );

    assertEquals(upstreamCalls, 1);
    assertEquals(usageInserts[0]?.error_code, "stream_body_missing");
    assertEquals([...ledger.values()][0]?.state, "unknown");
  } finally {
    restore();
  }
});

Deno.test("stream accounting: 上游中断标记 unknown 且不自动重发", async () => {
  const provider = await makeProvider(testConfig.storeKey);
  const { db, usageInserts, ledger } = createFakeDb(provider);
  let upstreamCalls = 0;
  const restore = stubFetch(() => {
    upstreamCalls++;
    return Promise.resolve(
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(
              encoder.encode(
                'data: {"choices":[{"delta":{"content":"partial"}}]}\n\n',
              ),
            );
            setTimeout(
              () => controller.error(new Error("upstream_closed")),
              10,
            );
          },
        }),
        { status: 200, headers: { "content-type": "text/event-stream" } },
      ),
    );
  });
  try {
    const app = createLlmRouter({
      config: testConfig,
      db,
      redis: new FakeRedis(),
      resolveDns: publicDns,
    });
    const token = await makeToken(testConfig);
    const response = await requestChat(app, token, {
      model: "deepseek-chat",
      messages: [{ role: "user", content: "partial" }],
      stream: true,
    });
    const reader = response.body!.getReader();
    await reader.read();
    await assertRejects(() => reader.read(), Error);
    await waitUntil(
      () => usageInserts.length === 1,
      "上游中断后应写入 unknown 审计",
    );

    assertEquals(upstreamCalls, 1);
    assertEquals(usageInserts[0]?.error_code, "upstream_stream_error");
    assertEquals([...ledger.values()][0]?.state, "unknown");
  } finally {
    restore();
  }
});
