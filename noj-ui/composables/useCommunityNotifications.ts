/**
 * 社区通知未读状态（Navbar 角标与通知页共享同一 useState 实例）。
 */
import { COMMUNITY_UNREAD_COUNT_REQUEST_OPTIONS } from '~/utils/communityNotifications';

export function useCommunityNotifications() {
  const unreadCount = useState('community:unread-count', () => 0);
  const { api } = useApi();

  async function loadUnreadCount() {
    try {
      // 未读数轮询：静默失败，失败时归零不打扰用户
      const result = await api.get<{ data: { unread_count: number } }>(
        '/api/v1/community/notifications/unread-count',
        COMMUNITY_UNREAD_COUNT_REQUEST_OPTIONS,
      );
      unreadCount.value = result.data.unread_count;
    } catch {
      unreadCount.value = 0;
    }
  }

  return { unreadCount, loadUnreadCount };
}
