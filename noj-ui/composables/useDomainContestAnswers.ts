import type { ContestProblem } from '~/utils/contest-types';
import type { ObjectiveQuestion, SubmitResult } from './useObjective';

/** 比赛作答使用比赛固定版本独立入口，不将 contest_id 注入普通题库提交。 */
export function useDomainContestAnswers() {
  const { api } = useApi();
  const path = (slug: string, contestId: string, label: string) =>
    `/api/v1/domains/${encodeURIComponent(slug)}/contests/${encodeURIComponent(contestId)}/problems/${
      encodeURIComponent(label)
    }`;
  return {
    problem: (slug: string, contestId: string, label: string) =>
      api.get<{ data: ContestProblem }>(path(slug, contestId, label), { silent: true }),
    ui: (slug: string, contestId: string, label: string) =>
      api.get<{ data: { html: string } }>(`${path(slug, contestId, label)}/ui`, { silent: true }),
    questions: (slug: string, contestId: string, label: string) =>
      api.get<{ data: ObjectiveQuestion[]; version_id: string; version: number }>(
        `${path(slug, contestId, label)}/objective-questions`,
        { silent: true },
      ),
    template: (slug: string, contestId: string, label: string) =>
      api.get<{ data: { content: string | null; language: string }; version_id: string }>(
        `${path(slug, contestId, label)}/template`,
        { silent: true },
      ),
    code: (slug: string, contestId: string, label: string, version_id: string, language: string, code: string) =>
      api.post<{ data: { id: string; status: string } }>(`${path(slug, contestId, label)}/submissions`, {
        version_id,
        language,
        code,
      }),
    artifact: (slug: string, contestId: string, label: string, version_id: string, file: File) => {
      const body = new FormData();
      body.set('version_id', version_id);
      body.set('file', file);
      return api.post<{ data: { id: string; status: string } }>(`${path(slug, contestId, label)}/submissions`, body);
    },
    objective: (
      slug: string,
      contestId: string,
      label: string,
      version_id: string,
      answers: Record<string, (string | boolean)[]>,
    ) =>
      api.post<{ data: SubmitResult }>(`${path(slug, contestId, label)}/objective-submissions`, {
        version_id,
        answers,
      }),
  };
}
