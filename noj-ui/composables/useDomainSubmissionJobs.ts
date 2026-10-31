import type { Pagination } from '~/utils/contest-types';
import type {
  DomainSubmissionJob,
  DomainSubmissionJobItem,
  DomainSubmissionJobReceipt,
  DomainSubmissionJobRequest,
} from '~/utils/domain-submission-jobs';
/** 任务所属域来自当前路径，受理与读取不回退到旧全局接口。 */
export function useDomainSubmissionJobs() {
  const { api } = useApi();
  const path = (slug: string, id?: string) =>
    `/api/v1/domains/${encodeURIComponent(slug)}/submission-jobs${id ? `/${encodeURIComponent(id)}` : ''}`;
  return {
    create: (slug: string, input: DomainSubmissionJobRequest, key: string) =>
      api.post<{ data: DomainSubmissionJobReceipt }>(path(slug), input, {
        headers: { 'Idempotency-Key': key },
        silent: true,
      }),
    detail: (slug: string, id: string) => api.get<{ data: DomainSubmissionJob }>(path(slug, id), { silent: true }),
    items: (slug: string, id: string, page: number) =>
      api.get<{ data: DomainSubmissionJobItem[]; pagination: Pagination }>(`${path(slug, id)}/items`, {
        query: { page, per_page: 20 },
        silent: true,
      }),
    cancel: (slug: string, id: string) =>
      api.post<{ data: { id: string; domain_id: string; status: string; cancel_requested: true } }>(
        `${path(slug, id)}/cancel`,
        {},
        { silent: true },
      ),
  };
}
