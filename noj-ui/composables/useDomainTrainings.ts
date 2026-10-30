import type { DomainTrainingDetail, DomainTrainingInput } from '~/utils/domain-trainings';
export type { DomainTrainingDetail, DomainTrainingInput } from '~/utils/domain-trainings';
const path = (slug: string, id?: string) =>
  `/api/v1/domains/${encodeURIComponent(slug)}/trainings${id ? `/${encodeURIComponent(id)}` : ''}`;
/** 题单的创建、排序和题目链接保留当前使用域。 */
export function useDomainTrainings() {
  const { api } = useApi();
  return {
    list: (slug: string, page: number, keyword = '') =>
      api.get<
        {
          items: Array<
            Pick<
              DomainTrainingDetail,
              | 'id'
              | 'title'
              | 'description'
              | 'source_domain_slug'
              | 'is_shared'
              | 'visibility'
              | 'state'
              | 'can_edit'
              | 'can_share'
              | 'revision'
            >
          >;
          page: number;
          limit: number;
          total: number;
        }
      >(path(slug), { query: { page, limit: 20, keyword }, silent: true }),
    detail: (slug: string, id: string) => api.get<{ data: DomainTrainingDetail }>(path(slug, id), { silent: true }),
    save: (slug: string, input: DomainTrainingInput, existing?: { id: string; revision: number }) =>
      existing
        ? api.patch<{ data: { id: string; revision: number } }>(path(slug, existing.id), input, {
          headers: { 'If-Match': String(existing.revision) },
        })
        : api.post<{ data: { id: string; revision: number } }>(path(slug), input),
    import: (slug: string, training_id: string) =>
      api.post<{ data: { id: string; training_id: string } }>(
        `/api/v1/domains/${encodeURIComponent(slug)}/training-bindings`,
        { training_id },
      ),
  };
}
