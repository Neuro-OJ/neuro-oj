import type { DomainProblemReference } from '~/utils/domain-problems';
import type { PolledSelfTest } from './useSelfTestPolling';
import type { AssignmentSubmissionOrigin } from '~/utils/education';
import type { Pagination } from './useContests';
export interface DomainSelfTest extends PolledSelfTest {
  domain_id: string;
  reference: DomainProblemReference;
  resource_available: boolean;
  version_id: string;
  code: string | null;
  output_truncated?: boolean | null;
}
export interface DomainSelfTestCase {
  id: string;
  input: string;
  expected_output?: string;
}
export type DomainSelfTestSummary = Pick<
  DomainSelfTest,
  'id' | 'created_at' | 'language' | 'version_id' | 'status' | 'result_status' | 'score' | 'domain_id'
>;
/** 自测只用使用域入口，正式提交和作业进度不受自测影响。 */
export function useDomainSelfTests() {
  const { api } = useApi();
  const path = (slug: string, id: string) =>
    `/api/v1/domains/${encodeURIComponent(slug)}/self-tests/${encodeURIComponent(id)}`;
  return {
    list: (slug: string, reference: string, page = 1) =>
      api.get<{ data: DomainSelfTestSummary[]; pagination: Pagination }>(
        `/api/v1/domains/${encodeURIComponent(slug)}/problems/${encodeURIComponent(reference)}/self-tests`,
        { query: { page, limit: 30 }, silent: true },
      ),
    create: (
      slug: string,
      reference: string,
      input:
        & { version_id: string; language: string; code: string; cases?: DomainSelfTestCase[] }
        & Partial<AssignmentSubmissionOrigin>,
    ) =>
      api.post<{ data: { id: string; status: string } }>(
        `/api/v1/domains/${encodeURIComponent(slug)}/problems/${encodeURIComponent(reference)}/self-tests`,
        input,
      ),
    detail: (slug: string, id: string) => api.get<{ data: DomainSelfTest }>(path(slug, id), { silent: true }),
    cancel: (slug: string, id: string) =>
      api.post<{ data: { cancel_requested: true } }>(`${path(slug, id)}/cancel`, {}),
  };
}
