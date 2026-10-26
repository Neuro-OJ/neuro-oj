/**
 * OpenAI 兼容代理端点。
 */
import { Hono } from "hono";
import type { Db } from "../db.ts";
import type { RedisClient } from "../redis.ts";
import type { GatewayConfig } from "../config.ts";
import { verifyEvalToken } from "../crypto.ts";
import {
  assertEvalTokenActive,
  EvalTokenAdmissionError,
} from "../revocation.ts";
import { getProviderSecret } from "../providers.ts";
import {
  enforceAndCount,
  evalTokenIpSetKey,
  QuotaLimitError,
} from "../limits.ts";
import {
  persistCallUsage,
  recordUnknownCall,
  settleCall,
} from "../accounting.ts";
import { recordRejectedUsage, recordUsage } from "../usage.ts";
import {
  acquireProviderSlot,
  ProviderQueueAbortedError,
  ProviderQueueTimeoutError,
  type ProviderSlot,
} from "../provider-throttle.ts";
import { calcBilledUsage, type UpstreamUsage } from "../billing.ts";
import { inc, observe } from "../metrics.ts";
import { logger } from "../logger.ts";
import {
  assertResolvesPublic,
  type ResolveFn,
  UPSTREAM_BLOCKED,
} from "../upstream-guard.ts";

export interface LlmDeps {
  config: GatewayConfig;
  db: Db;
  redis: RedisClient;
  /** DNS 解析（测试注入）；缺省使用 Deno.resolveDns。 */
  resolveDns?: ResolveFn;
}

interface ChatCompletionRequest {
  model?: string;
  messages?: unknown[];
  max_tokens?: number;
  temperature?: number;
  top_p?: number;
  [key: string]: unknown;
}

interface StreamingUsageResult {
  remainder: string;
  usage?: UpstreamUsage;
}

const MAX_UPSTREAM_BODY_BYTES = 10 * 1024 * 1024;

/** 流式截断读取上游响应，防止超大流式内容引发 OOM 崩溃（GW-01）。 */
async function readUpstreamBodyWithLimit(
  res: Response,
  maxBytes: number,
): Promise<string> {
  const body = res.body;
  if (!body) return "";
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let text = "";
  let totalBytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      totalBytes += value.byteLength;
      if (totalBytes > maxBytes) {
        await reader.cancel("upstream_response_too_large");
        throw new Error("upstream_response_too_large");
      }
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
    return text;
  } catch (err) {
    try {
      await reader.cancel();
    } catch {
      // ignore
    }
    throw err;
  }
}

/** 根据 Provider base_url 拼接 OpenAI 兼容 Chat Completions 地址。 */
function buildChatUrl(baseUrl: string): string {
  const base = baseUrl.replace(/\/+$/, "");
  if (base.endsWith("/chat/completions")) return base;
  if (base.endsWith("/v1")) return `${base}/chat/completions`;
  return `${base}/v1/chat/completions`;
}

/** 从跨 chunk 的 SSE 文本中提取 OpenAI stream_options.include_usage 结尾块。 */
function extractStreamingUsage(text: string): StreamingUsageResult {
  const lines = text.split(/\r?\n/);
  const remainder = lines.pop() ?? "";
  let usage: UpstreamUsage | undefined;
  for (const line of lines) {
    if (!line.startsWith("data:")) continue;
    const data = line.slice(5).trim();
    if (!data || data === "[DONE]") continue;
    try {
      const parsed = JSON.parse(data) as Record<string, unknown>;
      const candidate = parsed.usage;
      if (candidate && typeof candidate === "object") {
        usage = candidate as UpstreamUsage;
      }
    } catch {
      // 非 JSON 的 SSE 注释/增量内容不影响继续转发；最终 usage 块必须可解析。
    }
  }
  return { remainder, ...(usage ? { usage } : {}) };
}

/** 给流式上游请求补齐最终 usage 选项，但保留调用方其它 stream_options。 */
function prepareUpstreamRequestBody(
  body: ChatCompletionRequest,
): ChatCompletionRequest {
  if (body.stream !== true) return body;
  const options = body.stream_options;
  const streamOptions = options && typeof options === "object"
    ? options as Record<string, unknown>
    : {};
  return {
    ...body,
    stream_options: { ...streamOptions, include_usage: true },
  };
}

/** 计算字符串 SHA-256 的十六进制摘要，用于用量审计的 prompt 哈希。 */
async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(input),
  );
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/** 构造 OpenAI 兼容的超限错误响应，供客户端按 code=out_of_usage 识别。 */
function openAiLimitError(reason: string): Response {
  const rateLimited = reason === "rate_limit_exceeded";
  return new Response(
    JSON.stringify({
      error: {
        message: rateLimited
          ? "Too many requests; retry later"
          : "Out of usage for this evaluation",
        type: "invalid_request_error",
        code: rateLimited ? "rate_limit_exceeded" : "out_of_usage",
      },
    }),
    {
      status: 429,
      headers: {
        "content-type": "application/json",
        ...(rateLimited
          ? { "retry-after": String(61 - Math.floor(Date.now() / 1000) % 60) }
          : {}),
      },
    },
  );
}

/** 构造 Provider 排队超时的 OpenAI 兼容 429 响应（SDK 会按 Retry-After 退避重试）。 */
function providerQueueTimeoutError(retryAfterSeconds: number): Response {
  return new Response(
    JSON.stringify({
      error: {
        message:
          "Provider rate limit reached and the request timed out while queued",
        type: "rate_limit_error",
        code: "provider_queue_timeout",
      },
    }),
    {
      status: 429,
      headers: {
        "content-type": "application/json",
        "retry-after": String(Math.max(1, retryAfterSeconds)),
      },
    },
  );
}

interface StreamingResponseOptions {
  response: Response;
  payload: Awaited<ReturnType<typeof verifyEvalToken>>;
  body: ChatCompletionRequest;
  callId: string;
  startedAt: number;
  promptTokens: number;
  estimatedCost: number;
  costPer1kTokens: number;
  upstreamModel: string;
  aliasForAudit?: string;
  providerSlot: ProviderSlot;
  requestSignal: AbortSignal;
  deps: LlmDeps;
}

/**
 * 转发 SSE 并把“流结束”作为记账完成边界。
 *
 * 上游响应已经建立后，客户端断开、上游读失败或没有最终 usage 都不能证明未计费，
 * 因而只写 unknown，不自动重发上游。只有收到可解析的最终 usage，才持久化实际用量
 * 并尝试幂等结算；结算失败保留 pending，由后台 worker 重试。
 */
async function createStreamingResponse(
  options: StreamingResponseOptions,
): Promise<Response> {
  const {
    response,
    payload,
    body,
    callId,
    startedAt,
    promptTokens,
    estimatedCost,
    costPer1kTokens,
    upstreamModel,
    aliasForAudit,
    providerSlot,
    requestSignal,
    deps,
  } = options;
  const decoder = new TextDecoder();
  let pendingText = "";
  let streamUsage: UpstreamUsage | undefined;
  let closed = false;
  let clientCancelled = false;
  let finalization: Promise<void> | null = null;

  const makeUsageEntry = async (
    status: string,
    errorCode: string | null,
    usage: UpstreamUsage | undefined,
  ) => {
    const billed = calcBilledUsage(usage, promptTokens, 0);
    const actualCost = usage
      ? estimateCost(billed.billedTotalTokens, costPer1kTokens)
      : estimatedCost;
    return {
      id: callId,
      domain_id: payload.domain_id,
      submission_id: payload.submission_id,
      attempt_id: payload.attempt_id ?? null,
      problem_version_id: payload.problem_version_id ?? null,
      problem_id: payload.problem_id,
      user_id: payload.user_id,
      provider_id: payload.provider_id,
      model: upstreamModel,
      request_messages: body.messages,
      request_params: pickParams(body, aliasForAudit),
      prompt_tokens: billed.promptTokens,
      completion_tokens: billed.completionTokens,
      total_tokens: billed.totalTokens,
      cached_prompt_tokens: billed.cachedPromptTokens,
      billed_prompt_tokens: billed.billedPromptTokens,
      billed_total_tokens: billed.billedTotalTokens,
      estimated_cost: actualCost,
      latency_ms: Date.now() - startedAt,
      status,
      error_code: errorCode,
      prompt_hash: await sha256Hex(JSON.stringify(body.messages)),
      created_at: new Date().toISOString(),
    };
  };

  const recordUnknownOutcome = async (errorCode: string): Promise<void> => {
    await recordUnknownCall(deps.db, callId).catch((error) => {
      logger.warn("流式调用标记 unknown 失败: {error}", {
        error: error instanceof Error ? error.message : String(error),
      });
    });
    const entry = await makeUsageEntry("error", errorCode, undefined);
    await recordUsage(deps.db, entry).catch((error) => {
      logger.warn("流式 unknown 审计写入失败: {error}", {
        error: error instanceof Error ? error.message : String(error),
      });
    });
  };

  const reader = response.body?.getReader();
  if (!reader) {
    // 已经拿到上游 HTTP 响应但没有可读 body，仍不能把账本留在“已预占”状态。
    // 这和客户端断开/上游读失败同属无法证明实际用量的 unknown 结果，且绝不重发上游。
    await recordUnknownOutcome("stream_body_missing");
    const headers = new Headers(response.headers);
    headers.delete("content-length");
    headers.set("x-noj-call-id", callId);
    return new Response(null, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  }

  const finalize = (
    usage: UpstreamUsage | undefined,
    unknownReason: string,
  ): Promise<void> => {
    if (finalization) return finalization;
    finalization = (async () => {
      if (!usage) {
        await recordUnknownOutcome(unknownReason);
        return;
      }
      const billed = calcBilledUsage(usage, promptTokens, 0);
      await providerSlot.settle(billed.totalTokens).catch(() => undefined);
      const actualCost = estimateCost(
        billed.billedTotalTokens,
        costPer1kTokens,
      );
      const entry = await makeUsageEntry(
        response.ok ? "ok" : "error",
        response.ok ? null : String(response.status),
        usage,
      );
      try {
        await persistCallUsage(
          deps.db,
          callId,
          entry,
          billed.billedTotalTokens,
          actualCost,
        );
      } catch (error) {
        await recordUnknownOutcome("accounting_persist_failed");
        logger.warn("流式调用实际用量持久化失败: {error}", {
          error: error instanceof Error ? error.message : String(error),
        });
        return;
      }
      try {
        const settled = await settleCall(deps.db, deps.redis, callId);
        if (settled !== "ok") inc("noj_llm_quota_exhausted_total");
      } catch (error) {
        // ledger 已是 pending，不能把已知用量改写成 unknown；worker 会按同一 ID 重放。
        logger.warn("流式调用结算暂挂: {error}", {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    })().catch((error) => {
      logger.warn("流式调用记账失败: {error}", {
        error: error instanceof Error ? error.message : String(error),
      });
    });
    return finalization;
  };

  const onAbort = () => {
    clientCancelled = true;
    void reader.cancel("client_closed_stream").catch(() => undefined);
    void finalize(undefined, "client_closed_stream").then(detachAbort);
  };
  const detachAbort = (): void => {
    requestSignal.removeEventListener("abort", onAbort);
  };
  if (requestSignal.aborted) onAbort();
  else requestSignal.addEventListener("abort", onAbort, { once: true });

  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (closed) return;
      try {
        const result = await reader.read();
        if (result.done) {
          closed = true;
          pendingText += decoder.decode();
          const parsed = extractStreamingUsage(pendingText + "\n");
          if (parsed.usage) streamUsage = parsed.usage;
          await finalize(
            clientCancelled || requestSignal.aborted ? undefined : streamUsage,
            clientCancelled || requestSignal.aborted
              ? "client_closed_stream"
              : "stream_usage_unknown",
          );
          detachAbort();
          controller.close();
          return;
        }
        pendingText += decoder.decode(result.value, { stream: true });
        const parsed = extractStreamingUsage(pendingText);
        pendingText = parsed.remainder;
        if (parsed.usage) streamUsage = parsed.usage;
        controller.enqueue(result.value);
      } catch (error) {
        closed = true;
        await finalize(
          undefined,
          requestSignal.aborted
            ? "client_closed_stream"
            : "upstream_stream_error",
        );
        detachAbort();
        controller.error(error);
      }
    },
    async cancel(reason) {
      closed = true;
      clientCancelled = true;
      await reader.cancel(reason).catch(() => undefined);
      await finalize(undefined, "client_closed_stream");
      detachAbort();
    },
  });
  const headers = new Headers(response.headers);
  headers.delete("content-length");
  headers.set("x-noj-call-id", callId);
  return new Response(stream, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

/** 创建 OpenAI 兼容代理路由：校验 eval_token → 限流 → 转发 → 真实用量结算/审计。 */
export function createLlmRouter(deps: LlmDeps): Hono {
  const app = new Hono();

  // 契约指标：请求计数与耗时覆盖所有进入 chat/completions 的调用（含鉴权失败）。
  app.use("/v1/chat/completions", async (_c, next) => {
    inc("noj_llm_requests_total");
    const startedAt = Date.now();
    try {
      await next();
    } finally {
      observe(
        "noj_llm_request_duration_seconds",
        Math.max(0, Date.now() - startedAt) / 1000,
      );
    }
  });

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

    // 校验 eval_token 是否已被吊销（决策 7 · AR-08 · 单次生命周期绑定）。
    // 版本化后按**评测尝试**吊销：同一提交的重测不受旧尝试吊销影响；
    // 旧 core（token 无 attempt_id）继续读提交维度的旧键。
    try {
      await assertEvalTokenActive(deps.redis, payload);
    } catch (error) {
      if (!(error instanceof EvalTokenAdmissionError)) throw error;
      return c.json(
        { error: error.code },
        error.code === "revocations_unavailable" ? 503 : 401,
      );
    }

    // 监控：同一 submission 的 token 若从多个来源 IP 调用，记录告警（不阻断）。
    const ttlSeconds = Math.max(60, Math.floor(payload.exp - payload.iat));
    const clientIp = c.req.header("x-forwarded-for") ?? "unknown";
    try {
      const ipKey = evalTokenIpSetKey(payload);
      const added = await deps.redis.sadd(ipKey, clientIp);
      if (added === 0) {
        const ipCount = await deps.redis.scard(ipKey);
        if (ipCount > 1) {
          // 走结构化 logger 而非 console.warn：submission_id / client_ip
          // 由统一脱敏层处理（生产截断 *_id、隐藏 client_ip），
          // 手写模板字符串会绕过脱敏把明文 id 与 IP 写进日志文件。
          logger.warn(
            "eval_token 多来源 IP 调用: submission={submission_id} ip={client_ip} ips={ips}",
            {
              domain_id: payload.domain_id,
              submission_id: payload.submission_id,
              attempt_id: payload.attempt_id ?? null,
              problem_version_id: payload.problem_version_id ?? null,
              client_ip: clientIp,
              ips: ipCount,
            },
          );
        }
      } else {
        await deps.redis.expire(ipKey, ttlSeconds);
      }
    } catch {
      // 监控失败不阻断 LLM 调用
    }

    const body = await c.req.json<ChatCompletionRequest>().catch(() => null);
    if (!body || !Array.isArray(body.messages)) {
      return c.json({ error: "invalid_request" }, 400);
    }
    const model = body.model ?? "";
    if (!payload.allowed_models.includes(model)) {
      return c.json({ error: "model_not_allowed" }, 403);
    }
    // 模型别名：token 携带 model_map 时，评测代码请求里的 model 是别名，
    // 转发前改写为上游真实模型名；无 model_map 时行为不变。
    let upstreamModel = model;
    if (payload.model_map) {
      const mapped = Object.hasOwn(payload.model_map, model)
        ? payload.model_map[model]
        : undefined;
      if (typeof mapped !== "string" || !mapped) {
        return c.json({ error: "model_not_allowed" }, 403);
      }
      upstreamModel = mapped;
    }
    const aliasForAudit = upstreamModel === model ? undefined : model;

    let providerSecret;
    try {
      providerSecret = await getProviderSecret(
        deps.db,
        payload.provider_id,
        deps.config.storeKey,
        payload.domain_id,
      );
    } catch {
      return c.json({ error: "provider_not_found" }, 400);
    }
    if (!providerSecret.provider.enabled) {
      return c.json({ error: "provider_disabled" }, 403);
    }
    // 出站目标校验（G-03）：调用前解析 DNS，目标落在内网即拒绝（白名单除外）。
    // 放在额度扣减之前，被拦截的调用不消耗配额。
    try {
      await assertResolvesPublic(
        providerSecret.provider.base_url,
        deps.config.upstreamAllowedHosts,
        deps.resolveDns,
      );
    } catch {
      inc("noj_llm_provider_errors_total");
      logger.warn(
        "Provider 上游地址被出站校验拦截: provider={provider_id}",
        { provider_id: payload.provider_id },
      );
      return c.json({ error: UPSTREAM_BLOCKED }, 502);
    }

    const startedAt = Date.now();
    const callId = crypto.randomUUID();
    c.header("X-Noj-Call-Id", callId);
    const promptTokens = estimateTokens(body.messages);
    const completionTokens = typeof body.max_tokens === "number"
      ? Math.floor(Math.max(0, body.max_tokens))
      : 0;
    const estimatedCost = estimateCost(
      promptTokens + completionTokens,
      providerSecret.provider.cost_per_1k_tokens,
    );
    // 政策读取发生在**预占步骤**（enforceAndCount 的 withReservationLock 内），
    // 不在 Provider 排队之前读一份：排队期间提交的降额必须对本次新预占生效。
    // 持久政策不可读时预占步骤抛错，由下方 catch 映射为 503 quota_unavailable；
    // 请求不会发往上游，也不消耗 Provider 窗口额度。

    // Provider 级 RPM / TPM：超限时排队等待（多副本共享 Redis 队列），放在额度
    // 扣减之前——排队超时的请求不消耗用户/题目配额。
    let providerSlot: ProviderSlot;
    try {
      providerSlot = await acquireProviderSlot(deps.redis, {
        providerId: payload.provider_id,
        rpmLimit: providerSecret.provider.rpm_limit ?? 0,
        tpmLimit: providerSecret.provider.tpm_limit ?? 0,
        tokens: promptTokens + completionTokens,
        timeoutMs: deps.config.providerQueueTimeoutMs,
        signal: c.req.raw.signal,
      });
    } catch (err) {
      if (err instanceof ProviderQueueAbortedError) {
        // 客户端已断开：不再转发，也无需记录用量
        return new Response(
          JSON.stringify({ error: "client_closed_request" }),
          { status: 499, headers: { "content-type": "application/json" } },
        );
      }
      if (err instanceof ProviderQueueTimeoutError) {
        inc("noj_llm_provider_queue_timeouts_total");
        observe(
          "noj_llm_provider_queue_wait_seconds",
          Math.max(0, Date.now() - startedAt) / 1000,
        );
        logger.warn(
          "Provider 限流排队超时: provider={provider_id}",
          { provider_id: payload.provider_id },
        );
        await recordRejectedUsage(deps.db, deps.redis, {
          id: crypto.randomUUID(),
          domain_id: payload.domain_id,
          submission_id: payload.submission_id,
          attempt_id: payload.attempt_id ?? null,
          problem_version_id: payload.problem_version_id ?? null,
          problem_id: payload.problem_id,
          user_id: payload.user_id,
          provider_id: payload.provider_id,
          model: upstreamModel,
          request_messages: body.messages,
          request_params: pickParams(body, aliasForAudit),
          prompt_tokens: promptTokens,
          completion_tokens: 0,
          total_tokens: promptTokens,
          estimated_cost: 0,
          latency_ms: Date.now() - startedAt,
          status: "rejected",
          error_code: "provider_queue_timeout",
          prompt_hash: await sha256Hex(JSON.stringify(body.messages)),
          created_at: new Date().toISOString(),
        });
        return providerQueueTimeoutError(err.retryAfterSeconds);
      }
      // Redis 故障时放行（fail-open）：节流只为保护上游，上游自身仍会 429
      logger.warn(
        "Provider 限流不可用，直接放行: provider={provider_id}",
        { provider_id: payload.provider_id },
      );
      providerSlot = {
        waitedMs: 0,
        release: () => Promise.resolve(),
        settle: () => Promise.resolve(),
      };
    }
    if (providerSlot.waitedMs > 0) {
      observe(
        "noj_llm_provider_queue_wait_seconds",
        providerSlot.waitedMs / 1000,
      );
    }

    try {
      await enforceAndCount(deps.db, deps.redis, payload, {
        callId,
        model,
        promptTokens,
        completionTokens,
        estimatedCost,
        ip: c.req.header("x-forwarded-for") ?? "unknown",
        ttlSeconds,
        userRateLimitPerMinute: deps.config.userRateLimitPerMinute,
        ipRateLimitPerMinute: deps.config.ipRateLimitPerMinute,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : "limit_exceeded";
      // 请求未发往上游：包括配额服务失败也归还 Provider 窗口额度。
      await providerSlot.release().catch(() => undefined);
      if (err instanceof EvalTokenAdmissionError) {
        return c.json(
          { error: err.code },
          err.code === "revocations_unavailable" ? 503 : 401,
        );
      }
      if (message !== "limit_exceeded" && message !== "rate_limit_exceeded") {
        return c.json({ error: "quota_unavailable" }, 503);
      }
      inc("noj_llm_rate_limited_total");
      // 调用前拒绝：不存原文 + 按提交去重（G-04），见 recordRejectedUsage
      await recordRejectedUsage(deps.db, deps.redis, {
        id: crypto.randomUUID(),
        domain_id: payload.domain_id,
        submission_id: payload.submission_id,
        attempt_id: payload.attempt_id ?? null,
        problem_version_id: payload.problem_version_id ?? null,
        problem_id: payload.problem_id,
        user_id: payload.user_id,
        provider_id: payload.provider_id,
        model: upstreamModel,
        request_messages: body.messages,
        request_params: {
          ...pickParams(body, aliasForAudit),
          ...(err instanceof QuotaLimitError
            ? { quota_limit: err.diagnostics }
            : {}),
        },
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
      return openAiLimitError(message);
    }

    const upstreamUrl = buildChatUrl(providerSecret.provider.base_url);
    // 客户端取消必须一路终止到上游，避免评测结束后继续占用请求。
    const upstreamSignal = AbortSignal.any([
      c.req.raw.signal,
      AbortSignal.timeout(120_000),
    ]);
    let upstreamRes: Response;
    try {
      upstreamRes = await fetch(upstreamUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${providerSecret.apiKey}`,
        },
        body: JSON.stringify(
          prepareUpstreamRequestBody(
            upstreamModel === model ? body : { ...body, model: upstreamModel },
          ),
        ),
        signal: upstreamSignal,
        redirect: "error",
      });
    } catch {
      const errorCode = c.req.raw.signal.aborted
        ? "client_closed_request"
        : upstreamSignal.aborted
        ? "upstream_timeout"
        : "upstream_error";
      await providerSlot.release().catch(() => undefined);
      logger.warn("LLM 上游请求失败", {
        submission_id: payload.submission_id,
        attempt_id: payload.attempt_id ?? null,
        error_code: errorCode,
        latency_ms: Date.now() - startedAt,
      });
      inc("noj_llm_provider_errors_total");
      await recordUnknownCall(deps.db, callId);
      await recordUsage(deps.db, {
        id: callId,
        domain_id: payload.domain_id,
        submission_id: payload.submission_id,
        attempt_id: payload.attempt_id ?? null,
        problem_version_id: payload.problem_version_id ?? null,
        problem_id: payload.problem_id,
        user_id: payload.user_id,
        provider_id: payload.provider_id,
        model: upstreamModel,
        request_messages: body.messages,
        request_params: pickParams(body, aliasForAudit),
        prompt_tokens: promptTokens,
        completion_tokens: 0,
        total_tokens: promptTokens,
        estimated_cost: 0,
        latency_ms: Date.now() - startedAt,
        status: "error",
        error_code: errorCode,
        prompt_hash: await sha256Hex(JSON.stringify(body.messages)),
        created_at: new Date().toISOString(),
      });
      return new Response(JSON.stringify({ error: errorCode }), {
        status: errorCode === "client_closed_request"
          ? 499
          : errorCode === "upstream_timeout"
          ? 504
          : 502,
        headers: { "content-type": "application/json" },
      });
    }

    if (body.stream === true) {
      return createStreamingResponse({
        response: upstreamRes,
        payload,
        body,
        callId,
        startedAt,
        promptTokens,
        estimatedCost,
        costPer1kTokens: providerSecret.provider.cost_per_1k_tokens,
        upstreamModel,
        ...(aliasForAudit === undefined ? {} : { aliasForAudit }),
        providerSlot,
        requestSignal: c.req.raw.signal,
        deps,
      });
    }

    let upstreamText = "";
    try {
      upstreamText = await readUpstreamBodyWithLimit(
        upstreamRes,
        MAX_UPSTREAM_BODY_BYTES,
      );
    } catch (readErr) {
      await providerSlot.release().catch(() => undefined);
      inc("noj_llm_provider_errors_total");
      await recordUnknownCall(deps.db, callId);
      const errCode = readErr instanceof Error &&
          readErr.message === "upstream_response_too_large"
        ? "upstream_response_too_large"
        : "upstream_error";
      await recordUsage(deps.db, {
        id: callId,
        domain_id: payload.domain_id,
        submission_id: payload.submission_id,
        attempt_id: payload.attempt_id ?? null,
        problem_version_id: payload.problem_version_id ?? null,
        problem_id: payload.problem_id,
        user_id: payload.user_id,
        provider_id: payload.provider_id,
        model: upstreamModel,
        request_messages: body.messages,
        request_params: pickParams(body, aliasForAudit),
        prompt_tokens: promptTokens,
        completion_tokens: 0,
        total_tokens: promptTokens,
        estimated_cost: 0,
        latency_ms: Date.now() - startedAt,
        status: "error",
        error_code: errCode,
        prompt_hash: await sha256Hex(JSON.stringify(body.messages)),
        created_at: new Date().toISOString(),
      });
      return c.json({ error: errCode }, 502);
    }

    let upstreamBody: Record<string, unknown> | null = null;
    try {
      upstreamBody = JSON.parse(upstreamText);
    } catch {
      // 上游返回畸形 JSON 时按空 body 处理，不使代理 500
      upstreamBody = null;
    }
    const latency = Date.now() - startedAt;
    const usage = upstreamBody?.usage as
      | {
        prompt_tokens?: number;
        completion_tokens?: number;
        total_tokens?: number;
        prompt_tokens_details?: {
          cached_tokens?: number;
        };
      }
      | undefined;
    const billedUsage = calcBilledUsage(usage, promptTokens, 0);
    const actualPromptTokens = billedUsage.promptTokens;
    const actualCompletionTokens = billedUsage.completionTokens;
    const actualTotalTokens = billedUsage.totalTokens;
    const actualBilledTotalTokens = billedUsage.billedTotalTokens;
    inc("noj_llm_tokens_total", {}, actualBilledTotalTokens);
    // 上游 TPM 按实际总 token 计：用真实用量修正预占（失败不影响响应）
    if (usage) {
      await providerSlot.settle(actualTotalTokens).catch(() => undefined);
    }
    const actualCost = estimateCost(
      actualBilledTotalTokens,
      providerSecret.provider.cost_per_1k_tokens,
    );

    await persistCallUsage(
      deps.db,
      callId,
      {
        id: callId,
        domain_id: payload.domain_id,
        submission_id: payload.submission_id,
        attempt_id: payload.attempt_id ?? null,
        problem_version_id: payload.problem_version_id ?? null,
        problem_id: payload.problem_id,
        user_id: payload.user_id,
        provider_id: payload.provider_id,
        model: upstreamModel,
        request_messages: body.messages,
        request_params: pickParams(body, aliasForAudit),
        prompt_tokens: actualPromptTokens,
        completion_tokens: actualCompletionTokens,
        total_tokens: actualTotalTokens,
        cached_prompt_tokens: billedUsage.cachedPromptTokens,
        billed_prompt_tokens: billedUsage.billedPromptTokens,
        billed_total_tokens: billedUsage.billedTotalTokens,
        estimated_cost: actualCost,
        latency_ms: latency,
        status: upstreamRes.ok ? "ok" : "error",
        error_code: upstreamRes.ok ? null : String(upstreamRes.status),
        prompt_hash: await sha256Hex(JSON.stringify(body.messages)),
        created_at: new Date().toISOString(),
      },
      actualBilledTotalTokens,
      actualCost,
    );
    let settled: string;
    try {
      settled = await settleCall(deps.db, deps.redis, callId);
    } catch {
      // 实际用量已持久化；不伪称额度错误，后台在 Redis 恢复后幂等结算。
      return c.json({ error: "accounting_pending", call_id: callId }, 503);
    }
    if (settled !== "ok") {
      inc("noj_llm_quota_exhausted_total");
      await deps
        .db`UPDATE llm_usage SET status='rejected',error_code=${settled} WHERE id=${callId}`;
      return openAiLimitError(settled);
    }

    if (!upstreamRes.ok) {
      inc("noj_llm_provider_errors_total");
      return new Response(
        JSON.stringify({
          error: "upstream_error",
          status: upstreamRes.status,
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

/** 粗略估算 prompt token：按 JSON 字符数 /4 向上取整。 */
function estimateTokens(messages: unknown[]): number {
  try {
    return Math.ceil(JSON.stringify(messages).length / 4);
  } catch {
    return 0;
  }
}

/** 按单价（每 1k tokens）估算费用，结果取整。 */
function estimateCost(totalTokens: number, costPer1k: number): number {
  if (!costPer1k || totalTokens <= 0) return 0;
  return Math.round((totalTokens / 1000) * costPer1k);
}

/** 从请求体中挑选需要审计的关键参数（排除 messages 等大字段）。 */
function pickParams(
  body: ChatCompletionRequest,
  alias?: string,
): Record<string, unknown> {
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
  // 请求里的 model 是别名时（alias 非空），保留别名便于对账（usage.model 记录真实模型名）
  if (alias !== undefined) params.model_alias = alias;
  return params;
}
