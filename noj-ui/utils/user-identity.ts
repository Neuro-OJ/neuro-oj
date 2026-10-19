/** 用于展示的最小用户摘要，域上下文由业务记录单独提供。 */
export interface UserSummary {
  id: string;
  username: string;
  avatar_url?: string | null;
  state?: 'active' | 'deleted';
}

/** 头像只走站内代理；内容校验和改变时自动更新图片缓存键。 */
export function userAvatarSrc(user: UserSummary, loadWhenUnknown = false): string | undefined {
  if (user.state === 'deleted' || !user.id && !user.username) return undefined;
  if (!user.avatar_url && !(loadWhenUnknown && user.avatar_url === undefined)) return undefined;
  const path = `/api/v1/users/${encodeURIComponent(user.id || user.username)}/avatar`;
  if (!user.avatar_url) return path;
  try {
    const value = new URL(user.avatar_url, 'https://noj.invalid');
    const version = value.searchParams.get('checksum_sha256') ?? value.searchParams.get('v');
    if (version && /^[a-zA-Z0-9_-]{1,128}$/.test(version)) return `${path}?v=${encodeURIComponent(version)}`;
  } catch { /* 不解析外部地址，仅使用站内头像端点。 */ }
  return path;
}

/** 后缀描述业务上下文，不推断账号归属或用户当前成员关系。 */
export function userIdentityLabel(user: UserSummary, domain?: string | null): string {
  if (user.state === 'deleted') return '已注销用户';
  const name = user.username || '未知用户';
  return domain ? `${name}@${domain}` : name;
}
