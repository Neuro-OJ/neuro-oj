import type { OwnSubmissionHistory, OwnSubmissionKind } from '~/utils/own-submissions';
/** 统一本人接口不接受代理用户 ID，也不继承导航偏好域。 */
export function useOwnSubmissions() {
  const { api } = useApi();
  return {
    detail: (kind: OwnSubmissionKind, id: string) =>
      api.get<{ data: OwnSubmissionHistory }>(
        `/api/v1/me/submissions/${encodeURIComponent(kind)}/${encodeURIComponent(id)}`,
        { silent: true },
      ),
  };
}
