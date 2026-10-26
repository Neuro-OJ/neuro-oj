/** 不同未读接口的既有契约；无效响应由调用方保留最近的成功值。 */
export function readUnreadCount(value: unknown, kind: 'messages' | 'domain' | 'account'): number | null {
  if (!value || typeof value !== 'object') return null;
  const response = value as Record<string, unknown>;
  const data = response.data && typeof response.data === 'object' ? response.data as Record<string, unknown> : {};
  const count = kind === 'messages' ? response.unread_count : kind === 'domain' ? data.count : data.unread_count;
  return typeof count === 'number' && Number.isSafeInteger(count) && count >= 0 ? count : null;
}
