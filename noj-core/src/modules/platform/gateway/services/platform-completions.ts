/**
 * core → noj-llm-gateway：平台身份模型调用与按用途用量查询。
 *
 * 知识图谱 AI 打标以**平台身份**调用模型：Provider Key 仍只在网关，core 只发送
 * 白名单内的用途（purpose）+ 模型别名，并拿回模型输出与用量。
 *
 * 与评测路径（eval_token → `POST /v1/chat/completions`）不同：
 * - 不签发 eval_token，不消耗任何学生评测额度；
 * - 输出必须有上限（网关侧 ≤1024，core 侧做同样校验以便尽早失败）；
 * - 记账主体为 `platform` + purpose，可按用途聚合查询用量（月度预算检查）。
 */
import { DEFAULT_DOMAIN_ID } from "../../../../shared/workspace/types.ts";
import {
  AppError,
  BadRequestError,
  ServiceUnavailableError,
} from "../../../../shared/base/errors.ts";
import { LlmGatewayError } from "./llm.ts";

/** Gateway 单次平台调用的 HTTP 上限；模型推理通常慢于配置读写。 */
const PLATFORM_COMPLETION_TIMEOUT_MS = 60_000;

/** 与网关保持一致的最大输出 token 上限。 */
export const PLATFORM_MAX_OUTPUT_TOKENS = 1024;

/** 第一版支持的平台调用用途白名单（与网关一致）。 */
export const PLATFORM_PURPOSES = ["knowledge.tag"] as const;
export type PlatformPurpose = typeof PLATFORM_PURPOSES[number];

/** 知识图谱打标模型别名（运维文档约定，需在网关管理端配置）。 */
export const KNOWLEDGE_TAG_MODEL_ALIAS = "platform.tagger";

/** 平台调用错误码（由网关返回，客户端原样透传）。 */
export type PlatformCompletionErrorCode =
  | "invalid_request"
  | "invalid_purpose"
  | "invalid_model_alias"
  | "invalid_max_tokens"
  | "invalid_messages"
  | "invalid_alias"
  /** 别名未在网关配置（管理员需配置 `platform.tagger`）。 */
  | "MODEL_ALIAS_NOT_CONFIGURED"
  | "PROVIDER_NOT_FOUND"
  | "UPSTREAM_BLOCKED"
  /** 上游自身限流（429）。 */
  | "RATE_LIMITED"
  /** 网关 Provider 排队超时（RPM/TPM 保护）。 */
  | "PROVIDER_RATE_LIMITED"
  | "UPSTREAM_TIMEOUT"
  | "UPSTREAM_ERROR"
  | "upstream_response_too_large"
  | "client_closed_request"
  | "gateway_timeout"
  | "gateway_unavailable"
  | "gateway_error"
  | "unauthorized";

/** 模型消息（OpenAI 兼容）。 */
export interface PlatformChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

/** {@link platformCompletion} 的输入。 */
export interface PlatformCompletionInput {
  /** 调用用途（白名单），同时作为记账主体。 */
  purpose: PlatformPurpose;
  /** 网关模型别名（如 `platform.tagger`）。 */
  model_alias: string;
  /** 发送给模型的 messages。 */
  messages: PlatformChatMessage[];
  /** 输出上限（1..1024）。 */
  max_tokens: number;
  /** 采样温度（0..2）。 */
  temperature?: number;
  /** 结构化输出要求（如 `{ type: "json_object" }`）。 */
  response_format?: Record<string, unknown>;
  /** 使用域；缺省为默认域。 */
  domainId?: string;
}

/** 平台调用的用量。 */
export interface PlatformCompletionUsage {
  input_tokens: number;
  output_tokens: number;
  cached_input_tokens: number;
}

/** {@link platformCompletion} 的返回值。 */
export interface PlatformCompletionResult {
  /** 模型输出文本。 */
  content: string;
  /** 网关实际转发到的上游模型名。 */
  model: string;
  /** token 用量。 */
  usage: PlatformCompletionUsage;
  /** 网关估算成本（整数，单位与网关 Provider 单价一致）。 */
  cost: number;
}

/** 按用途的累计用量。 */
export interface PlatformUsageSummary {
  purpose: PlatformPurpose;
  since: string;
  input_tokens: number;
  output_tokens: number;
  requests: number;
  cost: number;
}

/** 平台调用失败时抛出；`code` 可区分未配置 / 限流 / 上游故障。 */
export class PlatformCompletionError extends LlmGatewayError {
  constructor(status: number, code: string) {
    super(status, code);
    this.name = "PlatformCompletionError";
  }
}

/**
 * 把平台调用错误映射为 HTTP 层可用的 AppError。
 *
 * - `MODEL_ALIAS_NOT_CONFIGURED` → 400：管理员可修复的配置缺失，不是系统故障；
 * - `RATE_LIMITED` / `PROVIDER_RATE_LIMITED` → 429：可稍后重试；
 * - 网关不可达 / 超时 → 503。
 */
export function mapPlatformCompletionError(
  error: PlatformCompletionError,
): AppError {
  const message = `LLM 平台调用失败：${error.code}`;
  switch (error.code) {
    case "MODEL_ALIAS_NOT_CONFIGURED":
      return new BadRequestError(message, error.code);
    case "RATE_LIMITED":
    case "PROVIDER_RATE_LIMITED":
      return new AppError(message, 429, error.code);
    case "unauthorized":
    case "gateway_timeout":
    case "gateway_unavailable":
      return new ServiceUnavailableError(message);
    default:
      return error.status >= 500
        ? new ServiceUnavailableError(message)
        : new AppError(message, error.status, error.code);
  }
}

/** 读取网关地址与服务令牌（每次调用时读取，便于测试注入）。 */
function gatewayEnv(): { url: string; token: string } {
  const url = Deno.env.get("NOJ_LLM_GATEWAY_URL") ?? "http://localhost:8001";
  const token = Deno.env.get("NOJ_LLM_SERVICE_TOKEN") ?? "";
  if (!token) {
    throw new Error("NOJ_LLM_SERVICE_TOKEN 未配置，无法访问 LLM Gateway");
  }
  return { url, token };
}

/** 统一请求封装：超时、错误码解包、错误类型映射。 */
async function request<T>(
  path: string,
  init: RequestInit,
  domainId: string,
): Promise<T> {
  const { url, token } = gatewayEnv();
  let res: Response;
  try {
    res = await fetch(`${url}${path}`, {
      ...init,
      signal: AbortSignal.timeout(PLATFORM_COMPLETION_TIMEOUT_MS),
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${token}`,
        "X-Noj-Domain-Id": domainId,
        ...(init.headers ?? {}),
      },
    });
  } catch (error) {
    if (
      error instanceof DOMException &&
      (error.name === "AbortError" || error.name === "TimeoutError")
    ) {
      throw new PlatformCompletionError(503, "gateway_timeout");
    }
    throw new PlatformCompletionError(503, "gateway_unavailable");
  }
  const body = await res.json().catch(() => null);
  if (!res.ok) {
    throw new PlatformCompletionError(
      res.status,
      typeof body?.error === "string" ? body.error : "gateway_error",
    );
  }
  return body as T;
}

/**
 * 以平台身份调用模型（知识图谱 AI 打标的唯一入口）。
 *
 * @throws {Error} 未配置 NOJ_LLM_SERVICE_TOKEN
 * @throws {BadRequestError} 本地参数越界（max_tokens / messages）
 * @throws {PlatformCompletionError} 网关返回非 2xx（含 alias 未配置、上游限流）
 */
export async function platformCompletion(
  input: PlatformCompletionInput,
): Promise<PlatformCompletionResult> {
  if (!Number.isInteger(input.max_tokens) || input.max_tokens <= 0) {
    throw new BadRequestError("max_tokens 必须为正整数");
  }
  if (input.max_tokens > PLATFORM_MAX_OUTPUT_TOKENS) {
    throw new BadRequestError(
      `max_tokens 不能超过 ${PLATFORM_MAX_OUTPUT_TOKENS}`,
    );
  }
  if (input.messages.length === 0) {
    throw new BadRequestError("messages 不能为空");
  }
  const body = await request<{
    content: string;
    model: string;
    usage?: Partial<PlatformCompletionUsage>;
    cost?: number;
  }>("/internal/platform-completions", {
    method: "POST",
    body: JSON.stringify({
      purpose: input.purpose,
      model_alias: input.model_alias,
      messages: input.messages,
      max_tokens: input.max_tokens,
      ...(input.temperature === undefined
        ? {}
        : { temperature: input.temperature }),
      ...(input.response_format === undefined
        ? {}
        : { response_format: input.response_format }),
    }),
  }, input.domainId ?? DEFAULT_DOMAIN_ID);
  return {
    content: body.content,
    model: body.model,
    usage: {
      input_tokens: Number(body.usage?.input_tokens ?? 0),
      output_tokens: Number(body.usage?.output_tokens ?? 0),
      cached_input_tokens: Number(body.usage?.cached_input_tokens ?? 0),
    },
    cost: Number(body.cost ?? 0),
  };
}

/**
 * 查询某用途自 `since` 起的累计用量（月度预算检查 / 后台展示）。
 *
 * @throws {Error} 未配置 NOJ_LLM_SERVICE_TOKEN
 * @throws {PlatformCompletionError} 网关返回非 2xx
 */
export async function queryPlatformUsage(
  purpose: PlatformPurpose,
  since: Date | string,
  domainId: string = DEFAULT_DOMAIN_ID,
): Promise<PlatformUsageSummary> {
  const sinceIso = since instanceof Date ? since.toISOString() : since;
  const params = new URLSearchParams({ purpose, since: sinceIso });
  const body = await request<{
    purpose: PlatformPurpose;
    since: string;
    input_tokens: number;
    output_tokens: number;
    requests: number;
    cost: number;
  }>(
    `/internal/platform-usage?${params.toString()}`,
    { method: "GET" },
    domainId,
  );
  return {
    purpose: body.purpose,
    since: body.since,
    input_tokens: Number(body.input_tokens ?? 0),
    output_tokens: Number(body.output_tokens ?? 0),
    requests: Number(body.requests ?? 0),
    cost: Number(body.cost ?? 0),
  };
}
