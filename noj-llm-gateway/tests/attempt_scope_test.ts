/**
 * LLM 额度与吊销的**评测尝试**作用域测试（Handbook §6.7）。
 *
 * 版本化后同一提交可以有多条评测尝试（重测/升级）：单次预算、吊销标记与
 * 多来源 IP 监控都必须按 attempt 隔离，否则重测要么撞上旧尝试已耗尽的预算，
 * 要么被旧尝试的吊销标记误杀。用户/题目/全局日/月额度仍跨尝试累计。
 */
import { assertEquals } from "jsr:@std/assert@^1";
import { createLlmRouter } from "../src/routes/llm.ts";
import {
  evalTokenCounterKey,
  evalTokenIpSetKey,
  evalTokenRevokedKey,
  evalTokenScope,
} from "../src/limits.ts";
import type { EvalTokenPayload } from "../src/crypto.ts";
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

function payload(
  override: Partial<EvalTokenPayload>,
): EvalTokenPayload {
  return {
    jti: "jti-1",
    submission_id: "sub-1",
    problem_id: "prob-1",
    user_id: "user-1",
    provider_id: "prov-1",
    allowed_models: ["deepseek-chat"],
    iat: 0,
    exp: 3600,
    max_calls: 10,
    max_tokens: 1000,
    ...override,
  };
}

Deno.test("llm scope: 有 attempt_id 时按尝试隔离计数与吊销键", () => {
  const scoped = payload({
    attempt_id: "att-1",
    problem_version_id: "ver-1",
    protocol_version: 2,
  });
  assertEquals(evalTokenScope(scoped), { kind: "attempt", id: "att-1" });
  assertEquals(
    evalTokenCounterKey(scoped, "calls"),
    "llm:attempt:att-1:calls",
  );
  assertEquals(
    evalTokenCounterKey(scoped, "tokens"),
    "llm:attempt:att-1:tokens",
  );
  assertEquals(evalTokenCounterKey(scoped, "cost"), "llm:attempt:att-1:cost");
  assertEquals(evalTokenRevokedKey(scoped), "llm:attempt:revoked:att-1");
  assertEquals(evalTokenIpSetKey(scoped), "llm:attempt-ips:att-1");

  // 同一提交的另一次尝试是完全独立的预算与吊销命名空间
  const second = payload({ attempt_id: "att-2" });
  assertEquals(
    evalTokenCounterKey(second, "calls"),
    "llm:attempt:att-2:calls",
  );
  assertEquals(
    evalTokenRevokedKey(second) !== evalTokenRevokedKey(scoped),
    true,
  );
});

Deno.test("llm scope: 旧 token（无 attempt_id）沿用提交维度键", () => {
  const legacy = payload({});
  assertEquals(evalTokenScope(legacy), { kind: "submission", id: "sub-1" });
  assertEquals(evalTokenCounterKey(legacy, "calls"), "llm:sub:sub-1:calls");
  assertEquals(evalTokenRevokedKey(legacy), "llm:token:revoked:sub-1");
  assertEquals(evalTokenIpSetKey(legacy), "llm:token-ips:sub-1");
});

Deno.test("llm scope: 新尝试的调用使用尝试维度计数键与审计字段", async () => {
  const provider = await makeProvider(testConfig.storeKey);
  const { db, usageInserts } = createFakeDb(provider);
  const redis = new FakeRedis();
  const app = createLlmRouter({
    config: testConfig,
    db,
    redis,
    resolveDns: publicDns,
  });
  const token = await makeToken(testConfig, "deepseek-chat", {
    attemptId: "att-42",
    problemVersionId: "ver-42",
  });

  const restore = stubFetch(() =>
    Promise.resolve(
      new Response(
        JSON.stringify({
          choices: [{ message: { role: "assistant", content: "pong" } }],
          usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    )
  );
  try {
    const res = await requestChat(app, token, {
      model: "deepseek-chat",
      messages: [{ role: "user", content: "ping" }],
      max_tokens: 5,
    });
    assertEquals(res.status, 200);
  } finally {
    restore();
  }

  // 计数键必须落在 attempt 维度
  const keys = redis.evalKeys.flat();
  assertEquals(keys.includes("llm:attempt:att-42:calls"), true);
  assertEquals(keys.includes("llm:attempt:att-42:tokens"), true);
  assertEquals(
    keys.some((key) => key.startsWith("llm:sub:sub-1:")),
    false,
    "attempt token 不得再走提交维度计数键",
  );

  // 吊销检查读 attempt 键；审计行归属该尝试与版本
  assertEquals(redis.getKeys.includes("llm:attempt:revoked:att-42"), true);
  assertEquals(usageInserts.length, 1);
  assertEquals(usageInserts[0].attempt_id, "att-42");
  assertEquals(usageInserts[0].problem_version_id, "ver-42");
  assertEquals(usageInserts[0].submission_id, "sub-1");
});

Deno.test("llm scope: 已吊销的尝试被拒绝，且不影响同提交的新尝试", async () => {
  const provider = await makeProvider(testConfig.storeKey);
  const { db, usageInserts } = createFakeDb(provider);
  const redis = new FakeRedis();
  redis.revoked.add("llm:attempt:revoked:att-old");
  const app = createLlmRouter({
    config: testConfig,
    db,
    redis,
    resolveDns: publicDns,
  });

  const oldToken = await makeToken(testConfig, "deepseek-chat", {
    attemptId: "att-old",
  });
  const oldRes = await requestChat(app, oldToken, {
    model: "deepseek-chat",
    messages: [{ role: "user", content: "ping" }],
  });
  assertEquals(oldRes.status, 401);
  assertEquals((await oldRes.json()).error, "token_revoked");
  assertEquals(usageInserts.length, 0);

  // 同一提交的新尝试未被旧吊销标记影响（重测可正常评测）
  const newToken = await makeToken(testConfig, "deepseek-chat", {
    attemptId: "att-new",
  });
  const restore = stubFetch(() =>
    Promise.resolve(
      new Response(
        JSON.stringify({
          choices: [{ message: { role: "assistant", content: "pong" } }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    )
  );
  try {
    const newRes = await requestChat(app, newToken, {
      model: "deepseek-chat",
      messages: [{ role: "user", content: "ping" }],
    });
    assertEquals(newRes.status, 200);
    assertEquals(redis.getKeys.includes("llm:attempt:revoked:att-new"), true);
  } finally {
    restore();
  }
});

Deno.test("llm scope: 旧 token 的吊销仍读提交维度键", async () => {
  const provider = await makeProvider(testConfig.storeKey);
  const { db } = createFakeDb(provider);
  const redis = new FakeRedis();
  redis.revoked.add("llm:token:revoked:sub-1");
  const app = createLlmRouter({
    config: testConfig,
    db,
    redis,
    resolveDns: publicDns,
  });
  const token = await makeToken(testConfig);
  const res = await requestChat(app, token, {
    model: "deepseek-chat",
    messages: [{ role: "user", content: "ping" }],
  });
  assertEquals(res.status, 401);
  assertEquals((await res.json()).error, "token_revoked");
});
