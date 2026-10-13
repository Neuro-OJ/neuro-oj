import { useApi } from '~/composables/useApi';
import type { AssignmentHistoryEntry, TeachingNotice } from '~/utils/education-notifications';
import type {
  ClassroomImportPreview,
  ClassroomImportResult,
  ClassroomJoinRequest,
  ClassroomJoinView,
} from '~/utils/education-enrollment';
import type {
  Assignment,
  AssignmentDetail,
  AssignmentDraftInput,
  AssignmentFeedback,
  AssignmentHelp,
  Classroom,
  ClassroomDetail,
  ClassroomMember,
  LineAnnotation,
  MatrixData,
  MyProgress,
  TeachingCapability,
  TeachingPage,
  TeachingProblemOption,
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
    assignment: (slug: string, id: string) => api.get<{ data: AssignmentDetail }>(task(slug, id), { silent: true }),
    createAssignment: (slug: string, id: string, input: AssignmentDraftInput) =>
      api.post<{ data: Assignment }>(`${classroom(slug, id)}/assignments`, input),
    saveAssignment: (slug: string, id: string, input: AssignmentDraftInput, current: number) =>
      api.patch<{ data: Assignment }>(task(slug, id), input, revision(current)),
    publish: (slug: string, id: string, current: number, key: string) =>
      api.post<{ data: Assignment }>(`${task(slug, id)}/publish`, {}, {
        headers: { ...revision(current).headers, ...idempotent(key).headers },
      }),
    schedule: (slug: string, id: string, current: number, publish_at: string) =>
      api.post(`${task(slug, id)}/schedule`, { publish_at }, revision(current)),
    lifecycle: (
      slug: string,
      id: string,
      current: number,
      action: 'extend' | 'end' | 'archive',
      input: { reason: string; deadline_at?: string | null },
    ) => api.post(`${task(slug, id)}/${action}`, input, revision(current)),
    copy: (
      slug: string,
      id: string,
      current: number,
      key: string,
      input: { title: string; target_student_ids?: string[]; item_ids?: string[] },
    ) =>
      api.post<{ data: Assignment }>(`${task(slug, id)}/copy`, input, {
        headers: { ...revision(current).headers, ...idempotent(key).headers },
      }),
    problems: (slug: string, page: number, keyword: string) =>
      api.get<{ items: TeachingProblemOption[]; total: number }>(`${root(slug)}/problems`, {
        query: { page, limit: 50, keyword },
        silent: true,
      }),
    problem: (slug: string, reference: string) =>
      api.get<
        {
          binding_id: string;
          reference: TeachingProblemOption['reference'];
          version: number;
          content: { title: string; kind: string };
        }
      >(`${root(slug)}/problems/${encodeURIComponent(reference)}`),
    training: (slug: string, id: string) =>
      api.get<{ data: { id: string; title: string; revision: number; items: { display_ref: string }[] } }>(
        `${root(slug)}/trainings/${encodeURIComponent(id)}`,
      ),
    members: (slug: string, id: string) =>
      api.get<{ data: ClassroomMember[] }>(`${classroom(slug, id)}/members`, { silent: true }),
    setMember: (
      slug: string,
      id: string,
      userId: string,
      role: ClassroomMember['role'],
      capabilities: TeachingCapability[],
      current: number,
    ) =>
      api.put(
        `${classroom(slug, id)}/members/${encodeURIComponent(userId)}`,
        { role, capabilities },
        revision(current),
      ),
    removeMember: (slug: string, id: string, userId: string, current: number) =>
      api.delete(`${classroom(slug, id)}/members/${encodeURIComponent(userId)}`, revision(current)),
    invite: (slug: string, id: string, email: string) =>
      api.post<{ data: { token: string; id: string; expires_at: string } }>(`${classroom(slug, id)}/invitations`, {
        email,
      }),
    invitations: (slug: string, id: string) =>
      api.get<
        { data: { id: string; email: string; used_at: string | null; revoked_at: string | null; expires_at: string }[] }
      >(`${classroom(slug, id)}/invitations`, { silent: true }),
    revokeInvitation: (slug: string, id: string, inviteId: string) =>
      api.delete(`${classroom(slug, id)}/invitations/${encodeURIComponent(inviteId)}`),
    updateClassroom: (
      slug: string,
      id: string,
      input: { name: string; description: string; stage_tag: string },
      current: number,
    ) => api.patch(`${classroom(slug, id)}`, input, revision(current)),
    archiveClassroom: (slug: string, id: string, current: number) =>
      api.post(`${classroom(slug, id)}/archive`, {}, revision(current)),
    transferClassroom: (slug: string, id: string, userId: string, current: number) =>
      api.post(`${classroom(slug, id)}/transfer`, { user_id: userId }, revision(current)),
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
    previewImport: (slug: string, id: string, csv: string, replace_pending: boolean) =>
      api.post<{ data: ClassroomImportPreview }>(`${classroom(slug, id)}/imports/preview`, { csv, replace_pending }),
    executeImport: (
      slug: string,
      id: string,
      input: { csv: string; preview_hash: string; replace_pending: boolean },
      current: number,
      key: string,
    ) =>
      api.post<{ data: ClassroomImportResult }>(`${classroom(slug, id)}/imports/execute`, input, {
        headers: { ...revision(current).headers, ...idempotent(key).headers },
      }),
    joinView: (slug: string, id: string) =>
      api.get<{ data: ClassroomJoinView }>(`${classroom(slug, id)}/join`, { silent: true }),
    requestJoin: (slug: string, id: string, reason: string) => api.post(`${classroom(slug, id)}/join`, { reason }),
    joinRequests: (slug: string, id: string, page: number, status: ClassroomJoinRequest['status']) =>
      api.get<{ data: TeachingPage<ClassroomJoinRequest> }>(`${classroom(slug, id)}/join-requests`, {
        query: { page, status },
        silent: true,
      }),
    reviewJoin: (
      slug: string,
      id: string,
      requestId: string,
      decision: 'approve' | 'reject',
      current: number,
      key: string,
    ) =>
      api.post(`${classroom(slug, id)}/join-requests/${encodeURIComponent(requestId)}/review`, { decision }, {
        headers: { ...revision(current).headers, ...idempotent(key).headers },
      }),
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
    updateAnnotation: (
      slug: string,
      classId: string,
      id: string,
      annotationId: string,
      current: number,
      input: { body?: string; withdraw?: boolean },
    ) =>
      api.patch<{ data: LineAnnotation }>(
        `${source(slug, classId, id)}/annotations/${encodeURIComponent(annotationId)}`,
        input,
        revision(current),
      ),
    feedback: (slug: string, id: string, page = 1) =>
      api.get<{ data: TeachingPage<AssignmentFeedback> }>(`${task(slug, id)}/feedback`, {
        query: { page },
        silent: true,
      }),
    feedbackDetail: (slug: string, id: string, feedbackId: string) =>
      api.get<{ data: AssignmentFeedback }>(`${task(slug, id)}/feedback/${encodeURIComponent(feedbackId)}`, {
        silent: true,
      }),
    notifications: (slug: string, page = 1) =>
      api.get<{ data: TeachingPage<TeachingNotice> & { unread: number } }>(`${root(slug)}/notifications`, {
        query: { page },
        silent: true,
      }),
    readNotification: (slug: string, id: string) =>
      api.post(`${root(slug)}/notifications/${encodeURIComponent(id)}/read`, {}),
    history: (slug: string, id: string, page = 1) =>
      api.get<{ data: TeachingPage<AssignmentHistoryEntry> }>(`${task(slug, id)}/history`, {
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
