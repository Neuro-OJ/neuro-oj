<script setup lang="ts">
import { workspaceCacheKey } from '~/utils/workspace';
import { extractApiError } from '~/utils/apiError';
import type { AnnouncementSummary } from '~/composables/useAnnouncements';
const props = defineProps<{ domainSlug: string; initialData?: AnnouncementSummary[] }>();
const { user } = useAuth(), api = useAnnouncements(props.domainSlug);
const { data, status, error, refresh } = await useViewAsyncData(
  'announcements',
  () => workspaceCacheKey(props.domainSlug, user.value?.id ?? null, 'home-announcements'),
  () => api.list(1, 5),
  { immediate: !props.initialData },
);
usePolling({ intervalMs: 60000, immediate: false, fetcher: () => refresh() });
const items = computed(() => props.initialData ?? data.value?.data ?? []);
const contentStatus = computed(() => error.value ? 'error' : items.value.length ? 'data' : status.value === 'pending' ? 'loading' : 'empty');
</script>
<template>
  <section v-if="error || status === 'pending' || items.length" class="px-5 py-5 sm:px-6"
    aria-label="公告">
    <div class="mb-3 flex items-center justify-between gap-3">
      <h2 class="text-lg font-semibold text-text">公告</h2>
      <UButton :to="api.href()" variant="ghost" size="sm" trailing-icon="i-lucide-arrow-right">全部公告</UButton>
    </div>
    <AsyncContent :status="contentStatus"
      :error="error ? extractApiError(error).message : undefined" @retry="refresh()">
      <ul class="divide-y divide-border">
        <li v-for="item in items" :key="item.id" class="py-3 first:pt-0 last:pb-0">
          <NuxtLink :to="api.href(item.public_id || item.id)"
            class="flex items-start gap-2 no-underline hover:text-primary">
            <UBadge color="neutral" variant="subtle" size="sm"
              class="shrink-0">{{ item.domain_id ? '本域' : '实例' }}</UBadge>
            <UBadge v-if="item.is_pinned" color="primary" variant="subtle" size="sm" class="shrink-0">置顶</UBadge>
            <div class="min-w-0 flex-1">
              <p class="break-words font-medium">{{ item.title }}</p>
              <p class="mt-0.5 line-clamp-2 text-sm text-text-secondary">{{ item.excerpt }}</p>
            </div>
            <UIcon name="i-lucide-chevron-right" class="mt-0.5 size-4 shrink-0 text-text-muted" />
          </NuxtLink>
        </li>
      </ul>
    </AsyncContent>
  </section>
</template>
