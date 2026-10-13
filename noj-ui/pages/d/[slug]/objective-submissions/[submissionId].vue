<script setup lang="ts">
import { workspaceCacheKey, workspacePath } from '~/utils/workspace';
import { extractApiError } from '~/utils/apiError';
definePageMeta({ layout: 'workspace', middleware: ['auth', 'workspace-context'] });
const route = useRoute(), { slug } = useWorkspace(), { user } = useAuth(), api = useDomainObjectiveHistory();
const id = computed(() => String(route.params.submissionId));
const { data, status, error, refresh } = await useAsyncData(
  () => workspaceCacheKey(slug.value!, user.value?.id ?? null, 'objective-record', id.value),
  () => api.detail(slug.value!, id.value),
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
useSeoMeta({ title: '本人客观题提交详情' });
</script>
<template>
  <div class="space-y-5">
    <div class="flex items-center justify-between gap-3">
      <UButton :to="workspacePath(slug!, 'objective-submissions')" variant="ghost"
        icon="i-lucide-arrow-left">本域客观题历史</UButton>
      <UButton variant="outline" @click="refresh()">刷新结果</UButton>
    </div>
    <AsyncContent :status="error ? 'error' : status === 'pending' ? 'loading' : data ? 'data' : 'empty'"
      :error="error ? extractApiError(error).message : undefined" @retry="refresh()">
      <OwnSubmissionRecord v-if="data" :entry="data.data" />
      <ClientOnly v-if="data">
        <div class="flex flex-wrap gap-3">
          <DomainUpgradeAction :slug="slug!" :source="{ kind: 'objective', id: data.data.id }"
            :source-version="data.data.submitted_version_id"
            :eligible="data.data.resource_available && !data.data.contest_id && data.data.result_visibility !== 'hidden' && !['pending', 'judging'].includes(data.data.status)" />
          <DomainRejudgeAction :slug="slug!"
            :scope="{ type: 'selected', submissions: [{ kind: 'objective', id: data.data.id }] }"
            label="重测此回答" :eligible="data.data.resource_available && !data.data.contest_id" />
        </div>
      </ClientOnly>
    </AsyncContent>
  </div>
</template>
