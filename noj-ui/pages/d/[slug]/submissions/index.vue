<script setup lang="ts">
import { workspaceCacheKey, workspacePath } from '~/utils/workspace';
import { extractApiError } from '~/utils/apiError';
import { formatDateTime } from '~/utils/submissionFormat';
definePageMeta({ layout: 'workspace', middleware: ['auth', 'workspace-context'] });
const route = useRoute(), { slug } = useWorkspace(), { user } = useAuth();
const api = useDomainSubmissions(), page = ref(1);
const filters = computed(() => ({
  problem_id: typeof route.query.problem_id === 'string' ? route.query.problem_id : undefined,
  contest_id: typeof route.query.contest_id === 'string' ? route.query.contest_id : undefined,
}));
const key = computed(() =>
  workspaceCacheKey(
    slug.value!,
    user.value?.id ?? null,
    'submissions',
    String(page.value),
    JSON.stringify(filters.value),
  )
);
const { data, status, error, refresh } = await useAsyncData(
  key,
  () => api.list(slug.value!, page.value, filters.value),
);
watch([slug, filters], () => {
  page.value = 1;
});
useSeoMeta({ title: '我的空间提交' });
</script>
<template>
  <div class="space-y-4">
    <div class="flex justify-between gap-3">
      <h2 class="text-xl font-semibold">我的空间提交</h2>
      <UButton to="/my/submissions" variant="outline">全部域本人历史</UButton>
      <UButton :to="workspacePath(slug!, 'objective-submissions')" variant="outline">客观题历史</UButton>
      <UButton variant="ghost" icon="i-lucide-refresh-cw" aria-label="刷新提交" @click="refresh()" />
    </div>
    <AsyncContent :status="error ? 'error' : status === 'pending' ? 'loading' : data?.data.length ? 'data' : 'empty'"
      :error="error ? extractApiError(error).message : undefined" empty-text="当前空间暂无提交" @retry="refresh()">
      <UCard v-for="entry in data?.data" :key="entry.id">
        <div class="flex flex-wrap justify-between gap-3">
          <NuxtLink :to="workspacePath(slug!, `submissions/${entry.id}`)"
            class="font-semibold text-primary">{{ entry.reference.display_ref }} · {{ entry.problem?.title ?? '提交详情' }}</NuxtLink>
          <span
            class="text-xs tabular-nums text-text-muted">{{ formatDateTime(entry.created_at) }} · {{ entry.language }} · {{ entry.submitted_version == null ? '版本未知' : `V${entry.submitted_version}` }}</span>
        </div>
        <DomainSubmissionResult class="mt-3" :submission="entry" />
      </UCard>
    </AsyncContent>
    <UPagination v-if="data && data.pagination.total > 30" v-model:page="page" :total="data.pagination.total"
      :items-per-page="30" />
  </div>
</template>
