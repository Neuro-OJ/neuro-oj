<script setup lang="ts">
import { extractApiError } from '~/utils/apiError';
import { workspaceCacheKey } from '~/utils/workspace';
import { formatDateTime } from '~/utils/submissionFormat';
const props = defineProps<{ domainSlug?: string }>();
const route = useRoute(), router = useRouter(), { user } = useAuth();
const api = useAnnouncements(props.domainSlug);
const page = computed(() => Math.max(1, Number(route.query.page) || 1));
const { data, status, error, refresh } = await useAsyncData(
  () => workspaceCacheKey(props.domainSlug ?? '', user.value?.id ?? null, 'announcements', String(page.value)),
  () => api.list(page.value),
);
useSeoMeta({ title: '公告' });
</script>
<template>
  <div class="mx-auto max-w-[900px] space-y-5">
    <h1 class="text-2xl font-bold text-text">公告</h1>
    <AsyncContent
      :status="error ? 'error' : status === 'pending' && !data ? 'loading' : data?.data.length ? 'data' : 'empty'"
      :error="error ? extractApiError(error).message : undefined" empty-text="暂无公告" @retry="refresh()">
      <div class="divide-y divide-border rounded border border-border bg-bg-panel">
        <NuxtLink v-for="item in data?.data" :key="item.id" :to="api.href(item.public_id || item.id)"
          class="flex flex-wrap items-start gap-2 px-4 py-4 no-underline transition-colors hover:bg-primary-hover-bg sm:px-5">
          <UBadge color="neutral" variant="subtle" class="shrink-0">{{ item.domain_id ? '本域' : '实例' }}</UBadge>
          <UBadge v-if="item.is_pinned" color="primary" variant="subtle" class="shrink-0">置顶</UBadge>
          <div class="min-w-0 flex-1">
            <h2 class="break-words font-medium text-text">{{ item.title }}</h2>
            <p class="mt-1 line-clamp-2 text-sm text-text-secondary">{{ item.excerpt }}</p>
            <p class="mt-2 text-xs tabular-nums text-text-muted">{{ formatDateTime(item.created_at) }}</p>
          </div>
        </NuxtLink>
      </div>
      <PaginationNav v-if="data && data.meta.total_pages > 1" class="mt-5" :current-page="page"
        :total-pages="data.meta.total_pages"
        @page-change="router.push({query:{...route.query,page:$event}})" />
    </AsyncContent>
  </div>
</template>
