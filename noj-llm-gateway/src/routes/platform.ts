/**
 * 平台身份模型调用（`POST /internal/platform-completions`）与按用途用量查询
 * （`GET /internal/platform-usage`）。
 *
 * 与 `/v1/chat/completions` 的差异：
 * - 调用方是 core（服务间 Bearer Token），**不签发 eval_token**，因此不受
 *   eval_token 的调用/额度约束，也不会与学生评测额度混用；
 * - 输出必须显式给出 `max_tokens` 且有上限（防止 misconfig 造成高额输出）；
 * - `purpose` 白名单决定可调用的业务场景，用量以
 *   `principal_type='platform'`、`principal_id=<purpose>` 记账，成本按
 *   `billed_total_tokens` 与当前 Provider 单价估算（单价变化会反映在后续记录上）。
 *
 * Provider Key 仍只存在于网关；core 只拿到模型输出与用量。
 */
import { Hono } from "hono";
import type { Db } from "../db.ts";
import type { RedisClient } from "../redis.ts";
import type { GatewayConfig } from "../config.ts";
import { requireServiceToken } from "../auth.ts";
import { recordPlatformUsage } from "../usage.ts";
import { getProviderSecret } from "../providers.ts";
import {
  ModelAuthorityError,
  resolveDomainModelAlias,
} from "../model-authority.ts";
import {
  acquireProviderSlot,
  ProviderQueueAbortedError,
  ProviderQueueTimeoutError,
  type ProviderSlot,
} from "../provider-throttle.ts";
import { calcBilledUsage, type UpstreamUsage } from "../billing.ts";
import { inc } from "../metrics.ts";
import { logger } from "../logger.ts";
import {
  fetchPinned,
  type ResolveFn,
  resolvePublicUpstream,
  UPSTREAM_BLOCKED,
} from "../upstream-guard.ts";
import {
  buildChatUrl,
  estimateCost,
  estimateTokens,
  MAX_UPSTREAM_BODY_BYTES,
  readUpstreamBodyWithLimit,
} from "./llm.ts";

/** 平台调用用途白名单（第一版仅知识图谱打标）。 */
export const PLATFORM_PURPOSES = ["knowledge.tag"] as const;
export type PlatformPurpose = typeof PLATFORM_PURPOSES[number];

/** 知识图谱打标模型别名（运维文档约定）。 */
export const KNOWLEDGE_TAG_MODEL_ALIAS = "platform.tagger";

/** 平台调用允许的最大输出 token（上限，防止误配置导致高额输出）。 */
export const PLATFORM_MAX_OUTPUT_TOKENS = 1024;

/** 平台调用上游超时（毫秒）。 */
const PLATFORM_UPSTREAM_TIMEOUT_MS = 60_000;

export interface PlatformDeps {
  config: GatewayConfig;
  db: Db;
  redis: RedisClient;
  /** DNS 解析（测试注入）；缺省使用 Deno.resolveDns。 */
  resolveDns?: ResolveFn;
}

/** 平台调用的结构化错误码（core 据此区分未配置 / 限流 / 上游故障）。 */
export type PlatformCompletionErrorCode =
  | "invalid_request"
  | "invalid_purpose"
  | "invalid_model_alias"
  | "invalid_max_tokens"
  | "invalid_messages"
  | "MODEL_ALIAS_NOT_CONFIGURED"
  | "PROVIDER_NOT_FOUND"
  | "UPSTREAM_BLOCKED"
  /** 网关 Provider 排队超时（RPM/TPM 保护）。 */
  | "PROVIDER_RATE_LIMITED"
  /** 上游自身限流（429）。 */
  | "RATE_LIMITED"
  | "UPSTREAM_TIMEOUT"
  | "UPSTREAM_ERROR"
  | "upstream_response_too_large"
  | "client_closed_request";

interface PlatformCompletionBody {
  purpose?: unknown;
  model_alias?: unknown;
  messages?: unknown;
  max_tokens?: unknown;
  temperature?: unknown;
  response_format?: unknown;
}

/** 校验必填的 `max_tokens`：正整数且不超过上限。 */
function parseMaxTokens(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    return null;
  }
  if (value > PLATFORM_MAX_OUTPUT_TOKENS) return null;
  return value;
}

/** 估算单次调用的成本（与评测路径使用同一单价与取整规则）。 */
function usageCost(billedTokens: number, costPer1k: number): number {
  return estimateCost(billedTokens, costPer1k);
}

/** 创建平台身份调用与按用途用量查询路由；鉴权复用服务间 Bearer Token。 */
export function createPlatformRouter(deps: PlatformDeps): Hono {
  const app = new Hono();

  // 与其它 /internal/* 完全相同的鉴权中间件（core 的 NOJ_LLM_SERVICE_TOKEN）。
  app.use("*", requireServiceToken(deps.config.serviceToken));
  // 使用域只来自 core 注入的受信任头；缺省映射固定默认域。
  const domain = (c: { req: { header(name: string): string | undefined } }) =>
    c.req.header("X-Noj-Domain-Id") ?? "00000000-0000-4000-8000-000000000001";

  app.post("/internal/platform-completions", async (c) => {
    const domainId = domain(c);
    const requestId = crypto.randomUUID();
    c.header("X-Noj-Request-Id", requestId);

    const body = await c.req.json<PlatformCompletionBody>().catch(() => null);
    if (!body || typeof body !== "object") {
      return c.json({ error: "invalid_request", request_id: requestId }, 400);
    }
    const purpose = typeof body.purpose === "string" ? body.purpose : "";
    if (!(PLATFORM_PURPOSES as readonly string[]).includes(purpose)) {
      return c.json({ error: "invalid_purpose", request_id: requestId }, 400);
    }
    const alias = typeof body.model_alias === "string"
      ? body.model_alias.trim()
      : "";
    if (!alias) {
      return c.json(
        { error: "invalid_model_alias", request_id: requestId },
        400,
      );
    }
    if (!Array.isArray(body.messages) || body.messages.length === 0) {
      return c.json({ error: "invalid_messages", request_id: requestId }, 400);
    }
    const maxTokens = parseMaxTokens(body.max_tokens);
    if (maxTokens === null) {
      return c.json({
        error: "invalid_max_tokens",
        limit: PLATFORM_MAX_OUTPUT_TOKENS,
        request_id: requestId,
      }, 400);
    }
    if (
      body.temperature !== undefined &&
      (typeof body.temperature !== "number" ||
        !Number.isFinite(body.temperature) || body.temperature < 0 ||
        body.temperature > 2)
    ) {
      return c.json({ error: "invalid_request", request_id: requestId }, 400);
    }
    if (
      body.response_format !== undefined &&
      (body.response_format === null ||
        typeof body.response_format !== "object")
    ) {
      return c.json({ error: "invalid_request", request_id: requestId }, 400);
    }

    let selection;
    try {
      selection = await resolveDomainModelAlias(deps.db, domainId, alias);
    } catch (error) {
      if (!(error instanceof ModelAuthorityError)) throw error;
      return c.json(
        { error: error.code, request_id: requestId },
        error.status as 400 | 404,
      );
    }

    let providerSecret;
    try {
      providerSecret = await getProviderSecret(
        deps.db,
        selection.provider_id,
        deps.config.storeKey,
        domainId,
      );
    } catch {
      return c.json({
        error: "PROVIDER_NOT_FOUND" as const,
        request_id: requestId,
      }, 404);
    }
    if (!providerSecret.provider.enabled) {
      return c.json({
        error: "PROVIDER_NOT_FOUND" as const,
        request_id: requestId,
      }, 404);
    }

    // 出站目标校验：与评测路径一致，内网地址仅在 NOJ_LLM_UPSTREAM_ALLOWED_HOSTS 白名单内放行。
    let upstreamResolution: Awaited<ReturnType<typeof resolvePublicUpstream>>;
    try {
      upstreamResolution = await resolvePublicUpstream(
        providerSecret.provider.base_url,
        deps.config.upstreamAllowedHosts,
        deps.resolveDns,
      );
    } catch {
      inc("noj_llm_provider_errors_total");
      logger.warn(
        "平台调用上游地址被出站校验拦截: provider={provider_id} purpose={purpose}",
        { provider_id: selection.provider_id, purpose },
      );
      return c.json({ error: UPSTREAM_BLOCKED, request_id: requestId }, 502);
    }

    const startedAt = Date.now();
    const prompt_tokens = estimateTokens(body.messages);

    // Provider RPM/TPM 排队（多副本共享 Redis），超限排队超时返回 429。
    let providerSlot: ProviderSlot;
    try {
      providerSlot = await acquireProviderSlot(deps.redis, {
        providerId: selection.provider_id,
        rpmLimit: providerSecret.provider.rpm_limit ?? 0,
        tpmLimit: providerSecret.provider.tpm_limit ?? 0,
        tokens: prompt_tokens + maxTokens,
        timeoutMs: deps.config.providerQueueTimeoutMs,
        signal: c.req.raw.signal,
      });
    } catch (err) {
      if (err instanceof ProviderQueueAbortedError) {
        // 499 不是 Hono 的 ContentfulStatusCode，走原生 Response。
        return new Response(
          JSON.stringify({
            error: "client_closed_request",
            request_id: requestId,
          }),
          { status: 499, headers: { "content-type": "application/json" } },
        );
      }
      if (err instanceof ProviderQueueTimeoutError) {
        inc("noj_llm_provider_queue_timeouts_total");
        logger.warn(
          "平台调用 Provider 排队超时: provider={provider_id} purpose={purpose}",
          { provider_id: selection.provider_id, purpose },
        );
        await recordPlatformUsage(deps.db, {
          id: requestId,
          domain_id: domainId,
          provider_id: selection.provider_id,
          model: selection.model,
          purpose,
          alias,
          prompt_tokens,
          completion_tokens: 0,
          cached_tokens: 0,
          estimated_cost: 0,
          latency_ms: Date.now() - startedAt,
          status: "rejected",
          error_code: "PROVIDER_RATE_LIMITED",
          max_tokens: maxTokens,
        }).catch(() => undefined);
        return new Response(
          JSON.stringify({
            error: "PROVIDER_RATE_LIMITED",
            retry_after: err.retryAfterSeconds,
            request_id: requestId,
          }),
          {
            status: 429,
            headers: {
              "content-type": "application/json",
              "retry-after": String(Math.max(1, err.retryAfterSeconds)),
            },
          },
        );
      }
      // Redis 故障时放行（fail-open）：节流只为保护上游。
      providerSlot = {
        waitedMs: 0,
        release: () => Promise.resolve(),
        settle: () => Promise.resolve(),
      };
    }

    // Provider 级 RPM/TPM 只保护上游；平台月度预算由 core 依据
    // `GET /internal/platform-usage` 自行检查（见 GET /internal/platform-usage）。

    const upstreamUrl = buildChatUrl(providerSecret.provider.base_url);
    const upstreamSignal = AbortSignal.any([
      c.req.raw.signal,
      AbortSignal.timeout(PLATFORM_UPSTREAM_TIMEOUT_MS),
    ]);
    const upstreamBody = {
      model: selection.model,
      messages: body.messages,
      max_tokens: maxTokens,
      ...(body.temperature === undefined
        ? {}
        : { temperature: body.temperature }),
      ...(body.response_format === undefined
        ? {}
        : { response_format: body.response_format }),
    };
    let upstreamRes: Response;
    try {
      upstreamRes = await fetchPinned(upstreamUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${providerSecret.apiKey}`,
        },
        body: JSON.stringify(upstreamBody),
        signal: upstreamSignal,
      }, upstreamResolution);
    } catch {
      await providerSlot.release().catch(() => undefined);
      inc("noj_llm_provider_errors_total");
      const errorCode: PlatformCompletionErrorCode = c.req.raw.signal.aborted
        ? "client_closed_request"
        : upstreamSignal.aborted
        ? "UPSTREAM_TIMEOUT"
        : "UPSTREAM_ERROR";
      logger.warn(
        "平台调用上游失败: provider={provider_id} purpose={purpose} error={error_code}",
        { provider_id: selection.provider_id, purpose, error_code: errorCode },
      );
      await recordPlatformUsage(deps.db, {
        id: requestId,
        domain_id: domainId,
        provider_id: selection.provider_id,
        model: selection.model,
        purpose,
        prompt_tokens,
        completion_tokens: 0,
        cached_tokens: 0,
        estimated_cost: 0,
        latency_ms: Date.now() - startedAt,
        status: "error",
        error_code: errorCode,
        alias,
        max_tokens: maxTokens,
      }).catch(() => undefined);
      // 499 不是 Hono 的 ContentfulStatusCode，走原生 Response。
      const status = errorCode === "client_closed_request"
        ? 499
        : errorCode === "UPSTREAM_TIMEOUT"
        ? 504
        : 502;
      return new Response(
        JSON.stringify({ error: errorCode, request_id: requestId }),
        { status, headers: { "content-type": "application/json" } },
      );
    }

    let upstreamText: string;
    try {
      upstreamText = await readUpstreamBodyWithLimit(
        upstreamRes,
        MAX_UPSTREAM_BODY_BYTES,
      );
    } catch (readErr) {
      await providerSlot.release().catch(() => undefined);
      inc("noj_llm_provider_errors_total");
      const errorCode = readErr instanceof Error &&
          readErr.message === "upstream_response_too_large"
        ? "upstream_response_too_large" as const
        : "UPSTREAM_ERROR" as const;
      await recordPlatformUsage(deps.db, {
        id: requestId,
        domain_id: domainId,
        provider_id: selection.provider_id,
        model: selection.model,
        purpose,
        prompt_tokens,
        completion_tokens: 0,
        cached_tokens: 0,
        estimated_cost: 0,
        latency_ms: Date.now() - startedAt,
        status: "error",
        error_code: errorCode,
        alias,
        max_tokens: maxTokens,
      }).catch(() => undefined);
      return c.json({ error: errorCode, request_id: requestId }, 502);
    }

    const parsed = (() => {
      try {
        return JSON.parse(upstreamText) as Record<string, unknown>;
      } catch {
        return null;
      }
    })();
    const usage = parsed?.usage as UpstreamUsage | undefined;
    const billed = calcBilledUsage(usage, prompt_tokens, 0);
    inc("noj_llm_tokens_total", {}, billed.billedTotalTokens);
    if (usage) {
      await providerSlot.settle(billed.totalTokens).catch(() => undefined);
    } else {
      await providerSlot.release().catch(() => undefined);
    }
    const cost = usageCost(
      billed.billedTotalTokens,
      providerSecret.provider.cost_per_1k_tokens,
    );
    const latencyMs = Date.now() - startedAt;

    if (!upstreamRes.ok) {
      inc("noj_llm_provider_errors_total");
      const upstreamStatus = upstreamRes.status;
      const errorCode: PlatformCompletionErrorCode = upstreamStatus === 429
        ? "RATE_LIMITED"
        : "UPSTREAM_ERROR";
      await recordPlatformUsage(deps.db, {
        id: requestId,
        domain_id: domainId,
        provider_id: selection.provider_id,
        model: selection.model,
        purpose,
        prompt_tokens: billed.promptTokens,
        completion_tokens: billed.completionTokens,
        cached_tokens: billed.cachedPromptTokens,
        estimated_cost: cost,
        latency_ms: latencyMs,
        status: "error",
        error_code: String(upstreamStatus),
        alias,
        max_tokens: maxTokens,
      }).catch(() => undefined);
      logger.warn(
        "平台调用上游返回非 2xx: provider={provider_id} purpose={purpose} status={status}",
        { provider_id: selection.provider_id, purpose, status: upstreamStatus },
      );
      const headers: Record<string, string> = {
        "content-type": "application/json",
      };
      const retryAfter = upstreamRes.headers.get("retry-after");
      if (retryAfter) headers["retry-after"] = retryAfter;
      return new Response(
        JSON.stringify({
          error: errorCode,
          upstream_status: upstreamStatus,
          request_id: requestId,
        }),
        { status: errorCode === "RATE_LIMITED" ? 429 : 502, headers },
      );
    }

    // 提取文本内容：支持字符串 content 与分段数组（部分 OpenAI 兼容实现）。
    const choice = (parsed?.choices as unknown[] | undefined)?.[0] as
      | { message?: { content?: unknown } }
      | undefined;
    const rawContent = choice?.message?.content;
    const content = typeof rawContent === "string"
      ? rawContent
      : Array.isArray(rawContent)
      ? rawContent.map((part) =>
        part && typeof part === "object" &&
          typeof (part as { text?: unknown }).text === "string"
          ? (part as { text: string }).text
          : ""
      ).join("")
      : "";
    if (!content) {
      await recordPlatformUsage(deps.db, {
        id: requestId,
        domain_id: domainId,
        provider_id: selection.provider_id,
        model: selection.model,
        purpose,
        prompt_tokens: billed.promptTokens,
        completion_tokens: billed.completionTokens,
        cached_tokens: billed.cachedPromptTokens,
        estimated_cost: cost,
        latency_ms: latencyMs,
        status: "error",
        error_code: "empty_content",
        alias,
        max_tokens: maxTokens,
      }).catch(() => undefined);
      return c.json({ error: "UPSTREAM_ERROR", request_id: requestId }, 502);
    }

    try {
      await recordPlatformUsage(deps.db, {
        id: requestId,
        domain_id: domainId,
        provider_id: selection.provider_id,
        model: selection.model,
        purpose,
        prompt_tokens: billed.promptTokens,
        completion_tokens: billed.completionTokens,
        cached_tokens: billed.cachedPromptTokens,
        estimated_cost: cost,
        latency_ms: latencyMs,
        status: "ok",
        error_code: null,
        alias,
        max_tokens: maxTokens,
      });
    } catch (error) {
      // 记账失败不把已经产生的模型输出丢掉，但明确告知调用方账本可能不完整。
      logger.warn("平台调用记账失败: purpose={purpose} error={error}", {
        purpose,
        error: error instanceof Error ? error.message : String(error),
      });
    }

    return c.json({
      content,
      model: selection.model,
      usage: {
        input_tokens: billed.promptTokens,
        output_tokens: billed.completionTokens,
        cached_input_tokens: billed.cachedPromptTokens,
      },
      cost,
      request_id: requestId,
    });
  });

  app.get("/internal/platform-usage", async (c) => {
    const domainId = domain(c);
    const purpose = c.req.query("purpose") ?? "";
    if (!(PLATFORM_PURPOSES as readonly string[]).includes(purpose)) {
      return c.json({ error: "invalid_purpose" }, 400);
    }
    const sinceRaw = c.req.query("since");
    if (!sinceRaw) return c.json({ error: "since_required" }, 400);
    const since = new Date(sinceRaw);
    if (Number.isNaN(since.getTime())) {
      return c.json({ error: "invalid_since" }, 400);
    }
    const rows = await deps.db<{
      input_tokens: string | number;
      output_tokens: string | number;
      requests: string | number;
      cost: string | number;
    }[]>`
      SELECT coalesce(sum(prompt_tokens), 0)::text AS input_tokens,
        coalesce(sum(completion_tokens), 0)::text AS output_tokens,
        count(*)::text AS requests,
        coalesce(sum(estimated_cost), 0)::text AS cost
      FROM llm_usage
      WHERE domain_id=${domainId} AND principal_type='platform'
        AND principal_id=${purpose} AND created_at >= ${since.toISOString()}
    `;
    const row = rows[0];
    return c.json({
      purpose,
      since: since.toISOString(),
      input_tokens: Number(row?.input_tokens ?? 0),
      output_tokens: Number(row?.output_tokens ?? 0),
      requests: Number(row?.requests ?? 0),
      cost: Number(row?.cost ?? 0),
    });
  });

  return app;
}
