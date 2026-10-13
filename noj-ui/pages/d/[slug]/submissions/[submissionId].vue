<script setup lang="ts">
import { workspaceCacheKey, workspaceProblemPath } from '~/utils/workspace';
import { extractApiError } from '~/utils/apiError';
import { formatDateTime } from '~/utils/submissionFormat';
definePageMeta({ layout: 'workspace', middleware: ['auth', 'workspace-context'] });
const route = useRoute(), { slug } = useWorkspace(), { user } = useAuth(), api = useDomainSubmissions();
const id = computed(() => String(route.params.submissionId));
const key = computed(() => workspaceCacheKey(slug.value!, user.value?.id ?? null, 'submission', id.value));
const { data, status, error, refresh } = await useAsyncData(key, () => api.detail(slug.value!, id.value));
usePolling({
  intervalMs: computed(() =>
    data.value?.data.result_visibility !== 'hidden' && ['pending', 'judging'].includes(data.value?.data.status ?? '')
      ? 2000
      : null
  ),
  immediate: false,
  fetcher: () => refresh(),
});
useSeoMeta({ title: '空间提交详情' });
</script>
<template>
  <AsyncContent :status="error ? 'error' : status === 'pending' ? 'loading' : data ? 'data' : 'empty'"
    :error="error ? extractApiError(error).message : undefined" @retry="refresh()">
    <div v-if="data" class="space-y-4">
      <div class="flex flex-wrap justify-between gap-3">
        <h2 class="text-xl font-semibold">{{ data.data.reference.display_ref }} · 提交详情</h2>
        <UButton v-if="data.data.resource_available" :to="workspaceProblemPath(slug!, data.data.reference.display_ref)"
          variant="outline">返回本域题目</UButton>
        <UButton variant="ghost" icon="i-lucide-refresh-cw" aria-label="刷新结果" @click="refresh()" />
      </div>
      <p
        class="break-all text-xs text-text-muted tabular-nums">{{ data.data.id }} · {{ formatDateTime(data.data.created_at) }} · 使用域 {{ slug }} · {{ data.data.submitted_version == null ? '版本未知' : `V${data.data.submitted_version}` }}</p>
      <UAlert v-if="!data.data.resource_available" color="warning"
        title="源资源已不可用，保留已受理的原提交和授权成绩摘要" />
      <DomainSubmissionResult :submission="data.data" />
      <UCard v-if="data.data.code != null">
        <h3 class="mb-3 font-semibold">原提交代码</h3>
        <pre class="max-h-[32rem] overflow-auto whitespace-pre font-mono text-xs">{{ data.data.code }}</pre>
      </UCard>
    </div>
  </AsyncContent>
</template>
