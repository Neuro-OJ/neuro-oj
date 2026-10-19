import type { WorkspaceDetail } from './workspace.ts';
import type { AuthUser } from './auth-user.ts';

export type BffViewKind = 'home' | 'classroom' | 'assignment' | 'training';
export type BffSectionName =
  | 'problemSummaries'
  | 'training'
  | 'workspace'
  | 'banStatus'
  | 'instanceNavigation'
  | 'announcementBanner'
  | 'userSpaces'
  | 'messageUnread'
  | 'annotationInbox'
  | 'draftRoster'
  | 'draftTraining'
  | 'siteMeta'
  | 'communityConfig'
  | 'communityUnread'
  | 'educationNotifications'
  | 'carousel'
  | 'announcements'
  | 'randomProblems'
  | 'activity'
  | 'checkin'
  | 'dashboard'
  | 'feed'
  | 'classroom'
  | 'assignments'
  | 'assignment'
  | 'matrix'
  | 'progress'
  | 'feedback'
  | 'help'
  | 'helpDetail'
  | 'focusedFeedback'
  | 'history';

export type BffSection<T = unknown> =
  | { data: T; error?: never }
  | { data?: never; error: { statusCode: number; data: { error: string; code?: string; request_id?: string } } };

/** 视图接口统一信封；模块 data 保留对应 Core API 的响应契约。 */
export interface BffEnvelope {
  kind: BffViewKind;
  viewer: AuthUser | null;
  workspace: WorkspaceDetail;
  sections: Partial<Record<BffSectionName, BffSection>>;
}

export interface BffSnapshot {
  path: string;
  actorId: string | null;
  envelope: BffEnvelope;
}

/** 精确匹配首批页面，其他页面不改变数据加载方式。 */
export function bffViewRoute(path: string) {
  const match = /^\/d\/([^/]+)(?:\/(classrooms|assignments|trainings)\/([^/]+))?\/?$/.exec(path);
  if (!match) return null;
  const kind: BffViewKind = !match[2]
    ? 'home'
    : match[2] === 'classrooms'
    ? 'classroom'
    : match[2] === 'trainings'
    ? 'training'
    : 'assignment';
  const root = `/api/bff/v1/domains/${match[1]}`;
  return {
    kind,
    slug: match[1],
    endpoint: kind === 'home' ? `${root}/home` : `${root}/${match[2]}/${match[3]}/overview`,
  };
}

/** 快照只属于当前 URL 和已验证账号，不能因同一布局而跨域复用。 */
export function bffSnapshotMatches(snapshot: BffSnapshot | null, path: string, actorId: string | null) {
  return !!snapshot && snapshot.path === path.split('#')[0] && snapshot.actorId === actorId;
}
