// LLM 回放测试：无 key 可跑，验证录制 fixture 的结构与内容，并可用 fixture 驱动代理路由。

import { assertEquals } from "jsr:@std/assert@^1";
import { createLlmRouter } from "../src/routes/llm.ts";
import {
  createFakeDb,
  FakeRedis,
  makeProvider,
  makeToken,
  requestChat,
  stubFetch,
  testConfig,
} from "./helpers.ts";

const FIXTURE_DIR = new URL("./replay/fixtures/", import.meta.url).pathname;

interface ReplayFixture {
  model: string;
  request: {
    messages: { role: string; content: string }[];
    max_tokens?: number;
  };
  response: {
    choices: { message: { role: string; content: string } }[];
    usage?: {
      prompt_tokens?: number;
      completion_tokens?: number;
      total_tokens?: number;
      prompt_tokens_details?: { cached_tokens?: number };
    };
  };
  upstream_status?: number;
  malformed?: boolean;
}

async function readFixture(name: string): Promise<ReplayFixture> {
  return JSON.parse(
    await Deno.readTextFile(`${FIXTURE_DIR}${name}`),
  ) as ReplayFixture;
}

Deno.test("replay: 多 Provider fixture 结构可读", async () => {
  for (const name of [
    "simple-chat.json",
    "deepseek-chat.json",
    "qwen-plus.json",
    "openai-gpt-4o.json",
    "upstream-500.json",
    "malformed.json",
  ]) {
    const fixture = await readFixture(name);
    assertEquals(typeof fixture.model, "string");
    assertEquals(Array.isArray(fixture.request.messages), true);
    assertEquals(Array.isArray(fixture.response.choices), true);
  }
});

Deno.test("replay: 错误分支 fixture 标记正确", async () => {
  const upstream500 = await readFixture("upstream-500.json");
  assertEquals(upstream500.upstream_status, 500);
  const malformed = await readFixture("malformed.json");
  assertEquals(malformed.malformed, true);
});

Deno.test("replay: simple-chat fixture 可驱动代理路由", async () => {
  const fixture = await readFixture("simple-chat.json");
  const provider = await makeProvider(testConfig.storeKey);
  const { db } = createFakeDb(provider);
  const redis = new FakeRedis();
  const app = createLlmRouter({ config: testConfig, db, redis });
  const token = await makeToken(testConfig, fixture.model);
  const restore = stubFetch(async () => {
    return new Response(JSON.stringify(fixture.response), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  });

  try {
    const res = await requestChat(app, token, {
      model: fixture.model,
      messages: fixture.request.messages,
      max_tokens: fixture.request.max_tokens,
    });
    assertEquals(res.status, 200);
    const body = await res.json();
    assertEquals(body.choices[0].message.content, "pong");
  } finally {
    restore();
  }
});
