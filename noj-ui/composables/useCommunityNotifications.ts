/**
 * 社区通知未读状态（Navbar 角标与通知页共享同一 useState 实例）。
 */
import { COMMUNITY_UNREAD_COUNT_REQUEST_OPTIONS } from '~/utils/communityNotifications';
import { readUnreadCount } from '~/utils/unread-count';

export function useCommunityNotifications(account: boolean | (() => boolean) = false) {
  const scope = useCommunityScope(account);
  const stored = useState<{ key: string; count: number } | null>('community:unread-count', () => null);
  const unreadCount = computed(() => stored.value?.key === scope.key.value ? stored.value.count : 0);
  const { api } = useApi();
  const update = (key: string, value: unknown, slug: string | null) => {
    const count = readUnreadCount(value, slug === null ? 'account' : 'domain');
    if (count !== null) stored.value = { key, count };
  };

  async function loadUnreadCount(force = true) {
    const request = scope.capture();
    if (!force && stored.value?.key === request.key) {
      return;
    }
    try {
      // 未读数轮询：静默失败，保留本作用域最近的成功值
      const result = await api.get<unknown>(
        request.apiPath('notifications/unread-count'),
        COMMUNITY_UNREAD_COUNT_REQUEST_OPTIONS,
      );
      if (request.isCurrent()) update(request.key, result, request.slug);
    } catch {
      // 后台刷新失败不清除已读到的未读数；作用域键阻止跨账号、跨域显示。
    }
  }

  return { unreadCount, loadUnreadCount };
}
