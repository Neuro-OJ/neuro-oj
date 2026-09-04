/**
 * noj-core → noj-llm-gateway 管理 API 客户端。
 *
 * core 不直接接触上游 Provider Key；Provider 配置、用量查询、配额配置
 * 统一通过 gateway 内部管理 API 完成。
 */

const GATEWAY_URL = Deno.env.get("NOJ_LLM_GATEWAY_URL") ??
  "http://localhost:8001";
const SERVICE_TOKEN = Deno.env.get("NOJ_LLM_SERVICE_TOKEN") ?? "";

/**
 * 创建或更新 LLM Provider 的输入参数。
 */
export interface LlmProviderInput {
  /** Provider 名称 */
  name: string;
  /** Provider Base URL */
  base_url: string;
  /** 模型名 */
  model: string;
  /** API Key（仅发送给 gateway 加密存储，不会返回明文） */
  api_key: string;
  /** 每 1000 token 的成本（可选） */
  cost_per_1k_tokens?: number;
  /** 是否启用（可选） */
  enabled?: boolean;
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
  /** Provider 名称 */
  name: string;
  /** Provider Base URL */
  base_url: string;
  /** 模型名 */
  model: string;
  /** 每 1000 token 的成本 */
  cost_per_1k_tokens: number;
  /** 脱敏后的 API Key（如 `sk-****`） */
  api_key_masked: string;
  /** 是否启用 */
  enabled: boolean;
  /** 创建时间 */
  created_at: string;
  /** 更新时间 */
  updated_at: string;
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
 * LLM 配额的新增或更新输入（按 id upsert）。
 */
export interface LlmQuotaInput {
  /** 配额 ID（更新时提供；缺省为新增） */
  id?: string;
  /** 配额作用域类型 */
  scope_type: "user" | "problem" | "global";
  /** 作用域对象 ID（user/problem 时必填） */
  scope_id?: string;
  /** 配额窗口类型 */
  window_type?: "day" | "month";
  /** 最大调用次数 */
  max_calls?: number;
  /** 最大 token 数 */
  max_tokens?: number;
  /** 最大成本 */
  max_cost?: number;
}

/**
 * 向 LLM Gateway 内部管理 API 发起请求的通用封装。
 *
 * 自动拼接 GATEWAY_URL、注入 SERVICE_TOKEN 承载 Token 与 JSON 头，
 * 并将响应体解包返回。Token 未配置或 HTTP 非 2xx 时抛错。
 *
 * @param path 相对路径（如 `/internal/providers`），不含 GATEWAY_URL 前缀
 * @param init 可选的 fetch 请求配置（method/body/headers 等）
 * @returns 响应体 JSON 按类型 T 返回
 * @throws {Error} NOJ_LLM_SERVICE_TOKEN 未配置时抛出
 * @throws {LlmGatewayError} gateway 返回非 2xx 时抛出，携带状态码与错误码
 */
async function request<T>(
  path: string,
  init?: RequestInit,
): Promise<T> {
  if (!SERVICE_TOKEN) {
    throw new Error("NOJ_LLM_SERVICE_TOKEN 未配置，无法访问 LLM Gateway");
  }
  let res: Response;
  try {
    res = await fetch(`${GATEWAY_URL}${path}`, {
      ...init,
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${SERVICE_TOKEN}`,
        ...(init?.headers ?? {}),
      },
    });
  } catch {
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

/** 获取 LLM Provider 列表（Key 已由 gateway 脱敏）。 */
export async function listLlmProviders(): Promise<LlmProviderView[]> {
  const body = await request<{ data: LlmProviderView[] }>(
    "/internal/providers",
  );
  return body.data;
}

/** 获取当前用户拥有的 BYOK Provider。 */
export async function listUserLlmProviders(
  userId: string,
): Promise<LlmProviderView[]> {
  const body = await request<{ data: LlmProviderView[] }>(
    `/internal/providers?created_by=${encodeURIComponent(userId)}`,
  );
  return body.data;
}

/** 获取当前用户拥有的指定 BYOK Provider。 */
export async function getUserLlmProvider(
  userId: string,
  id: string,
): Promise<LlmProviderView> {
  const body = await request<{ data: LlmProviderView }>(
    `/internal/providers/${encodeURIComponent(id)}?created_by=${
      encodeURIComponent(userId)
    }`,
  );
  return body.data;
}

/** 创建用户 BYOK Provider；真实 Key 只发送给 gateway 内部管理端点。 */
export async function createUserLlmProvider(
  userId: string,
  input: LlmProviderInput,
): Promise<LlmProviderView> {
  const body = await request<{ data: LlmProviderView }>(
    "/internal/providers",
    {
      method: "POST",
      body: JSON.stringify({ ...input, created_by: userId }),
    },
  );
  return body.data;
}

/** 更新用户 BYOK Provider。 */
export async function updateUserLlmProvider(
  userId: string,
  id: string,
  input: Partial<LlmProviderInput>,
): Promise<LlmProviderView> {
  const body = await request<{ data: LlmProviderView }>(
    `/internal/providers/${encodeURIComponent(id)}?created_by=${
      encodeURIComponent(userId)
    }`,
    { method: "PUT", body: JSON.stringify(input) },
  );
  return body.data;
}

/** 删除用户 BYOK Provider。 */
export async function deleteUserLlmProvider(
  userId: string,
  id: string,
): Promise<void> {
  await request<unknown>(
    `/internal/providers/${encodeURIComponent(id)}?created_by=${
      encodeURIComponent(userId)
    }`,
    { method: "DELETE" },
  );
}

/** 测试用户 BYOK Provider 连通性。 */
export async function testUserLlmProvider(
  userId: string,
  id: string,
): Promise<void> {
  await request<unknown>(
    `/internal/providers/${encodeURIComponent(id)}/test?created_by=${
      encodeURIComponent(userId)
    }`,
    { method: "POST", body: "{}" },
  );
}

/** 按 ID 获取 LLM Provider 精简信息（供题目 CRUD 校验使用）。 */
export async function getLlmProviderById(
  id: string,
): Promise<LlmProviderView> {
  const body = await request<{ data: LlmProviderView }>(
    `/internal/providers/${id}`,
  );
  return body.data;
}

/** 创建 LLM Provider（API Key 由 gateway 加密存储）。 */
export async function createLlmProvider(
  input: LlmProviderInput,
): Promise<LlmProviderView> {
  const body = await request<{ data: LlmProviderView }>(
    "/internal/providers",
    {
      method: "POST",
      body: JSON.stringify(input),
    },
  );
  return body.data;
}

/** 更新 LLM Provider 的指定字段。 */
export async function updateLlmProvider(
  id: string,
  input: Partial<LlmProviderInput>,
): Promise<LlmProviderView> {
  const body = await request<{ data: LlmProviderView }>(
    `/internal/providers/${id}`,
    {
      method: "PUT",
      body: JSON.stringify(input),
    },
  );
  return body.data;
}

/** 按条件查询 LLM 用量记录（透传 gateway 分页/筛选参数）。 */
export async function queryLlmUsage(
  query: LlmUsageQuery,
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
  );
  return body.data;
}

/** 新增或更新 LLM 配额（按 id upsert）。 */
export async function upsertLlmQuota(
  input: LlmQuotaInput,
): Promise<{ id: string }> {
  const body = await request<{ data: { id: string } }>(
    "/internal/quotas",
    {
      method: "POST",
      body: JSON.stringify(input),
    },
  );
  return body.data;
}
