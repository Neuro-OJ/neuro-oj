// 路由测试共享辅助：fake Redis / fake Db / 测试配置 / fetch stub。
import type { Db } from "../src/db.ts";
import type { GatewayConfig } from "../src/config.ts";
import type { ProviderRow } from "../src/providers.ts";
import type { RedisClient } from "../src/redis.ts";
import {
  encryptSecret,
  type EvalTokenPayload,
  mintEvalToken,
} from "../src/crypto.ts";
import { createLlmRouter } from "../src/routes/llm.ts";

export class FakeRedis implements RedisClient {
  evalResults: string[] = [];

  incr(): Promise<number> {
    return Promise.resolve(1);
  }

  incrby(): Promise<number> {
    return Promise.resolve(1);
  }

  expire(): Promise<number> {
    return Promise.resolve(1);
  }

  get(): Promise<string | null> {
    return Promise.resolve(null);
  }

  ping(): Promise<string> {
    return Promise.resolve("PONG");
  }

  set(): Promise<unknown> {
    return Promise.resolve("OK");
  }

  sadd(): Promise<number> {
    return Promise.resolve(0);
  }

  scard(): Promise<number> {
    return Promise.resolve(0);
  }

  eval(): Promise<unknown> {
    return Promise.resolve(this.evalResults.shift() ?? "ok");
  }
}

export function createFakeDb(provider: ProviderRow | null): {
  db: Db;
  usageInserts: Record<string, unknown>[];
} {
  const usageInserts: Record<string, unknown>[] = [];
  const db = ((
    strings: TemplateStringsArray,
    ...values: unknown[]
  ) => {
    const sql = strings.join("?");
    if (sql.includes("FROM llm_providers")) {
      return Promise.resolve(provider ? [provider] : []);
    }
    if (sql.includes("FROM llm_quotas")) {
      return Promise.resolve([]);
    }
    if (sql.includes("INSERT INTO llm_usage")) {
      const cols = [
        "id",
        "submission_id",
        "problem_id",
        "user_id",
        "provider_id",
        "model",
        "request_messages",
        "request_params",
        "prompt_tokens",
        "completion_tokens",
        "total_tokens",
        "cached_prompt_tokens",
        "billed_prompt_tokens",
        "billed_total_tokens",
        "estimated_cost",
        "latency_ms",
        "status",
        "error_code",
        "prompt_hash",
        "created_at",
      ];
      const row: Record<string, unknown> = {};
      for (let i = 0; i < cols.length; i++) {
        row[cols[i]] = values[i];
      }
      usageInserts.push(row);
      return Promise.resolve([]);
    }
    return Promise.resolve([]);
  }) as unknown as Db;
  (db as unknown as { unsafe: unknown }).unsafe = () => Promise.resolve([]);
  return { db, usageInserts };
}

export async function makeProvider(storeKey: string): Promise<ProviderRow> {
  return {
    id: "prov-1",
    name: "test",
    base_url: "https://api.openai.com/v1",
    model: "deepseek-chat",
    cost_per_1k_tokens: 1,
    encrypted_api_key: await encryptSecret("sk-test", storeKey),
    enabled: true,
    created_by: "0",
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };
}

export const testConfig: GatewayConfig = {
  port: 8001,
  userRateLimitPerMinute: 60,
  ipRateLimitPerMinute: 60,
  serviceToken: "test-service-token-0123456789",
  storeKey: "test-store-key-0123456789",
  databaseUrl: "postgres://fake",
  redisUrl: "redis://fake",
};

export async function makeToken(
  config: GatewayConfig = testConfig,
  model = "deepseek-chat",
): Promise<string> {
  const payload: EvalTokenPayload = {
    jti: crypto.randomUUID(),
    submission_id: "sub-1",
    problem_id: "prob-1",
    user_id: "user-1",
    provider_id: "prov-1",
    allowed_models: [model],
    iat: Math.floor(Date.now() / 1000) - 10,
    exp: Math.floor(Date.now() / 1000) + 3600,
    max_calls: 10,
    max_tokens: 1000,
  };
  return await mintEvalToken(payload, config.serviceToken);
}

export async function requestChat(
  app: ReturnType<typeof createLlmRouter>,
  token: string,
  body: unknown,
): Promise<Response> {
  return await app.request("/v1/chat/completions", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
}

export function stubFetch(
  impl: (
    input: string | URL | Request,
    init?: RequestInit,
  ) => Promise<Response>,
): () => void {
  const original = globalThis.fetch;
  // deno-lint-ignore no-explicit-any
  (globalThis as any).fetch = impl;
  return () => {
    // deno-lint-ignore no-explicit-any
    (globalThis as any).fetch = original;
  };
}
