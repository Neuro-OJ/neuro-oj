<script setup lang="ts">
import { workspaceCacheKey } from '~/utils/domain/workspace/workspace';
import { extractApiError } from '~/utils/server/apiError';
import type { AnnouncementSummary } from '~/composables/useAnnouncements';
const props = defineProps<{ domainSlug: string; initialData?: AnnouncementSummary[] }>();
const { user } = useAuth(), api = useAnnouncements(props.domainSlug);
const { data, status, error, refresh } = await useAsyncData(
  () => workspaceCacheKey(props.domainSlug, user.value?.id ?? null, 'home-announcements'),
  () => api.list(1, 5),
  { immediate: !props.initialData },
);
usePolling({ intervalMs: 60000, immediate: false, fetcher: () => refresh() });
// 首屏数据只做初值：轮询刷新后以最新结果为准，否则新公告永远显示不出来。
const items = computed(() => data.value?.data ?? props.initialData ?? []);
const contentStatus = computed(() =>
  error.value ? 'error' : items.value.length ? 'data' : status.value === 'pending' ? 'loading' : 'empty'
);
</script>
<template>
  <section v-if="error || status === 'pending' || items.length" class=""
    aria-label="公告">
    <div class="flex items-center justify-between gap-3 border-b border-border bg-bg-sunken/50 px-3 py-1.5">
      <h2 class="text-xs font-semibold text-text-secondary">公告</h2>
      <NuxtLink :to="api.href()" class="text-xs text-primary no-underline hover:underline">全部 →</NuxtLink>
    </div>
    <AsyncContent :status="contentStatus"
      :error="error ? extractApiError(error).message : undefined" @retry="refresh()">
      <ul class="divide-y divide-border-subtle">
        <li v-for="item in items" :key="item.id">
          <NuxtLink :to="api.href(item.public_id || item.id)"
            class="flex items-start gap-2 px-3 py-2 text-[13px] no-underline hover:bg-bg-sunken/60 hover:text-primary">
            <UBadge color="neutral" variant="subtle" size="sm"
              class="shrink-0">{{ item.domain_id ? '本域' : '实例' }}</UBadge>
            <UBadge v-if="item.is_pinned" color="primary" variant="subtle" size="sm" class="shrink-0">置顶</UBadge>
            <div class="min-w-0 flex-1">
              <p class="break-words font-medium">{{ item.title }}</p>
              <p class="mt-0.5 line-clamp-1 text-xs text-text-muted">{{ item.excerpt }}</p>
            </div>
          </NuxtLink>
        </li>
      </ul>
    </AsyncContent>
  </section>
</template>
