/**
 * noj-core → noj-llm-gateway 管理 API 客户端。
 *
 * core 不直接接触上游 Provider Key；Provider 配置、用量查询、配额配置
 * 统一通过 gateway 内部管理 API 完成。
 */

import { DEFAULT_DOMAIN_ID } from "../../../../shared/workspace/types.ts";
import { getSetting } from "../../services/system-settings.ts";
import { AppError, BadRequestError } from "../../../../shared/base/errors.ts";

/** Core 调用 Gateway 的单次 HTTP 上限；超时后只允许用 operation ID 查询结果。 */
const GATEWAY_REQUEST_TIMEOUT_MS = 10_000;

/** 配置管理读取调用方资源 revision；创建传 0，禁止客户端无条件覆盖。 */
export function parseLlmRevision(header: string | undefined): number {
  if (header === undefined) {
    throw new AppError("需要 LLM 资源 revision", 428, "REVISION_REQUIRED");
  }
  const raw = header.replace(/^"|"$/g, "");
  const revision = Number(raw);
  if (!/^\d+$/.test(raw) || !Number.isSafeInteger(revision)) {
    throw new BadRequestError("revision 非法");
  }
  return revision;
}

/**
 * 创建或更新 LLM Provider 的输入参数。
 */
export interface LlmProviderInput {
  /** Provider 名称 */
  name: string;
  /** Provider Base URL */
  base_url: string;
  /** API Key（仅发送给 gateway 加密存储，不会返回明文） */
  api_key: string;
  /** 每 1000 token 的成本（可选） */
  cost_per_1k_tokens?: number;
  /** 是否启用（可选） */
  enabled?: boolean;
  /** 上游每分钟请求数上限（0 = 不限；超限时 gateway 排队） */
  rpm_limit?: number;
  /** 上游每分钟 token 数上限（0 = 不限；超限时 gateway 排队） */
  tpm_limit?: number;
}

/**
 * LLM Gateway 调用失败时的错误类型。
 */
export class LlmGatewayError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
  ) {
    super(code);
    this.name = "LlmGatewayError";
  }
}

/**
 * LLM Provider 的展示视图（Key 已由 gateway 脱敏）。
 */
export interface LlmProviderView {
  /** Provider ID */
  id: string;
  /** Gateway 当前配置版本。 */
  revision: number;
  /** 使用域 */
  domain_id: string;
  /** Provider 名称 */
  name: string;
  /** Provider Base URL */
  base_url: string;
  /** 每 1000 token 的成本 */
  cost_per_1k_tokens: number;
  /** 脱敏后的 API Key（如 `sk-****`） */
  api_key_masked: string;
  /** 是否启用 */
  enabled: boolean;
  /** 上游每分钟请求数上限（0 = 不限） */
  rpm_limit: number;
  /** 上游每分钟 token 数上限（0 = 不限） */
  tpm_limit: number;
  /** 创建时间 */
  created_at: string;
  /** 更新时间 */
  updated_at: string;
}

/** Gateway 维护的使用域模型别名展示。 */
export interface GatewayModelAliasView {
  domain_id: string;
  alias: string;
  provider_id: string;
  model: string;
  description: string;
  revision: number;
  updated_at: string;
  updated_by: string;
}

/** Gateway 模型别名写入参数。 */
export interface GatewayModelAliasInput {
  provider_id: string;
  model: string;
  description?: string;
}

/** Gateway 返回的域默认模型选择。 */
export interface GatewayDomainModelSettings {
  domain_id: string;
  provider_id: string | null;
  model: string | null;
  revision: number;
  updated_at: string | null;
  updated_by: string | null;
}

/** Gateway 在受理边界内解析出的 Provider/真实模型集合。 */
export interface GatewayResolvedModelSelection {
  provider_id: string;
  models: { alias: string; model: string }[];
}

/**
 * LLM 用量查询的筛选参数。
 */
export interface LlmUsageQuery {
  /** 关联的提交 ID */
  submission_id?: string;
  /** 关联的用户 ID */
  user_id?: string;
  /** 关联的题目 ID */
  problem_id?: string;
  /** Provider ID */
  provider_id?: string;
  /** 用量状态 */
  status?: string;
  /** 起始时间 */
  start_time?: string;
  /** 结束时间 */
  end_time?: string;
  /** 返回条数（透传 gateway） */
  limit?: number;
  /** 页码（透传 gateway） */
  page?: number;
}

/**
 * LLM 配额的新增或更新输入（带 id 只更新既有资源）。
 */
export interface LlmQuotaInput {
  /** 配额 ID（更新时提供；缺省为新增） */
  id?: string;
  /** 配额作用域类型 */
  scope_type: "domain" | "user" | "problem" | "global" | "user_problem";
  /** 作用域对象 ID（user/problem 时必填；user_problem 时形如 `<userId>:<problemId>`） */
  scope_id?: string;
  /** 配额窗口类型 */
  window_type?: "day" | "month";
  /** 最大调用次数 */
  max_calls?: number | null;
  /** 最大 token 数 */
  max_tokens?: number | null;
  /** 最大成本 */
  max_cost?: number | null;
}

/**
 * 向 LLM Gateway 内部管理 API 发起请求的通用封装。
 *
 * 自动拼接 GATEWAY_URL、注入 SERVICE_TOKEN 承载 Token 与 JSON 头，
 * 并将响应体解包返回。Token 未配置或 HTTP 非 2xx 时抛错。
 *
 * 环境变量在每次调用时读取（而非模块加载时捕获），便于测试按需设置。
 *
 * @param path 相对路径（如 `/internal/providers`），不含 GATEWAY_URL 前缀
 * @param init 可选的 fetch 请求配置（method/body/headers 等）
 * @returns 响应体 JSON 按类型 T 返回
 * @throws {Error} 调用时 NOJ_LLM_SERVICE_TOKEN 未配置
 * @throws {LlmGatewayError} gateway 返回非 2xx 时抛出，携带状态码与错误码
 */
async function request<T>(
  path: string,
  init?: RequestInit,
  domainId = DEFAULT_DOMAIN_ID,
): Promise<T> {
  const GATEWAY_URL = Deno.env.get("NOJ_LLM_GATEWAY_URL") ??
    "http://localhost:8001";
  const SERVICE_TOKEN = Deno.env.get("NOJ_LLM_SERVICE_TOKEN") ?? "";
  if (!SERVICE_TOKEN) {
    throw new Error("NOJ_LLM_SERVICE_TOKEN 未配置，无法访问 LLM Gateway");
  }
  let res: Response;
  const timeoutSignal = AbortSignal.timeout(GATEWAY_REQUEST_TIMEOUT_MS);
  const signal = init?.signal
    ? AbortSignal.any([init.signal, timeoutSignal])
    : timeoutSignal;
  try {
    res = await fetch(`${GATEWAY_URL}${path}`, {
      ...init,
      signal,
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${SERVICE_TOKEN}`,
        "X-Noj-Domain-Id": domainId,
        ...(init?.headers ?? {}),
      },
    });
  } catch (error) {
    if (
      init?.signal?.aborted ||
      error instanceof DOMException &&
        (error.name === "AbortError" || error.name === "TimeoutError")
    ) {
      throw new LlmGatewayError(503, "gateway_timeout");
    }
    throw new LlmGatewayError(503, "gateway_unavailable");
  }
  const body = await res.json().catch(() => null);
  if (!res.ok) {
    throw new LlmGatewayError(
      res.status,
      typeof body?.error === "string" ? body.error : "gateway_error",
    );
  }
  return body as T;
}

/**
 * 读取平台级默认 LLM Provider 与模型。
 *
 * 两项必须同时配置（无 Provider 级 model 回退）：任一为空则返回 null，
 * 由调用方（buildJudgeTaskLlm）转成明确的 400 错误。
 */
export function getLlmPlatformDefault(): {
  provider_id: string;
  model: string;
} | null {
  const providerId = String(getSetting("llm_default_provider_id")?.value ?? "")
    .trim();
  const model = String(getSetting("llm_default_model")?.value ?? "").trim();
  if (!providerId || !model) return null;
  return { provider_id: providerId, model };
}

/**
 * 提示平台默认 LLM 配置**只配了一半**的情况（2026-09-22 评审）。
 *
 * `getLlmPlatformDefault()` 要求两项同时配置，任一为空即返回 null → LLM 题提交
 * 直接 400。而部署者极易只取消注释其中一项（`.env.prod.example` 里两项都是
 * 注释示例），因此这里在启动时给出可操作的告警，而不是等到用户提交才 400。
 *
 * @returns 需要告警的键名（两项都空时返回空数组——那代表"不启用 LLM 题"，
 * 属正常配置，不该刷告警）。
 */
export function describeLlmPlatformDefaultGap(): string[] {
  const providerId = String(getSetting("llm_default_provider_id")?.value ?? "")
    .trim();
  const model = String(getSetting("llm_default_model")?.value ?? "").trim();
  if (!providerId && !model) return [];
  if (providerId && model) return [];
  return [
    providerId ? "llm_default_model" : "llm_default_provider_id",
  ];
}

/** 获取 LLM Provider 列表（Key 已由 gateway 脱敏）。 */
export async function listLlmProviders(
  domainId = DEFAULT_DOMAIN_ID,
): Promise<LlmProviderView[]> {
  const body = await request<{ data: LlmProviderView[] }>(
    "/internal/providers",
    undefined,
    domainId,
  );
  return body.data;
}

/** 按 ID 获取 LLM Provider 精简信息（供题目 CRUD 校验使用）。 */
export async function getLlmProviderById(
  id: string,
  domainId = DEFAULT_DOMAIN_ID,
): Promise<LlmProviderView> {
  const body = await request<{ data: LlmProviderView }>(
    `/internal/providers/${id}`,
    undefined,
    domainId,
  );
  return body.data;
}

/** 创建 LLM Provider（API Key 由 gateway 加密存储）。 */
export async function createLlmProvider(
  input: LlmProviderInput,
  domainId = DEFAULT_DOMAIN_ID,
  revision?: number,
): Promise<LlmProviderView> {
  const body = await request<{ data: LlmProviderView }>(
    "/internal/providers",
    {
      method: "POST",
      body: JSON.stringify(input),
      headers: revision === undefined
        ? undefined
        : { "If-Match": String(revision) },
    },
    domainId,
  );
  return body.data;
}

/** 更新 LLM Provider 的指定字段。 */
export async function updateLlmProvider(
  id: string,
  input: Partial<LlmProviderInput>,
  domainId = DEFAULT_DOMAIN_ID,
  revision?: number,
): Promise<LlmProviderView> {
  const body = await request<{ data: LlmProviderView }>(
    `/internal/providers/${id}`,
    {
      method: "PUT",
      body: JSON.stringify(input),
      headers: revision === undefined
        ? undefined
        : { "If-Match": String(revision) },
    },
    domainId,
  );
  return body.data;
}

/** 读取 Gateway 权威的使用域模型别名。 */
export async function listLlmGatewayModelAliases(
  domainId = DEFAULT_DOMAIN_ID,
): Promise<GatewayModelAliasView[]> {
  const body = await request<{ data: GatewayModelAliasView[] }>(
    "/internal/model-aliases",
    undefined,
    domainId,
  );
  return body.data;
}

/** 通过 Gateway 原子写入使用域模型别名。 */
export async function upsertLlmGatewayModelAlias(
  alias: string,
  input: GatewayModelAliasInput,
  domainId = DEFAULT_DOMAIN_ID,
  revision = 0,
  actorId = "system",
): Promise<GatewayModelAliasView> {
  const body = await request<{ data: GatewayModelAliasView }>(
    `/internal/model-aliases/${encodeURIComponent(alias)}`,
    {
      method: "PUT",
      headers: {
        "If-Match": String(revision),
        "X-Noj-Actor-Id": actorId,
      },
      body: JSON.stringify(input),
    },
    domainId,
  );
  return body.data;
}

/** 通过 Gateway 原子删除使用域模型别名。 */
export async function deleteLlmGatewayModelAlias(
  alias: string,
  domainId = DEFAULT_DOMAIN_ID,
  revision = 0,
): Promise<boolean> {
  await request<unknown>(
    `/internal/model-aliases/${encodeURIComponent(alias)}`,
    {
      method: "DELETE",
      headers: { "If-Match": String(revision) },
    },
    domainId,
  );
  return true;
}

/** 读取 Gateway 权威的使用域默认模型设置。 */
export async function readLlmGatewaySettings(
  domainId = DEFAULT_DOMAIN_ID,
): Promise<GatewayDomainModelSettings> {
  const body = await request<{ data: GatewayDomainModelSettings }>(
    "/internal/settings",
    undefined,
    domainId,
  );
  return body.data;
}

/** 通过 Gateway 原子更新使用域默认模型设置。 */
export async function updateLlmGatewaySettings(
  input: { provider_id: string | null; model: string | null },
  domainId = DEFAULT_DOMAIN_ID,
  revision = 0,
  actorId = "system",
): Promise<GatewayDomainModelSettings> {
  const body = await request<{ data: GatewayDomainModelSettings }>(
    "/internal/settings",
    {
      method: "PUT",
      headers: {
        "If-Match": String(revision),
        "X-Noj-Actor-Id": actorId,
      },
      body: JSON.stringify(input),
    },
    domainId,
  );
  return body.data;
}

/** 在 Gateway 内解析当前受理所需的别名集合。 */
export async function resolveLlmGatewayExecution(
  aliases: string[],
  domainId = DEFAULT_DOMAIN_ID,
): Promise<GatewayResolvedModelSelection> {
  const body = await request<{ data: GatewayResolvedModelSelection }>(
    "/internal/execution-config",
    {
      method: "POST",
      body: JSON.stringify({ aliases }),
    },
    domainId,
  );
  return body.data;
}

/** 读取不含 Provider/真实模型的能力下拉。 */
export async function listLlmGatewayModelCapabilities(
  domainId = DEFAULT_DOMAIN_ID,
): Promise<{ alias: string; description: string }[]> {
  const body = await request<{
    data: { alias: string; description: string }[];
  }>(
    "/internal/model-capabilities",
    undefined,
    domainId,
  );
  return body.data;
}

/** 按条件查询 LLM 用量记录（透传 gateway 分页/筛选参数）。 */
export async function queryLlmUsage(
  query: LlmUsageQuery,
  domainId = DEFAULT_DOMAIN_ID,
): Promise<unknown[]> {
  const params = new URLSearchParams();
  if (query.submission_id) params.set("submission_id", query.submission_id);
  if (query.user_id) params.set("user_id", query.user_id);
  if (query.problem_id) params.set("problem_id", query.problem_id);
  if (query.provider_id) params.set("provider_id", query.provider_id);
  if (query.status) params.set("status", query.status);
  if (query.start_time) params.set("start_time", query.start_time);
  if (query.end_time) params.set("end_time", query.end_time);
  if (query.limit !== undefined) params.set("limit", String(query.limit));
  if (query.page !== undefined) params.set("page", String(query.page));
  const qs = params.toString();
  const body = await request<{ data: unknown[] }>(
    `/internal/usage${qs ? `?${qs}` : ""}`,
    undefined,
    domainId,
  );
  return body.data;
}

/** 新增或按 id 更新既有配额，资源版本由 Gateway 原子比较。 */
export async function upsertLlmQuota(
  input: LlmQuotaInput,
  domainId = DEFAULT_DOMAIN_ID,
  revision?: number,
): Promise<{ id: string; revision: number }> {
  const body = await request<{ data: { id: string; revision: number } }>(
    "/internal/quotas",
    {
      method: "POST",
      body: JSON.stringify(input),
      headers: {
        ...(input.scope_type === "global"
          ? { "X-Noj-Instance-Quota": "1" }
          : {}),
        ...(revision === undefined ? {} : { "If-Match": String(revision) }),
      },
    },
    domainId,
  );
  return body.data;
}

/** 当前使用域的持久配额配置。 */
export async function listLlmQuotas(
  domainId = DEFAULT_DOMAIN_ID,
): Promise<unknown[]> {
  const body = await request<{ data: unknown[] }>(
    "/internal/quotas",
    undefined,
    domainId,
  );
  return body.data;
}

/** 实例治理专用配额列表；域管理门面不暴露此入口。 */
export async function listInstanceLlmQuotas(): Promise<unknown[]> {
  const body = await request<{ data: unknown[] }>(
    "/internal/quotas",
    { headers: { "X-Noj-Instance-Quota": "1" } },
  );
  return body.data;
}

/**
 * 用指定模型对 Provider 发起一次最小真实调用，验证 Base URL / Key / 模型可用。
 *
 * gateway 侧以 `max_tokens: 1` 请求上游 `/chat/completions`（10 秒超时），
 * 成功即返回；失败时抛出 LlmGatewayError，错误码见 gateway
 * `testProviderConnection`（provider_auth_failed / provider_rate_limited /
 * provider_unavailable / provider_error / provider_base_url_blocked 等）。
 */
export async function testLlmProvider(
  id: string,
  model: string,
  domainId = DEFAULT_DOMAIN_ID,
): Promise<void> {
  await request<{ data: { status: string } }>(
    `/internal/providers/${encodeURIComponent(id)}/test`,
    {
      method: "POST",
      body: JSON.stringify({ model }),
    },
    domainId,
  );
}

/** 实例 LLM 政策快照（Core → Gateway 迁移用）。 */
export interface GatewayPolicySnapshot {
  readonly revision: number;
  readonly day: {
    max_calls: number | null;
    max_tokens: number | null;
    max_cost: number | null;
  };
  readonly month: {
    max_calls: number | null;
    max_tokens: number | null;
    max_cost: number | null;
  };
  readonly updated_at: string;
}

/**
 * 导出旧 Core 政策快照（只读）。
 *
 * 迁移顺序固定：旧政策快照 → Gateway schema 迁移 → 导入 → 值/revision/摘要核对
 * → 切换读写。本函数只读取 `domain_llm_quota_caps` 设置，不写任何状态；
 * 切换后该设置只作只读迁移归档，不再作为调用时权威或 fallback。
 */
export async function exportGatewayPolicySnapshot(): Promise<
  GatewayPolicySnapshot
> {
  const { getSetting } = await import("../../system/index.ts");
  const raw = getSetting("domain_llm_quota_caps")?.value;
  const fallback = {
    day: { max_calls: null, max_tokens: null, max_cost: null },
    month: { max_calls: null, max_tokens: null, max_cost: null },
  };
  let caps: {
    day: GatewayPolicySnapshot["day"];
    month: GatewayPolicySnapshot["month"];
  };
  try {
    const parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
    const value = typeof parsed === "string" ? JSON.parse(parsed) : parsed;
    caps = value ?? fallback;
  } catch {
    caps = fallback;
  }
  return {
    // 旧设置没有 revision 概念：迁移起点固定为 0，导入后由 Gateway 递增。
    revision: 0,
    day: caps.day ?? fallback.day,
    month: caps.month ?? fallback.month,
    updated_at: new Date().toISOString(),
  };
}

/**
 * 把旧 Core 政策导入 Gateway（维护窗口内幂等）。
 *
 * 以 operation ID `policy-import-<摘要>` 调用 Gateway `PUT /internal/policy`；
 * 重复导入命中同一 operation ID 时返回原结果，不会覆盖更新的政策。
 */
export async function importGatewayPolicySnapshot(
  snapshot: GatewayPolicySnapshot,
  actorId: string,
): Promise<{ revision: number; imported: boolean }> {
  const operationId = `policy-import-${(await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(
      JSON.stringify({ day: snapshot.day, month: snapshot.month }),
    ),
  ).then((digest) =>
    [...new Uint8Array(digest)]
      .map((byte) => byte.toString(16).padStart(2, "0"))
      .join("")
      .slice(0, 32)
  ))}`;
  const init: RequestInit = {
    method: "PUT",
    headers: {
      "X-Noj-Operation-Id": operationId,
      "X-Noj-Expected-Revision": String(snapshot.revision),
      "X-Noj-Actor-Id": actorId,
    },
    body: JSON.stringify({ day: snapshot.day, month: snapshot.month }),
  };
  try {
    const body = await request<{
      data: { revision: number; status: string };
    }>("/internal/policy", init);
    return { revision: body.data.revision, imported: true };
  } catch (error) {
    if (
      !(error instanceof LlmGatewayError) || error.code !== "gateway_timeout"
    ) {
      throw error;
    }

    // PUT 可能已经在 Gateway 提交，只是 Core 没收到响应；绝不能生成新的
    // operation ID 再写一次，必须按原 ID 查询持久结果。
    const result = await request<{
      data: {
        operation_id: string;
        status: "applied" | "rejected" | "conflict";
        revision: number;
        error_code?: string;
      };
    }>(`/internal/operations/${encodeURIComponent(operationId)}`);
    if (result.data.operation_id !== operationId) {
      throw new LlmGatewayError(502, "operation_id_mismatch");
    }
    if (result.data.status === "applied") {
      return { revision: result.data.revision, imported: true };
    }
    throw new LlmGatewayError(
      result.data.status === "conflict" ? 409 : 502,
      result.data.error_code ?? "policy_operation_failed",
    );
  }
}

/** 读取 Gateway 当前政策（核对导入结果）。 */
export async function readGatewayPolicy(): Promise<GatewayPolicySnapshot> {
  const body = await request<{ data: GatewayPolicySnapshot }>(
    "/internal/policy",
  );
  return body.data;
}
