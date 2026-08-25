/**
 * noj-core → noj-llm-gateway 管理 API 客户端。
 *
 * core 不直接接触上游 Provider Key；Provider 配置、用量查询、配额配置
 * 统一通过 gateway 内部管理 API 完成。
 */

const GATEWAY_URL = Deno.env.get("NOJ_LLM_GATEWAY_URL") ??
  "http://localhost:8001";
const SERVICE_TOKEN = Deno.env.get("NOJ_LLM_SERVICE_TOKEN") ?? "";

export interface LlmProviderInput {
  name: string;
  base_url: string;
  model: string;
  api_key: string;
  cost_per_1k_tokens?: number;
  enabled?: boolean;
}

export interface LlmProviderView {
  id: string;
  name: string;
  base_url: string;
  model: string;
  cost_per_1k_tokens: number;
  api_key_masked: string;
  enabled: boolean;
  created_at: string;
  updated_at: string;
}

export interface LlmUsageQuery {
  submission_id?: string;
  user_id?: string;
  problem_id?: string;
  provider_id?: string;
  status?: string;
  start_time?: string;
  end_time?: string;
  limit?: number;
  page?: number;
}

export interface LlmQuotaInput {
  id?: string;
  scope_type: "user" | "problem" | "global";
  scope_id?: string;
  window_type?: "day" | "month";
  max_calls?: number;
  max_tokens?: number;
  max_cost?: number;
}

async function request<T>(
  path: string,
  init?: RequestInit,
): Promise<T> {
  if (!SERVICE_TOKEN) {
    throw new Error("NOJ_LLM_SERVICE_TOKEN 未配置，无法访问 LLM Gateway");
  }
  const res = await fetch(`${GATEWAY_URL}${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${SERVICE_TOKEN}`,
      ...(init?.headers ?? {}),
    },
  });
  const body = await res.json().catch(() => null);
  if (!res.ok) {
    throw new Error(
      body?.error ?? `LLM Gateway 请求失败: ${res.status}`,
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
