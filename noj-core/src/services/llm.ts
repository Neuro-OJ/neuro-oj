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
  enabled?: boolean;
}

export interface LlmProviderView {
  id: string;
  name: string;
  base_url: string;
  model: string;
  api_key_masked: string;
  enabled: boolean;
  created_at: string;
  updated_at: string;
}

export interface LlmUsageQuery {
  submission_id?: string;
  user_id?: string;
  problem_id?: string;
  limit?: number;
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

export async function listLlmProviders(): Promise<LlmProviderView[]> {
  const body = await request<{ data: LlmProviderView[] }>(
    "/internal/providers",
  );
  return body.data;
}

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

export async function queryLlmUsage(
  query: LlmUsageQuery,
): Promise<unknown[]> {
  const params = new URLSearchParams();
  if (query.submission_id) params.set("submission_id", query.submission_id);
  if (query.user_id) params.set("user_id", query.user_id);
  if (query.problem_id) params.set("problem_id", query.problem_id);
  if (query.limit !== undefined) params.set("limit", String(query.limit));
  const qs = params.toString();
  const body = await request<{ data: unknown[] }>(
    `/internal/usage${qs ? `?${qs}` : ""}`,
  );
  return body.data;
}

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
