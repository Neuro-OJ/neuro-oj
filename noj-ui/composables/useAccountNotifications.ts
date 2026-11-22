/** 全部域共用账号通知角标；作用域键只随账号变化。 */
export function useAccountNotifications() {
  const { user } = useAuth(), { api } = useApi();
  const stored = useState<{ actor: string; count: number } | null>('account:notifications:unread', () => null);
  const unreadCount = computed(() => stored.value && stored.value.actor === user.value?.id ? stored.value.count : 0);
  async function refresh() {
    const actor = user.value?.id;
    if (!actor) {
      stored.value = null;
      return;
    }
    try {
      const result = await api.get<{ unread_count: number }>('/api/v1/notifications', {
        query: { per_page: 1 },
        silent: true,
        redirectOnUnauthorized: false,
      });
      if (user.value?.id === actor) stored.value = { actor, count: result.unread_count };
    } catch { /* 后台轮询失败保留此账号最近一次成功值。 */ }
  }
  return { unreadCount, refresh };
}
