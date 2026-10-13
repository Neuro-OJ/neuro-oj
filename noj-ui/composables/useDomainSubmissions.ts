import type { DomainProblemReference } from '~/utils/domain-problems';
import type { Pagination } from './useContests';

export interface DomainSubmission {
  id: string;
  user_id?: string;
  contest_id?: string | null;
  submitted_version_id?: string | null;
  is_latest?: boolean;
  domain_id: string;
  reference: DomainProblemReference;
  resource_available: boolean;
  result_visibility?: 'hidden' | 'summary' | 'cases';
  created_at: string;
  language?: string;
  status?: string;
  code?: string | null;
  submitted_version?: number | null;
  result?: {
    status: string;
    score?: number;
    time_ms?: number | null;
    memory_kb?: number | null;
    details?: unknown;
    output?: string | null;
  } | null;
  problem?: { title: string };
  attempts?: Array<
    {
      attempt_id: string;
      sequence: number;
      version: number | null;
      state: string;
      result_kind: string | null;
      score: number;
    }
  >;
}

/** 提交页使用路径域；无权限或撤销授权时不重试默认域接口。 */
export function useDomainSubmissions() {
  const { api } = useApi();
  const path = (slug: string) => `/api/v1/domains/${encodeURIComponent(slug)}/submissions`;
  return {
    list: (slug: string, page: number, query: { problem_id?: string; contest_id?: string } = {}) =>
      api.get<{ data: DomainSubmission[]; pagination: Pagination }>(path(slug), {
        query: { page, per_page: 30, ...query },
        silent: true,
      }),
    detail: (slug: string, id: string) =>
      api.get<{ data: DomainSubmission }>(`${path(slug)}/${encodeURIComponent(id)}`, { silent: true }),
  };
}
