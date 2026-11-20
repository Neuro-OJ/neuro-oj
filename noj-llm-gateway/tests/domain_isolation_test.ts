import { assertEquals, assertRejects } from "jsr:@std/assert@^1";
import {
  type EvalTokenPayload,
  mintEvalToken,
  verifyEvalToken,
} from "../src/crypto.ts";
import { createLlmRouter } from "../src/routes/llm.ts";
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

Deno.test("域 LLM：拒绝缺少 domain 的旧协议及无尝试 token", async () => {
  const payload = {
    jti: "token",
    submission_id: "sub",
    problem_id: "source",
    user_id: "student",
    provider_id: "provider",
    allowed_models: ["school-model"],
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + 60,
    max_calls: 3,
    max_tokens: 100,
  };
  for (
    const scope of [{ protocol_version: 2, attempt_id: "a" }, {
      protocol_version: 3,
      attempt_id: "a",
    }, { protocol_version: 3, domain_id: "school" }]
  ) {
    const token = await mintEvalToken(
      { ...payload, ...scope } as unknown as EvalTokenPayload,
      testConfig.serviceToken,
    );
    await assertRejects(() => verifyEvalToken(token, testConfig.serviceToken));
  }
});

Deno.test("域 LLM：伪造使用域无法调用其他域 Provider，不扣预算不触碰上游", async () => {
  const provider = await makeProvider(testConfig.storeKey);
  const { db, usageInserts } = createFakeDb(provider);
  const redis = new FakeRedis();
  const app = createLlmRouter({
    config: testConfig,
    db,
    redis,
    resolveDns: publicDns,
  });
  let calls = 0;
  const restore = stubFetch(() => {
    calls++;
    return Promise.resolve(new Response("{}"));
  });
  try {
    const token = await makeToken(testConfig, "deepseek-chat", {
      domainId: "other-school",
      attemptId: "a",
    });
    const response = await requestChat(app, token, {
      model: "deepseek-chat",
      messages: [],
    });
    assertEquals(response.status, 400);
    assertEquals((await response.json()).error, "provider_not_found");
    assertEquals(calls, 0);
    assertEquals(redis.evalKeys.length, 0);
    assertEquals(usageInserts.length, 0);
  } finally {
    restore();
  }
});

Deno.test("域 LLM：源题共用时用量记录只归使用域与冻结模型", async () => {
  const provider = await makeProvider(testConfig.storeKey);
  provider.domain_id = "school-b";
  const { db, usageInserts } = createFakeDb(provider);
  const redis = new FakeRedis();
  const app = createLlmRouter({
    config: testConfig,
    db,
    redis,
    resolveDns: publicDns,
  });
  const restore = stubFetch(() =>
    Promise.resolve(
      new Response(
        JSON.stringify({
          choices: [],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        }),
        { headers: { "content-type": "application/json" } },
      ),
    )
  );
  try {
    const token = await makeToken(testConfig, "school-b-model", {
      domainId: "school-b",
      attemptId: "b",
    });
    const response = await requestChat(app, token, {
      model: "school-b-model",
      messages: [],
    });
    assertEquals(response.status, 200);
    assertEquals(usageInserts[0].domain_id, "school-b");
    assertEquals(usageInserts[0].model, "school-b-model");
    assertEquals(
      redis.evalKeys.flat().filter((key) => key.includes("user:user-1")).every((
        key,
      ) => key.includes("school-b")),
      true,
    );
  } finally {
    restore();
  }
});
