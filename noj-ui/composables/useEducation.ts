import { useApi } from '~/composables/useApi';
import type {
  Assignment,
  AssignmentFeedback,
  AssignmentHelp,
  Classroom,
  ClassroomDetail,
  LineAnnotation,
  MatrixData,
  MyProgress,
  TeachingPage,
  TeachingText,
} from '~/utils/education';

/** 教学接口始终显式指定使用域和资源，页面权限仅控制展示，服务端再次授权。 */
export function useEducationApi() {
  const { api } = useApi();
  const root = (slug: string) => `/api/v1/domains/${encodeURIComponent(slug)}`;
  const classroom = (slug: string, id: string) => `${root(slug)}/classrooms/${encodeURIComponent(id)}`;
  const task = (slug: string, id: string) => `${root(slug)}/assignments/${encodeURIComponent(id)}`;
  const source = (slug: string, classId: string, id: string) =>
    `${classroom(slug, classId)}/submissions/submission/${encodeURIComponent(id)}`;
  const idempotent = (key: string) => ({ headers: { 'Idempotency-Key': key } });
  const revision = (value: number) => ({ headers: { 'If-Match': String(value) } });
  return {
    classrooms: (slug: string, page = 1) =>
      api.get<{ data: Classroom[] }>(`${root(slug)}/classrooms`, { query: { page }, silent: true }),
    classroom: (slug: string, id: string) => api.get<{ data: ClassroomDetail }>(classroom(slug, id), { silent: true }),
    createClassroom: (slug: string, input: { name: string; description: string; stage_tag: string }) =>
      api.post<{ data: Classroom }>(`${root(slug)}/classrooms`, input),
    assignments: (slug: string, id: string, page = 1) =>
      api.get<{ data: Assignment[] }>(`${classroom(slug, id)}/assignments`, { query: { page }, silent: true }),
    assignment: (slug: string, id: string) => api.get<{ data: Assignment }>(task(slug, id), { silent: true }),
    matrix: (slug: string, id: string, query: Record<string, string | number | undefined>) =>
      api.get<{ data: MatrixData }>(`${task(slug, id)}/matrix`, { query, silent: true }),
    progress: (slug: string, id: string, scope: 'on_time' | 'current') =>
      api.get<{ data: MyProgress }>(`${task(slug, id)}/progress`, { query: { scope }, silent: true }),
    csv: (slug: string, id: string, query: Record<string, string | number | undefined>) =>
      api.get<string>(`${task(slug, id)}/matrix.csv`, { query, responseType: 'text' }),
    files: (slug: string, classId: string, id: string) =>
      api.get<{ data: { submission_id: string; files: { file_name: string; size_bytes: number }[] } }>(
        `${source(slug, classId, id)}/files`,
        { silent: true },
      ),
    text: (slug: string, classId: string, id: string, file: string) =>
      api.get<{ data: TeachingText }>(`${source(slug, classId, id)}/text`, { query: { file }, silent: true }),
    annotations: (slug: string, classId: string, id: string, page = 1) =>
      api.get<{ data: TeachingPage<LineAnnotation> }>(`${source(slug, classId, id)}/annotations`, {
        query: { page },
        silent: true,
      }),
    annotate: (
      slug: string,
      classId: string,
      id: string,
      input: { file_name: string; source_hash: string; start_line: number; end_line: number; body: string },
      key: string,
    ) => api.post<{ data: LineAnnotation }>(`${source(slug, classId, id)}/annotations`, input, idempotent(key)),
    feedback: (slug: string, id: string, page = 1) =>
      api.get<{ data: TeachingPage<AssignmentFeedback> }>(`${task(slug, id)}/feedback`, {
        query: { page },
        silent: true,
      }),
    addFeedback: (slug: string, id: string, body: string, target: string | null, key: string) =>
      api.post(`${task(slug, id)}/feedback`, { body, target_user_id: target }, idempotent(key)),
    help: (slug: string, id: string, page = 1) =>
      api.get<{ data: TeachingPage<AssignmentHelp> }>(`${task(slug, id)}/help-requests`, {
        query: { page },
        silent: true,
      }),
    helpDetail: (slug: string, id: string, helpId: string, page = 1) =>
      api.get<{ data: AssignmentHelp }>(`${task(slug, id)}/help-requests/${encodeURIComponent(helpId)}`, {
        query: { page },
        silent: true,
      }),
    ask: (slug: string, id: string, body: string, key: string) =>
      api.post(`${task(slug, id)}/help-requests`, { body }, idempotent(key)),
    reply: (slug: string, id: string, helpId: string, body: string, key: string) =>
      api.post(`${task(slug, id)}/help-requests/${encodeURIComponent(helpId)}/replies`, { body }, idempotent(key)),
    resolve: (slug: string, id: string, helpId: string, current: number) =>
      api.patch(
        `${task(slug, id)}/help-requests/${encodeURIComponent(helpId)}`,
        { state: 'resolved' },
        revision(current),
      ),
  };
}
