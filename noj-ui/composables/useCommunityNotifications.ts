/**
 * 社区通知未读状态（Navbar 角标与通知页共享同一 useState 实例）。
 */
export function useCommunityNotifications() {
  const unreadCount = useState('community:unread-count', () => 0);
  const { api } = useApi();

  async function loadUnreadCount() {
    try {
      // 未读数轮询：静默失败，失败时归零不打扰用户
      const result = await api.get<{ data: { unread_count: number } }>(
        '/api/v1/community/notifications/unread-count',
        { silent: true },
      );
      unreadCount.value = result.data.unread_count;
    } catch {
      unreadCount.value = 0;
    }
  }

  return { unreadCount, loadUnreadCount };
}
