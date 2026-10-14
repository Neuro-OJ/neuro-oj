<script setup lang="ts">
import { workspaceCacheKey } from '~/utils/workspace';
import { extractApiError } from '~/utils/apiError';
const props = defineProps<{ slug: string; reference: string }>();
const { user } = useAuth(), api = useDomainProblems(), page = ref(1);
const key = computed(() =>
  workspaceCacheKey(props.slug, user.value?.id ?? null, 'problem-versions', props.reference, String(page.value))
);
const { data, status, error, refresh } = await useAsyncData(
  key,
  () => api.versions(props.slug, props.reference, page.value),
);
watch(() => [props.slug, props.reference, user.value?.id], () => {
  page.value = 1;
});
</script>
<template>
  <UCard>
    <div class="mb-4 flex justify-between gap-3">
      <h3 class="font-semibold">题目版本沿革</h3>
      <UButton variant="ghost" icon="i-lucide-refresh-cw" aria-label="刷新版本沿革" @click="refresh()" />
    </div>
    <p
      class="mb-3 text-sm text-text-secondary">作答版本由当前域题库策略决定。沿革仅展示发布依据，查看历史不会切换作答版本。</p>
    <AsyncContent :status="error ? 'error' : status === 'pending' ? 'loading' : data?.items.length ? 'data' : 'empty'"
      :error="error ? extractApiError(error).message : undefined" empty-text="没有可展示的发布版本" @retry="refresh()">
      <ol v-if="data && !error" class="divide-y divide-border">
        <li v-for="version in data.items" :key="version.version_id" class="space-y-2 py-3">
          <div
            class="flex flex-wrap justify-between gap-2"><div class="flex items-center gap-2"><span class="font-semibold tabular-nums">V{{ version.version }}</span><UBadge v-if="version.version_id === data.answer_version_id" variant="subtle">当前作答版本</UBadge></div><span class="text-xs tabular-nums text-text-muted">{{ new Date(version.published_at).toLocaleString() }}</span></div>
          <p class="whitespace-pre-wrap text-sm text-text-secondary">{{ version.change_note || '未填写更新说明' }}</p>
        </li>
      </ol>
    </AsyncContent>
    <UPagination v-if="data && !error && data.total > data.limit" v-model:page="page" :total="data.total"
      :items-per-page="data.limit" class="mt-4" />
  </UCard>
</template>
