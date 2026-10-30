<script setup lang="ts">
import type { NotificationRow } from '~/composables/useCommunity';
import { extractApiError } from '~/utils/apiError';
import { notificationTarget, notificationTypeLabel, notificationTypeIcon } from '~/utils/communityNotifications';
const { api } = useApi(), { user } = useAuth(), workspace = useWorkspaceApi();
const page = ref(1), domainId = ref('all'), opening = ref(''), actionError = ref('');
const selectedDomainId = computed(() => domainId.value === 'all' ? undefined : domainId.value);
const badge = useAccountNotifications();
const domains = await useAsyncData(() => `notification-domains:${user.value?.id}`, () => workspace.list(true));
const key = computed(() => `notifications:${user.value?.id}:${domainId.value}:${page.value}`);
const { data, error, status, refresh } = await useAsyncData(key, () => api.get<{
  data: NotificationRow[]; total: number; unread_count: number;
}>('/api/v1/notifications', { query: { page: page.value, domain_id: selectedDomainId.value }, silent: true }));
watch(domainId, () => { page.value = 1; });
const stream = useEventSource({
  url: '/api/v1/notifications/events', scopeKey: computed(() => user.value?.id ?? ''),
  enabled: computed(() => !!user.value), onEvent: { 'notification:new': () => { void reload(); } },
  fetchFn: reload, fallbackIntervalMs: 15000,
});
async function reload() { await Promise.all([refresh(), badge.refresh()]); }
async function readAll() {
  await api.post('/api/v1/notifications/read', undefined, { query: { domain_id: selectedDomainId.value } });
  await reload();
}
async function open(item: NotificationRow) {
  if (opening.value) return;
  const actor = user.value?.id;
  opening.value = item.notification.id;
  actionError.value = '';
  try {
    // 先确认通知仍可访问，再标记和跳转，撤权不会继续打开旧定位。
    const current = await api.get<{ data: NotificationRow }>(`/api/v1/notifications/${item.notification.id}`, { silent: true });
    await api.post(`/api/v1/notifications/${item.notification.id}/read`);
    if (actor !== user.value?.id) return;
    await badge.refresh();
    await navigateTo(notificationTarget(current.data, current.data.domain?.slug ?? null) ?? `/notifications/${item.notification.id}`);
  } catch (error: unknown) {
    actionError.value = extractApiError(error).message || '通知不存在或无权查看';
  } finally { opening.value = ''; }
}
useSeoMeta({ title: '通知' });
</script>
<template>
  <main class="mx-auto flex w-full max-w-4xl flex-col gap-6 px-4 py-8 sm:px-6">
    <LibraryPageHeader title="通知" :description="`当前筛选有 ${data?.unread_count ?? 0} 条未读通知`" icon="i-lucide-bell">
      <template #actions><UButton variant="outline" icon="i-lucide-check-check" @click="readAll">全部已读</UButton></template>
    </LibraryPageHeader>
    <USelect v-model="domainId" :items="[{ label: '全部域', value: 'all' }, ...(domains.data.value?.data ?? []).map(domain => ({ label: domain.name, value: domain.id }))]" aria-label="通知所属域" class="w-full sm:w-72" />
    <p v-if="stream.state.value === 'fallback'" class="text-xs text-text-muted">实时连接暂不可用，正在定时刷新。</p>
    <p v-if="actionError" role="alert" class="text-sm text-error-text">{{ actionError }}</p>
    <AsyncContent :status="error ? 'error' : status === 'pending' ? 'loading' : data?.data.length ? 'data' : 'empty'"
      :error="error ? extractApiError(error).message : undefined" empty-text="暂无通知" @retry="reload()">
      <div class="flex flex-col gap-3">
        <button v-for="item in data?.data" :key="item.notification.id" type="button" :disabled="!!opening"
          class="flex w-full items-start gap-3 rounded-lg border border-border bg-bg-panel p-4 text-left transition-colors hover:border-primary hover:bg-primary-bg focus-visible:outline-2 focus-visible:outline-primary"
          :class="!item.notification.read_at && 'border-primary/40'" @click="open(item)">
          <UIcon :name="notificationTypeIcon(item.notification.type)" class="mt-1 size-5 shrink-0 text-primary" />
          <span class="min-w-0 flex-1">
            <span class="flex flex-wrap items-center gap-2 font-medium">{{ notificationTypeLabel(item.notification.type) }}<UBadge v-if="!item.notification.read_at" size="sm" variant="subtle">未读</UBadge></span>
            <span class="mt-1 block text-xs text-text-muted">{{ item.domain?.name ?? '账号通知' }} · {{ new Date(item.notification.created_at).toLocaleString() }}</span>
          </span>
          <UIcon name="i-lucide-chevron-right" class="mt-1 size-4 text-text-muted" />
        </button>
      </div>
    </AsyncContent>
    <nav class="flex items-center justify-between gap-3" aria-label="通知分页">
      <UButton :disabled="page <= 1" variant="outline" @click="page--">上一页</UButton>
      <span class="text-sm tabular-nums">{{ page }} / {{ Math.max(1, Math.ceil((data?.total ?? 0) / 30)) }}</span>
      <UButton :disabled="page * 30 >= (data?.total ?? 0)" variant="outline" @click="page++">下一页</UButton>
    </nav>
  </main>
</template>
