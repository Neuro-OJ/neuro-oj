import type { RankingRow, RankingsResponse } from './useRankings';
import type { SearchItem } from '~/utils/search-types';
/** 域榜和搜索从当前 URL 指定的使用域读取，不聚合其他私有域。 */
export function useDomainQuery() {
  const { api } = useApi(), root = (slug: string) => `/api/v1/domains/${encodeURIComponent(slug)}`;
  return {
    rankings: (slug: string, page: number) =>
      api.get<RankingsResponse>(`${root(slug)}/rankings`, { query: { page, limit: 50 }, silent: true }),
    mine: (slug: string) => api.get<{ data: RankingRow | null }>(`${root(slug)}/rankings/me`, { silent: true }),
    search: (slug: string, q: string, type: 'problem' | 'contest' | 'submission' | 'announcement', page: number) =>
      api.get<{ data: { items: SearchItem[]; has_more: boolean; page: number; per_page: number; took_ms: number } }>(
        `${root(slug)}/search`,
        { query: { q, type, page, per_page: 20 }, silent: true },
      ),
  };
}
