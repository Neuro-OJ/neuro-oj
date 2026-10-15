<script setup lang="ts">
import { workspaceCacheKey } from '~/utils/workspace';
import { formatDateTime } from '~/utils/submissionFormat';
import { extractApiError } from '~/utils/apiError';
const props = defineProps<{ domainSlug?: string; announcementId: string }>();
const { user } = useAuth(), api = useAnnouncements(props.domainSlug);
const { data, status, error, refresh } = await useAsyncData(
  () => workspaceCacheKey(props.domainSlug ?? '', user.value?.id ?? null, 'announcement', props.announcementId),
  () => api.detail(props.announcementId));
useBreadcrumbLabel(() => data.value?.title);
useSeoMeta({ title: () => data.value ? `${data.value.title} · 公告` : '公告' });
</script>
<template>
  <div class="mx-auto max-w-[900px] space-y-4">
    <UButton :to="api.href()" color="neutral" variant="ghost" icon="i-lucide-arrow-left">返回公告列表</UButton>
    <AsyncContent :status="error ? 'error' : status === 'pending' ? 'loading' : data ? 'data' : 'empty'"
      :error="error ? extractApiError(error).message : undefined" empty-text="公告不存在或已下架" @retry="refresh()">
      <article v-if="data" class="overflow-hidden rounded border border-border bg-bg-panel">
        <header class="border-b border-border px-5 py-5 sm:px-7">
          <div class="mb-3 flex gap-2">
            <UBadge color="neutral" variant="subtle">{{ data.domain_id ? '本域' : '实例' }}</UBadge>
            <UBadge v-if="data.is_pinned" color="primary" variant="subtle">置顶</UBadge>
          </div>
          <h1 class="break-words text-2xl font-bold text-text">{{ data.title }}</h1>
          <p class="mt-2 text-xs tabular-nums text-text-muted">发布于 {{ formatDateTime(data.created_at) }}</p>
        </header>
        <div class="px-5 py-6 sm:px-7"><MarkdownRenderer :content="data.content" /></div>
      </article>
    </AsyncContent>
  </div>
</template>
