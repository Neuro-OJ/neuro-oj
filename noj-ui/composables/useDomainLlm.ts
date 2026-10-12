export interface DomainLlmProvider {
  id: string;
  domain_id: string;
  name: string;
  base_url: string;
  api_key_masked: string;
  enabled: boolean;
  cost_per_1k_tokens: number;
}
export interface DomainLlmSettings {
  domain_id: string;
  provider_id: string | null;
  model: string | null;
  revision: number;
}
export interface DomainLlmQuota {
  id: string;
  scope_type: 'domain' | 'user' | 'problem' | 'user_problem';
  scope_id: string;
  window_type: 'day' | 'month';
  max_calls: number | null;
  max_tokens: number | null;
  max_cost: number | null;
}
export interface DomainLlmUsage {
  id: string;
  user_id: string;
  problem_id: string;
  model: string;
  total_tokens: number;
  estimated_cost: number;
  status: string;
  created_at: string;
}
/** 密钥只通过表单提交，读取永远使用服务端脱敏字段。 */
export function useDomainLlm() {
  const { api } = useApi();
  const path = (slug: string) => `/api/v1/domains/${encodeURIComponent(slug)}/llm`;
  return {
    settings: (slug: string) => api.get<{ data: DomainLlmSettings }>(`${path(slug)}/settings`, { silent: true }),
    saveSettings: (slug: string, provider_id: string | null, model: string | null, revision: number) =>
      api.put(`${path(slug)}/settings`, { provider_id, model }, { headers: { 'If-Match': String(revision) } }),
    providers: (slug: string) => api.get<{ data: DomainLlmProvider[] }>(`${path(slug)}/providers`, { silent: true }),
    provider: (
      slug: string,
      body: { name: string; base_url: string; api_key: string; cost_per_1k_tokens: number; enabled: boolean },
    ) => api.post(`${path(slug)}/providers`, body),
    updateProvider: (
      slug: string,
      id: string,
      body: Partial<{ name: string; base_url: string; api_key: string; cost_per_1k_tokens: number; enabled: boolean }>,
    ) => api.put(`${path(slug)}/providers/${encodeURIComponent(id)}`, body),
    quotas: (slug: string) => api.get<{ data: DomainLlmQuota[] }>(`${path(slug)}/quotas`, { silent: true }),
    saveQuota: (slug: string, body: Omit<DomainLlmQuota, 'id'> & { id?: string }) =>
      api.post(`${path(slug)}/quotas`, body),
    usage: (slug: string, query: { page: number; provider_id?: string; user_id?: string; problem_id?: string }) =>
      api.get<{ data: DomainLlmUsage[] }>(`${path(slug)}/usage`, { query: { ...query, limit: 30 }, silent: true }),
  };
}
