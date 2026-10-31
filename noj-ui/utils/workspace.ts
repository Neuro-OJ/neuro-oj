/** 产品空间的客户端契约；权限仍由每次服务端请求判定。 */
export type WorkspaceRole = 'owner' | 'admin' | 'editor' | 'educator' | 'moderator' | 'member';
export type WorkspacePreset = 'community' | 'education' | 'team';
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
  classroom_id?: string | null;
  mode: 'email' | 'general' | 'once';
  email: string | null;
  max_uses: number | null;
  used_count: number;
  expires_at: string;
  used_at: string | null;
  revoked_at: string | null;
  created_at: string;
}
export interface WorkspaceInvitationCreated {
  id: string;
  token: string;
  code: string;
  mode: 'email' | 'general' | 'once';
  max_uses: number | null;
  expires_at: string;
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
  email: string | null;
  mode: 'email' | 'general' | 'once';
  max_uses: number | null;
  used_count: number;
  expires_at: string;
  can_register: boolean;
  classroom_id?: string;
  classroom_name?: string;
}
export type WorkspaceInvitationStatus = 'active' | 'used_up' | 'expired' | 'revoked';

export function getInvitationStatus(invitation: {
  revoked_at: string | null;
  expires_at: string;
  max_uses: number | null;
  used_count: number;
}): WorkspaceInvitationStatus {
  if (invitation.revoked_at) return 'revoked';
  const expiry = Date.parse(invitation.expires_at);
  if (Number.isFinite(expiry) && expiry <= Date.now()) return 'expired';
  if (invitation.max_uses !== null && invitation.used_count >= invitation.max_uses) return 'used_up';
  return 'active';
}

export const WORKSPACE_INVITATION_STATUS_LABELS: Record<WorkspaceInvitationStatus, string> = {
  active: '有效',
  used_up: '已用尽',
  expired: '已过期',
  revoked: '已撤销',
};

export const WORKSPACE_INVITATION_MODE_LABELS: Record<'email' | 'general' | 'once', string> = {
  email: '指定邮箱',
  general: '通用',
  once: '一次性',
};
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
  { value: 'community', label: '社区', description: '公开入口、题库、题单、比赛与社区' },
  { value: 'education', label: '教学', description: '班级、作业与教练工作台，兼有题库、比赛和社区' },
  { value: 'team', label: '团队', description: '成员入口、协作题库、题单、比赛与社区' },
] as const;

/** slug 是网址标识，不接受路径或跨域题号分隔符。 */
export function workspacePath(slug: string, section = '') {
  if (!/^[a-z][a-z0-9-]{1,30}[a-z0-9]$/.test(slug)) throw new Error('空间标识无效');
  if (section && !/^[a-z][a-z0-9/-]*$/.test(section)) throw new Error('空间页面无效');
  return `/d/${slug}${section ? `/${section}` : ''}`;
}

/**
 * 登录成功后的落点。
 *
 * 规则（只影响导航，不是授权：成员关系早已由后端确定）：
 * 1. 只属于一个空间 → 直接进那个空间；
 * 2. 除默认空间外只属于一个空间 → 进那个空间（被邀请进某所学校的学生不该被丢回
 *    公共默认空间——默认空间对每个账号都是成员，`length === 1` 几乎永不成立）；
 * 3. 其余情况回站点根，由根路径按默认空间跳转。
 */
export function postLoginDestination(
  spaces: ReadonlyArray<{ slug: string }>,
  defaultSlug: string | null,
): string {
  if (spaces.length === 1) return workspacePath(spaces[0]!.slug);
  const primary = spaces.filter((space) => space.slug !== defaultSlug);
  if (primary.length === 1) return workspacePath(primary[0]!.slug);
  return '/';
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
/** 学生做题工作区与作者草稿编辑器使用不同的地址。 */
export function workspaceSolvePath(slug: string, reference: string) {
  return workspaceProblemPath(slug, reference).replace('/problems/', '/solve/');
}
/** 链接令牌与分组短码共用兑换路径，不将凭据放入 API URL。 */
export function isInvitationCredential(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const trimmed = value.trim();
  if (/^[0-9a-f-]{72}$/i.test(trimmed)) return true;
  const cleaned = trimmed.replaceAll('-', '').toUpperCase();
  return /^[2-9A-HJ-NP-Z]{12}$/.test(cleaned);
}

/** 规范化短码为 4 字符一组展示，如 XXXX-XXXX-XXXX */
export function formatInvitationCode(code: string): string {
  const cleaned = code.replaceAll(/[^2-9A-HJ-NP-Za-hj-np-z]/g, '').toUpperCase().slice(0, 12);
  const parts = cleaned.match(/.{1,4}/g);
  return parts ? parts.join('-') : cleaned;
}

/** 规范化凭据（长 token 保持原样，短码大写去连字符） */
export function normalizeInvitationCredential(value: string): string {
  const trimmed = value.trim();
  if (/^[0-9a-f-]{72}$/i.test(trimmed)) return trimmed;
  const cleaned = trimmed.replaceAll('-', '').toUpperCase();
  if (/^[2-9A-HJ-NP-Z]{12}$/.test(cleaned)) return cleaned;
  return trimmed;
}

/** 邀请在 URL fragment 中传递，不进入请求路径、Referer 或 API 日志。 */
export function workspaceInvitationLink(origin: string, token: string, registration = false) {
  if (!isInvitationCredential(token)) throw new Error('邀请无效');
  return `${origin}${registration ? '/register' : '/join'}#token=${encodeURIComponent(token)}`;
}

export function workspaceInvitationToken(hash: string): string | null {
  const rawHash = hash.replace(/^#/, '');
  const params = new URLSearchParams(rawHash);
  const raw = params.get('token') ?? params.get('invitation') ?? (rawHash && !rawHash.includes('=') ? rawHash : null);
  if (!raw) return null;
  return isInvitationCredential(raw) ? raw.trim() : null;
}
