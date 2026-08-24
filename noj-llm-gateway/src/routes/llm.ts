/**
 * OpenAI 兼容代理端点。
 */
import { Hono } from "hono";
import type { Db } from "../db.ts";
import type { RedisClient } from "../redis.ts";
import type { GatewayConfig } from "../config.ts";
import { verifyEvalToken } from "../crypto.ts";
import { getProviderSecret } from "../providers.ts";
import { enforceAndCount } from "../limits.ts";
import { recordUsage } from "../usage.ts";

export interface LlmDeps {
  config: GatewayConfig;
  db: Db;
  redis: RedisClient;
}

interface ChatCompletionRequest {
  model?: string;
  messages?: unknown[];
  max_tokens?: number;
  temperature?: number;
  top_p?: number;
  [key: string]: unknown;
}

function buildChatUrl(baseUrl: string): string {
  const base = baseUrl.replace(/\/+$/, "");
  if (base.endsWith("/chat/completions")) return base;
  if (base.endsWith("/v1")) return `${base}/chat/completions`;
  return `${base}/v1/chat/completions`;
}

async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(input),
  );
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export function createLlmRouter(deps: LlmDeps): Hono {
  const app = new Hono();

  app.post("/v1/chat/completions", async (c) => {
    const auth = c.req.header("Authorization") ?? "";
    const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
    if (!token) {
      return c.json({ error: "missing_token" }, 401);
    }

    let payload;
    try {
      payload = await verifyEvalToken(token, deps.config.serviceToken);
    } catch {
      return c.json({ error: "invalid_token" }, 401);
    }

    const body = await c.req.json<ChatCompletionRequest>().catch(() => null);
    if (!body || !Array.isArray(body.messages)) {
      return c.json({ error: "invalid_request" }, 400);
    }
    const model = body.model ?? "";
    if (!payload.allowed_models.includes(model)) {
      return c.json({ error: "model_not_allowed" }, 403);
    }

    let providerSecret;
    try {
      providerSecret = await getProviderSecret(
        deps.db,
        payload.provider_id,
        deps.config.storeKey,
      );
    } catch {
      return c.json({ error: "provider_not_found" }, 400);
    }
    if (!providerSecret.provider.enabled) {
      return c.json({ error: "provider_disabled" }, 403);
    }

    const ttlSeconds = Math.max(
      60,
      Math.floor((payload.exp - payload.iat) * 1) ?? 3600,
    );
    const startedAt = Date.now();
    const promptTokens = estimateTokens(body.messages);
    const completionTokens = 0;
    const estimatedCost = 0;

    try {
      await enforceAndCount(deps.db, deps.redis, payload, {
        model,
        promptTokens,
        completionTokens,
        estimatedCost,
        ip: c.req.header("x-forwarded-for") ?? "unknown",
        ttlSeconds,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : "limit_exceeded";
      await recordUsage(deps.db, {
        id: crypto.randomUUID(),
        submission_id: payload.submission_id,
        problem_id: payload.problem_id,
        user_id: payload.user_id,
        provider_id: payload.provider_id,
        model,
        request_messages: body.messages,
        request_params: pickParams(body),
        prompt_tokens: promptTokens,
        completion_tokens: 0,
        total_tokens: promptTokens,
        estimated_cost: 0,
        latency_ms: Date.now() - startedAt,
        status: "rejected",
        error_code: message,
        prompt_hash: await sha256Hex(JSON.stringify(body.messages)),
        created_at: new Date().toISOString(),
      });
      return c.json({ error: message }, 429);
    }

    const upstreamUrl = buildChatUrl(providerSecret.provider.base_url);
    let upstreamRes: Response;
    try {
      upstreamRes = await fetch(upstreamUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${providerSecret.apiKey}`,
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(120_000),
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : "upstream_error";
      await recordUsage(deps.db, {
        id: crypto.randomUUID(),
        submission_id: payload.submission_id,
        problem_id: payload.problem_id,
        user_id: payload.user_id,
        provider_id: payload.provider_id,
        model,
        request_messages: body.messages,
        request_params: pickParams(body),
        prompt_tokens: promptTokens,
        completion_tokens: 0,
        total_tokens: promptTokens,
        estimated_cost: 0,
        latency_ms: Date.now() - startedAt,
        status: "error",
        error_code: message,
        prompt_hash: await sha256Hex(JSON.stringify(body.messages)),
        created_at: new Date().toISOString(),
      });
      return c.json({ error: "upstream_error", message }, 502);
    }

    const upstreamBody = await upstreamRes.json().catch(() => null);
    const latency = Date.now() - startedAt;
    const usage = upstreamBody?.usage as
      | {
        prompt_tokens?: number;
        completion_tokens?: number;
        total_tokens?: number;
      }
      | undefined;
    const actualPromptTokens = usage?.prompt_tokens ?? promptTokens;
    const actualCompletionTokens = usage?.completion_tokens ?? 0;
    const actualTotalTokens = usage?.total_tokens ??
      (actualPromptTokens + actualCompletionTokens);

    await recordUsage(deps.db, {
      id: crypto.randomUUID(),
      submission_id: payload.submission_id,
      problem_id: payload.problem_id,
      user_id: payload.user_id,
      provider_id: payload.provider_id,
      model,
      request_messages: body.messages,
      request_params: pickParams(body),
      prompt_tokens: actualPromptTokens,
      completion_tokens: actualCompletionTokens,
      total_tokens: actualTotalTokens,
      estimated_cost: 0,
      latency_ms: latency,
      status: upstreamRes.ok ? "ok" : "error",
      error_code: upstreamRes.ok ? null : String(upstreamRes.status),
      prompt_hash: await sha256Hex(JSON.stringify(body.messages)),
      created_at: new Date().toISOString(),
    });

    if (!upstreamRes.ok) {
      return new Response(
        JSON.stringify({
          error: "upstream_error",
          status: upstreamRes.status,
          body: upstreamBody,
        }),
        {
          status: upstreamRes.status,
          headers: { "content-type": "application/json" },
        },
      );
    }
    return c.json(upstreamBody);
  });

  return app;
}

function estimateTokens(messages: unknown[]): number {
  try {
    return Math.ceil(JSON.stringify(messages).length / 4);
  } catch {
    return 0;
  }
}

function pickParams(body: ChatCompletionRequest): Record<string, unknown> {
  const params: Record<string, unknown> = {};
  for (
    const key of [
      "model",
      "max_tokens",
      "temperature",
      "top_p",
      "top_k",
      "stop",
      "enable_thinking",
    ]
  ) {
    if (body[key] !== undefined) params[key] = body[key];
  }
  return params;
}
