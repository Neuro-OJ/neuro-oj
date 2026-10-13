import type { DomainProblemDetail, DomainProblemSummary } from '~/utils/domain-problems';
import { domainProblemApiPath } from '~/utils/domain-problems';
import type { SubmitResult } from './useObjective';
import type { AssignmentSubmissionOrigin } from '~/utils/education';

/** 域内作答只使用明确域 API；失败不切换到默认域。 */
export function useDomainProblems() {
  const { api } = useApi();
  return {
    list: (slug: string, page: number, keyword = '') =>
      api.get<{ items: DomainProblemSummary[]; total: number; page: number; limit: number }>(
        domainProblemApiPath(slug),
        {
          query: { page, limit: 30, keyword },
          silent: true,
        },
      ),
    detail: (slug: string, reference: string) =>
      api.get<DomainProblemDetail>(domainProblemApiPath(slug, reference), { silent: true }),
    template: (slug: string, reference: string, version_id: string) =>
      api.get<{ data: { version_id: string; template_content: string | null } }>(
        `${domainProblemApiPath(slug, reference)}/template`,
        { query: { version_id }, silent: true },
      ),
    versions: (slug: string, reference: string, page = 1) =>
      api.get<{
        items: Array<{ version_id: string; version: number; change_note: string | null; published_at: string }>;
        total: number;
        page: number;
        limit: number;
        answer_version_id: string;
      }>(`${domainProblemApiPath(slug, reference)}/versions`, { query: { page, limit: 20 }, silent: true }),
    code: (
      slug: string,
      problem_ref: string,
      version_id: string,
      language: string,
      code: string,
      origin?: AssignmentSubmissionOrigin,
    ) =>
      api.post<{ data: { id: string; status: string } }>(`/api/v1/domains/${encodeURIComponent(slug)}/submissions`, {
        problem_ref,
        version_id,
        language,
        code,
        ...origin,
      }),
    artifact: (
      slug: string,
      problem_ref: string,
      version_id: string,
      file: File,
      origin?: AssignmentSubmissionOrigin,
    ) => {
      const body = new FormData();
      body.set('problem_ref', problem_ref);
      body.set('version_id', version_id);
      body.set('file', file);
      return api.post<{ data: { id: string; status: string } }>(
        `/api/v1/domains/${encodeURIComponent(slug)}/submissions`,
        body,
        { query: origin },
      );
    },
    objective: (
      slug: string,
      reference: string,
      version_id: string,
      answers: Record<string, (string | boolean)[]>,
      origin?: AssignmentSubmissionOrigin,
    ) =>
      api.post<{ data: SubmitResult }>(`${domainProblemApiPath(slug, reference)}/objective-submissions`, {
        version_id,
        answers,
        ...origin,
      }),
  };
}
