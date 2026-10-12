import type { Contest, ContestPayload, ContestProblem, KaggleRankingRow, Pagination } from './useContests';
export interface DomainContest extends Contest {
  domain_id: string;
  revision: number;
  can_manage?: boolean;
}
export interface DomainContestRanking {
  data: KaggleRankingRow[];
  result_type?: 'official';
  view?: 'live' | 'frozen' | 'official';
  snapshot?: { version: number; note: string; created_at: string };
  frozen?: boolean;
}
/** 域比赛的授权和赛制裁剪由后端统一决定。 */
export function useDomainContests() {
  const { api } = useApi();
  const path = (slug: string, id?: string) =>
    `/api/v1/domains/${encodeURIComponent(slug)}/contests${id ? `/${encodeURIComponent(id)}` : ''}`;
  return {
    list: (slug: string, page: number) =>
      api.get<{ data: DomainContest[]; pagination: Pagination }>(path(slug), {
        query: { page, per_page: 20 },
        silent: true,
      }),
    detail: (slug: string, id: string) => api.get<{ data: DomainContest }>(path(slug, id), { silent: true }),
    create: (slug: string, body: ContestPayload) => api.post<{ data: DomainContest }>(path(slug), body),
    update: (slug: string, id: string, body: Partial<ContestPayload>, revision: number) =>
      api.patch<{ data: DomainContest }>(path(slug, id), body, { headers: { 'If-Match': String(revision) } }),
    register: (slug: string, id: string, password: string) => api.post(`${path(slug, id)}/register`, { password }),
    problems: (slug: string, id: string) =>
      api.get<{ data: ContestProblem[] }>(`${path(slug, id)}/problems`, { silent: true }),
    ranking: (slug: string, id: string, official = false) =>
      api.get<DomainContestRanking>(`${path(slug, id)}/${official ? 'final-ranking' : 'ranking'}`, { silent: true }),
    settlement: (slug: string, id: string) =>
      api.get<{ data: { ready: boolean; pending_count: number; failed_count: number; [key: string]: unknown } }>(
        `${path(slug, id)}/settlement`,
        { silent: true },
      ),
    snapshots: (slug: string, id: string) =>
      api.get<{ data: Array<{ id: string; version: number; note: string; created_at: string }> }>(
        `${path(slug, id)}/snapshots`,
        { silent: true },
      ),
    publish: (slug: string, id: string, note: string, allow_failed: boolean) =>
      api.post(`${path(slug, id)}/publish-ranking`, { note, allow_failed }),
  };
}
