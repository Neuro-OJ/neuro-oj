import type { OwnSubmissionHistory, OwnSubmissionKind } from '~/utils/own-submissions';
import type { RankingsPagination } from './useRankings';
/** 统一本人接口不接受代理用户 ID，也不继承导航偏好域。 */
export function useOwnSubmissions() {
  const { api } = useApi();
  return {
    list: (page: number) =>
      api.get<{ data: OwnSubmissionHistory[]; pagination: RankingsPagination }>('/api/v1/me/submissions', {
        query: { page, per_page: 30 },
        silent: true,
      }),
    detail: (kind: OwnSubmissionKind, id: string) =>
      api.get<{ data: OwnSubmissionHistory }>(
        `/api/v1/me/submissions/${encodeURIComponent(kind)}/${encodeURIComponent(id)}`,
        { silent: true },
      ),
  };
}
