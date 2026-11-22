const DRAFT_PREFIX = 'noj:draft:';

/** 只识别 domainAnswerKey 生成的账号键；无归属的旧键不能认领给当前用户。 */
export function draftActor(key: string): string | null {
  try {
    const parts: unknown = JSON.parse(key);
    return Array.isArray(parts) && parts.length === 6 && parts[0] === 'domain-answer' &&
        parts.every((part) => typeof part === 'string')
      ? (parts[1] as string)
      : null;
  } catch {
    return null;
  }
}

/** 退出或失去会话时清除该账号及旧格式草稿，保留游客与其他账号的草稿。 */
export function clearUserDrafts(actor?: string | null): void {
  // 服务端没有浏览器文档，不访问任何本地存储。
  if (!('document' in globalThis)) return;
  try {
    // 倒序删除，避免 localStorage 索引移动导致漏删。
    for (let index = localStorage.length - 1; index >= 0; index--) {
      const key = localStorage.key(index);
      if (!key?.startsWith(DRAFT_PREFIX)) continue;
      const owner = draftActor(key.slice(DRAFT_PREFIX.length));
      if (owner === null || (owner !== 'anonymous' && owner === actor)) {
        localStorage.removeItem(key);
      }
    }
  } catch {
    // 禁用存储等浏览器限制不应阻止清除登录态。
  }
}
