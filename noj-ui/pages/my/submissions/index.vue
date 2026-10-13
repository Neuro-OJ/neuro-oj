<script setup lang="ts">
import { ownHistoryDetailLink } from '~/utils/own-submissions';
import { formatDateTime } from '~/utils/submissionFormat';
import { extractApiError } from '~/utils/apiError';
definePageMeta({ middleware: 'auth' });
const { user } = useAuth(), api = useOwnSubmissions(), page = ref(1);
const { data, status, error, refresh } = await useAsyncData(
  () => `own-submissions:${user.value?.id}:${page.value}`,
  () => api.list(page.value),
);
useSeoMeta({ title: '我的跨域提交' });
</script>
<template>
  <div class="mx-auto max-w-5xl space-y-5 px-4 py-8 sm:px-6">
    <AdminPageHeader title="我的提交" description="统一账号的代码、产物和客观题历史；每条保留使用域与来源题号">
      <template #actions>
        <UButton variant="outline" icon="i-lucide-refresh-cw" @click="refresh()">刷新历史</UButton>
      </template>
    </AdminPageHeader>
    <AsyncContent :status="error ? 'error' : status === 'pending' ? 'loading' : data?.data.length ? 'data' : 'empty'"
      :error="error ? extractApiError(error).message : undefined" @retry="refresh()">
      <UCard v-for="entry in data?.data" :key="`${entry.kind}:${entry.id}`" class="mb-4">
        <NuxtLink :to="ownHistoryDetailLink(entry)"
          class="font-semibold text-primary"><span class="mr-2 font-mono">{{ entry.reference.display_ref }}</span>{{ entry.problem.title }}</NuxtLink>
        <p
          class="my-3 text-xs text-text-muted">{{ entry.domain.name }} · {{ entry.domain.slug }} · {{ formatDateTime(entry.created_at) }} · {{ entry.kind === 'objective' ? '客观题' : entry.language }}{{ !entry.domain.accessible ? ' · 当前无域访问权' : !entry.resource_available ? ' · 源资源不可用' : '' }}</p>
        <OwnSubmissionSummary :entry="entry" />
      </UCard>
      <PaginationNav :current-page="page" :total-pages="data?.pagination.total_pages ?? 0"
        @page-change="page = $event" />
    </AsyncContent>
  </div>
</template>
