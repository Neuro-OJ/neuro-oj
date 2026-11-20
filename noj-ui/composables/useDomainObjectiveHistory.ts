import type { OwnSubmissionHistory } from '~/utils/own-submissions';
/** 当前域本人客观历史，不借全账号目录绕过进入限制。 */
export function useDomainObjectiveHistory() {
  const { api } = useApi(),
    path = (slug: string) => `/api/v1/domains/${encodeURIComponent(slug)}/objective-submissions`;
  return {
    list: (slug: string, page: number, problem_id?: string) =>
      api.get<{ data: OwnSubmissionHistory[]; total: number }>(path(slug), {
        query: { page, per_page: 30, ...(problem_id ? { problem_id } : {}) },
        silent: true,
      }),
    detail: (slug: string, id: string) =>
      api.get<{ data: OwnSubmissionHistory }>(`${path(slug)}/${encodeURIComponent(id)}`, { silent: true }),
  };
}
