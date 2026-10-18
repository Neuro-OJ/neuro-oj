/**
 * 社区通知未读状态（Navbar 角标与通知页共享同一 useState 实例）。
 */
import { COMMUNITY_UNREAD_COUNT_REQUEST_OPTIONS } from '~/utils/communityNotifications';

export function useCommunityNotifications(account: boolean | (() => boolean) = false) {
  const scope = useCommunityScope(account);
  const stored = useState<{ key: string; count: number } | null>('community:unread-count', () => null);
  const unreadCount = computed(() => stored.value?.key === scope.key.value ? stored.value.count : 0);
  const { api } = useApi();
  const seed = useViewSection<{ data: { unread_count: number } }>('communityUnread');

  if (seed.value?.data) stored.value = { key: scope.key.value, count: seed.value.data.data.unread_count };

  async function loadUnreadCount(force = true) {
    const request = scope.capture();
    if (!force && seed.value) {
      stored.value = { key: request.key, count: seed.value.data?.data.unread_count ?? 0 };
      return;
    }
    try {
      // 未读数轮询：静默失败，失败时归零不打扰用户
      const result = await api.get<{ data: { unread_count: number } }>(
        request.apiPath('notifications/unread-count'),
        COMMUNITY_UNREAD_COUNT_REQUEST_OPTIONS,
      );
      if (request.isCurrent()) stored.value = { key: request.key, count: result.data.unread_count };
    } catch {
      if (request.isCurrent()) stored.value = { key: request.key, count: 0 };
    }
  }

  return { unreadCount, loadUnreadCount };
}
