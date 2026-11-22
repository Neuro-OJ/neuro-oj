export interface DomainLlmProvider {
  id: string;
  domain_id: string;
  name: string;
  base_url: string;
  api_key_masked: string;
  enabled: boolean;
  cost_per_1k_tokens: number;
  revision: number;
  rpm_limit: number;
  tpm_limit: number;
}
export interface DomainLlmSettings {
  domain_id: string;
  provider_id: string | null;
  model: string | null;
  revision: number;
}
export interface DomainLlmModelAlias {
  domain_id: string;
  alias: string;
  provider_id: string;
  model: string;
  description: string;
  revision: number;
  problem_count: number;
}
export interface DomainLlmQuota {
  id: string;
  revision: number;
  scope_type: 'domain' | 'user' | 'problem' | 'user_problem';
  scope_id: string;
  window_type: 'day' | 'month';
  max_calls: number | null;
  max_tokens: number | null;
  max_cost: number | null;
}
export type DomainLlmQuotaCaps = Record<'day' | 'month', Pick<DomainLlmQuota, 'max_calls' | 'max_tokens' | 'max_cost'>>;
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
      api.put<{ data: DomainLlmSettings }>(`${path(slug)}/settings`, { provider_id, model }, {
        headers: { 'If-Match': String(revision) },
      }),
    providers: (slug: string) => api.get<{ data: DomainLlmProvider[] }>(`${path(slug)}/providers`, { silent: true }),
    aliases: (slug: string) =>
      api.get<{ data: DomainLlmModelAlias[] }>(`${path(slug)}/model-aliases`, { silent: true }),
    saveAlias: (
      slug: string,
      alias: string,
      body: Pick<DomainLlmModelAlias, 'provider_id' | 'model' | 'description'>,
      revision: number,
    ) =>
      api.put(`${path(slug)}/model-aliases/${encodeURIComponent(alias)}`, body, {
        headers: { 'If-Match': String(revision) },
        silent: true,
      }),
    deleteAlias: (slug: string, alias: string, revision: number, force: boolean) =>
      api.delete(`${path(slug)}/model-aliases/${encodeURIComponent(alias)}`, {
        query: { force },
        headers: { 'If-Match': String(revision) },
        silent: true,
      }),
    testProvider: (slug: string, id: string, model: string) =>
      api.post<{ data: { status: 'ok' | 'failed'; model: string; latency_ms: number; message?: string } }>(
        `${path(slug)}/providers/${encodeURIComponent(id)}/test`,
        { model },
        { silent: true },
      ),
    provider: (
      slug: string,
      body: {
        name: string;
        base_url: string;
        api_key: string;
        cost_per_1k_tokens: number;
        enabled: boolean;
        rpm_limit: number;
        tpm_limit: number;
      },
    ) => api.post(`${path(slug)}/providers`, body, { headers: { 'If-Match': '0' }, silent: true }),
    updateProvider: (
      slug: string,
      id: string,
      body: Partial<
        {
          name: string;
          base_url: string;
          api_key: string;
          cost_per_1k_tokens: number;
          enabled: boolean;
          rpm_limit: number;
          tpm_limit: number;
        }
      >,
      revision: number,
    ) =>
      api.put(`${path(slug)}/providers/${encodeURIComponent(id)}`, body, {
        headers: { 'If-Match': String(revision) },
        silent: true,
      }),
    quotas: (slug: string) =>
      api.get<{ data: DomainLlmQuota[]; caps: DomainLlmQuotaCaps }>(`${path(slug)}/quotas`, { silent: true }),
    saveQuota: (slug: string, body: Omit<DomainLlmQuota, 'id' | 'revision'> & { id?: string }, revision: number) =>
      api.post<{ data: { id: string; revision: number } }>(`${path(slug)}/quotas`, body, {
        headers: { 'If-Match': String(revision) },
        silent: true,
      }),
    usage: (slug: string, query: { page: number; provider_id?: string; user_id?: string; problem_id?: string }) =>
      api.get<{ data: DomainLlmUsage[] }>(`${path(slug)}/usage`, { query: { ...query, limit: 30 }, silent: true }),
  };
}
