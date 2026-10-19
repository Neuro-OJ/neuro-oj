import type { AnnotationDetail, AnnotationPage, AnnotationSource, AnnotationTarget } from '~/utils/annotations';
import type { UserSummary } from '~/utils/user-identity';

/** 所有批注请求显式携带使用域，组件不按每位作者加载资料。 */
export function useAnnotationsApi() {
  const { api } = useApi();
  const root = (slug: string) => `/api/v1/domains/${encodeURIComponent(slug)}/annotations`;
  const thread = (slug: string, id: string) => `${root(slug)}/${encodeURIComponent(id)}`;
  const revision = (value: number) => ({ headers: { 'If-Match': String(value) }, silent: true });
  const keyed = (key: string) => ({ headers: { 'Idempotency-Key': key }, silent: true });
  return {
    files: (slug: string, id: string) =>
      api.get<{ data: { submission_id: string; files: Array<{ file_name: string; size_bytes: number }> } }>(
        `${root(slug)}/submissions/${encodeURIComponent(id)}/files`,
        { silent: true },
      ),
    list: (slug: string, target?: AnnotationTarget, shared = false, cursor?: string, teachingOnly = false) =>
      api.get<AnnotationPage>(root(slug), {
        query: {
          target: target ? JSON.stringify(target) : undefined,
          shared: shared ? '1' : undefined,
          cursor,
          visibility: teachingOnly ? 'teaching' : undefined,
        },
        silent: true,
      }),
    source: (slug: string, target: AnnotationTarget) =>
      api.post<{ data: AnnotationSource }>(`${root(slug)}/source`, { target }, { silent: true }),
    original: (slug: string, id: string) =>
      api.get<{ data: AnnotationSource }>(`${thread(slug, id)}/source`, { silent: true }),
    detail: (slug: string, id: string, page = 1) =>
      api.get<{ data: AnnotationDetail }>(thread(slug, id), { query: { page }, silent: true }),
    create: (
      slug: string,
      value: {
        target: AnnotationTarget;
        content_hash: string;
        anchor: { block_id: string; start: number; end: number };
        body: string;
        visibility: 'private' | 'teaching';
        student_id?: string;
      },
      key: string,
    ) => api.post<{ data: AnnotationDetail }>(root(slug), value, keyed(key)),
    share: (slug: string, id: string, current: number, key: string, student_id?: string) =>
      api.post<{ data: AnnotationDetail }>(`${thread(slug, id)}/share`, { student_id }, {
        ...revision(current),
        headers: { ...revision(current).headers, ...keyed(key).headers },
      }),
    reply: (slug: string, id: string, body: string, key: string) =>
      api.post<{ data: AnnotationDetail }>(`${thread(slug, id)}/replies`, { body }, keyed(key)),
    edit: (slug: string, id: string, messageId: string, current: number, body: string) =>
      api.patch<{ data: AnnotationDetail }>(
        `${thread(slug, id)}/messages/${encodeURIComponent(messageId)}`,
        { body },
        revision(current),
      ),
    withdrawMessage: (slug: string, id: string, messageId: string, current: number) =>
      api.patch<{ data: AnnotationDetail }>(`${thread(slug, id)}/messages/${encodeURIComponent(messageId)}`, {
        withdraw: true,
      }, revision(current)),
    state: (slug: string, id: string, current: number, state: 'open' | 'resolved') =>
      api.patch<{ data: AnnotationDetail }>(thread(slug, id), { state }, revision(current)),
    withdraw: (slug: string, id: string, current: number, reason?: string) =>
      api.patch(thread(slug, id), { withdraw: true, ...(reason ? { reason } : {}) }, revision(current)),
    recipients: (slug: string, target: AnnotationTarget, keyword: string) =>
      api.post<{ data: UserSummary[] }>(`${root(slug)}/recipients`, { target, keyword }, { silent: true }),
    inbox: (slug: string, cursor?: string) =>
      api.get<
        {
          actor_id: string;
          domain_slug: string;
          data: { id: string; thread_id: string; created_at: string; read_at: string | null }[];
          unread_count: number;
          next_cursor: string | null;
        }
      >(`${root(slug)}/inbox`, { query: { cursor }, silent: true }),
    read: (slug: string, id: string) => api.post(`${thread(slug, id)}/read`, {}, { silent: true }),
  };
}
