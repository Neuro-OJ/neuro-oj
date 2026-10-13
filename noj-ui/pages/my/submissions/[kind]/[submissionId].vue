<script setup lang="ts">
import type { OwnSubmissionKind } from '~/utils/own-submissions';
import { extractApiError } from '~/utils/apiError';
definePageMeta({ middleware: 'auth' });
const route = useRoute(), { user } = useAuth(), api = useOwnSubmissions();
const kind = computed(() => String(route.params.kind) as OwnSubmissionKind),
  id = computed(() => String(route.params.submissionId));
const { data, status, error, refresh } = await useAsyncData(
  () => `own-submission:${user.value?.id}:${kind.value}:${id.value}`,
  () => api.detail(kind.value, id.value),
);
usePolling({
  intervalMs: computed(() =>
    data.value?.data.result_visibility !== 'hidden' && ['pending', 'judging'].includes(data.value?.data.status ?? '')
      ? 2000
      : null
  ),
  immediate: false,
  fetcher: () => refresh(),
});
useSeoMeta({ title: '本人提交历史详情' });
</script>
<template>
  <div class="mx-auto max-w-5xl space-y-5 px-4 py-8 sm:px-6">
    <div class="flex items-center justify-between gap-3">
      <UButton to="/my/submissions" variant="ghost" icon="i-lucide-arrow-left">我的提交历史</UButton>
      <UButton variant="outline" @click="refresh()">刷新结果</UButton>
    </div>
    <AsyncContent :status="error ? 'error' : status === 'pending' ? 'loading' : data ? 'data' : 'empty'"
      :error="error ? extractApiError(error).message : undefined" @retry="refresh()">
      <OwnSubmissionRecord v-if="data" :entry="data.data" />
    </AsyncContent>
  </div>
</template>
