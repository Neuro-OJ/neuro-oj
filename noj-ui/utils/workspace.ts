/** 产品空间的客户端契约；权限仍由每次服务端请求判定。 */
export type WorkspaceRole = 'owner' | 'admin' | 'editor' | 'educator' | 'moderator' | 'member';
export type WorkspacePreset = 'community' | 'education' | 'team' | 'custom';
export interface WorkspaceConfiguration {
  access: 'public' | 'members';
  discoverable: boolean;
  join_policy: 'open' | 'approval' | 'invite';
  features: { community: boolean; classroom: boolean; assignment: boolean; analytics: boolean };
  homepage: 'overview' | 'community' | 'teaching' | 'training';
}
export interface WorkspaceSummary {
  id: string;
  slug: string;
  name: string;
  description: string;
  status: 'active' | 'archived' | 'suspended';
}
export interface WorkspaceRecord extends WorkspaceSummary {
  owner_id: string;
  preset: WorkspacePreset;
  configuration: WorkspaceConfiguration;
  revision: number;
}
export interface WorkspaceDetail extends WorkspaceRecord {
  actor_id: string | null;
  permissions: string[];
  is_member: boolean;
  platform_admin: boolean;
}
export interface WorkspaceMember {
  id: string;
  user_id: string;
  username: string;
  email: string;
  status: 'active' | 'removed';
  roles: WorkspaceRole[];
  is_owner: boolean;
}
export interface WorkspaceInvitation {
  id: string;
  email: string;
  expires_at: string;
  used_at: string | null;
  revoked_at: string | null;
  created_at: string;
}
export interface WorkspaceJoinRequest {
  id: string;
  user_id: string;
  username: string;
  reason: string;
  status: 'pending' | 'approved' | 'rejected';
  created_at: string;
  can_approve: boolean;
}
export interface WorkspaceInvitationPreview {
  domain_slug: string;
  domain_name: string;
  email: string;
  expires_at: string;
  can_register: boolean;
  classroom_id?: string;
  classroom_name?: string;
}
export interface WorkspaceLimits {
  members: number | null;
  problems: number | null;
  storage_bytes: number | null;
  submissions_per_minute: number | null;
}
export interface WorkspaceLimitUsage {
  members: number;
  problems: number;
  storage_bytes: number;
  reserved_members: number;
  reserved_problems: number;
  reserved_storage_bytes: number;
}
export const WORKSPACE_ROLE_LABELS: Record<WorkspaceRole, string> = {
  owner: '负责人',
  admin: '管理员',
  editor: '资源编辑者',
  educator: '教学人员',
  moderator: '社区管理员',
  member: '成员',
};
export const WORKSPACE_PRESETS = [
  { value: 'community', label: '社区', description: '公开入口、社区与题单' },
  { value: 'education', label: '教学', description: '成员入口、班级与作业' },
  { value: 'team', label: '团队', description: '成员入口、题库与比赛' },
  { value: 'custom', label: '自定义', description: '最小核心 OJ，可按需配置' },
] as const;

/** slug 是网址标识，不接受路径或跨域题号分隔符。 */
export function workspacePath(slug: string, section = '') {
  if (!/^[a-z][a-z0-9-]{1,30}[a-z0-9]$/.test(slug)) throw new Error('空间标识无效');
  if (section && !/^[a-z][a-z0-9/-]*$/.test(section)) throw new Error('空间页面无效');
  return `/d/${slug}${section ? `/${section}` : ''}`;
}
/** 从当前 URL 解析空间，任何偏好或 Cookie 都不能改变此值。 */
export function workspaceSlugFromPath(path: string): string | null {
  const slug = /^\/d\/([^/]+)(?:\/|$)/.exec(path)?.[1];
  return slug && /^[a-z][a-z0-9-]{1,30}[a-z0-9]$/.test(slug) ? slug : null;
}
/** 初始域概览按不可变 slug 和查看者隔离，资源缓存另加入稳定 ID 与版本。 */
export function workspaceCacheKey(
  slug: string,
  actorId: string | null,
  resource = 'overview',
  resourceId: string | null = null,
  versionId: string | null = null,
) {
  return `workspace:${JSON.stringify([slug, actorId, resource, resourceId, versionId])}`;
}
/** 引用题继续在使用域访问，禁止用来源 slug 改写作答上下文。 */
export function workspaceProblemPath(slug: string, reference: string) {
  if (!/^(?:[a-z][a-z0-9-]{1,30}[a-z0-9]:)?[1-9][0-9]{0,9}$/.test(reference)) throw new Error('题号无效');
  const number = Number(reference.split(':').at(-1));
  if (number > 2147483647) throw new Error('题号无效');
  return `${workspacePath(slug)}/problems/${reference}`;
}
/** 邀请在 URL fragment 中传递，不进入请求路径、Referer 或 API 日志。 */
export function workspaceInvitationLink(origin: string, token: string, registration = false) {
  if (!/^[0-9a-f-]{72}$/.test(token)) throw new Error('邀请无效');
  return `${origin}${registration ? '/register' : '/join'}#invitation=${encodeURIComponent(token)}`;
}
export function workspaceInvitationToken(hash: string) {
  const token = new URLSearchParams(hash.replace(/^#/, '')).get('invitation');
  return token && /^[0-9a-f-]{72}$/.test(token) ? token : null;
}
