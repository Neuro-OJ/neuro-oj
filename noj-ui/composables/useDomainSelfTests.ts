import type { DomainProblemReference } from '~/utils/domain-problems';
import type { PolledSelfTest } from './useSelfTestPolling';
import type { AssignmentSubmissionOrigin } from '~/utils/education';
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
/** 自测只用使用域入口，正式提交和作业进度不受自测影响。 */
export function useDomainSelfTests() {
  const { api } = useApi();
  const path = (slug: string, id: string) =>
    `/api/v1/domains/${encodeURIComponent(slug)}/self-tests/${encodeURIComponent(id)}`;
  return {
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
