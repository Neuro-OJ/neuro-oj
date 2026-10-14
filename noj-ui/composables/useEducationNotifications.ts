import { computed, type MaybeRefOrGetter, toValue } from 'vue';
import { useEventSource } from '~/composables/useEventSource';
/** SSE 只提示重读；内容、未读数量与权限仍从授权 REST 响应取得。 */
export function useEducationNotifications(refresh: () => Promise<void>, enabled: MaybeRefOrGetter<boolean> = true) {
  const { slug, domain } = useWorkspace();
  const { user } = useAuth();
  return useEventSource({
    url: computed(() => slug.value ? `/api/v1/domains/${encodeURIComponent(slug.value)}/notifications/events` : ''),
    scopeKey: computed(() => `${slug.value}:${user.value?.id ?? ''}`),
    enabled: computed(() =>
      toValue(enabled) && !!user.value && !!domain.value && (domain.value.is_member || domain.value.platform_admin)
    ),
    onEvent: {
      'education:sync': () => {
        void refresh();
      },
      'education:notification': () => {
        void refresh();
      },
    },
    fetchFn: refresh,
    fallbackIntervalMs: 15_000,
  });
}
