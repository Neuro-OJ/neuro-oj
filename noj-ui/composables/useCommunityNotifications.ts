/**
 * 社区通知未读状态（Navbar 角标与通知页共享同一 useState 实例）。
 */
export function useCommunityNotifications() {
  const unreadCount = useState('community:unread-count', () => 0);

  async function loadUnreadCount() {
    try {
      const result = await $fetch<{ data: { unread_count: number } }>(
        '/api/v1/community/notifications/unread-count',
      );
      unreadCount.value = result.data.unread_count;
    } catch {
      unreadCount.value = 0;
    }
  }

  return { unreadCount, loadUnreadCount };
}
