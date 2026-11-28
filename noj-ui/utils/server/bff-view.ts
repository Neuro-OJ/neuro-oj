import type { WorkspaceDetail } from '../domain/workspace/workspace.ts';
import type { AuthUser } from '../auth/auth-user.ts';

export type BffViewKind = 'home' | 'training';
export type BffSectionName =
  | 'training'
  | 'workspace'
  | 'banStatus'
  | 'instanceNavigation'
  | 'announcementBanner'
  | 'userSpaces'
  | 'siteMeta'
  | 'communityConfig'
  | 'accountNotifications'
  | 'announcements'
  | 'activity'
  | 'checkin'
  | 'dashboard';

export type BffJsonValue = null | boolean | number | string | BffJsonValue[] | { [key: string]: BffJsonValue };

export type BffSection =
  | { data: BffJsonValue; error?: never }
  | { data?: never; error: { statusCode: number; data: { error: string; code?: string; request_id?: string } } };

/** 视图接口统一信封；模块 data 保留对应 Core API 的响应契约。 */
export interface BffEnvelope {
  kind: BffViewKind;
  viewer: AuthUser | null;
  workspace: WorkspaceDetail;
  sections: Partial<Record<BffSectionName, BffSection>>;
}
