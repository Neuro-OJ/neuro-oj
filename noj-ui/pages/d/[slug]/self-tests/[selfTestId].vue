<script setup lang="ts">
import { workspaceCacheKey } from '~/utils/workspace';
import { extractApiError } from '~/utils/apiError';
definePageMeta({ layout: 'workspace', middleware: ['auth', 'workspace-context'] });
const route = useRoute(),
  { slug } = useWorkspace(),
  { user } = useAuth(),
  api = useDomainSelfTests(),
  capture = useWorkspaceActionScope();
const id = computed(() => String(route.params.selfTestId)), cancelling = ref(false);
const key = computed(() => workspaceCacheKey(slug.value!, user.value?.id ?? null, 'self-test', id.value));
const { data, error, status, refresh } = await useAsyncData(key, () => api.detail(slug.value!, id.value));
const pending = computed(() => !!data.value && ['pending', 'judging'].includes(data.value.data.status));
usePolling({
  intervalMs: computed(() => pending.value && !error.value ? 1500 : null),
  immediate: false,
  fetcher: () => refresh(),
});
async function cancel() {
  const scope = capture(), target = id.value;
  cancelling.value = true;
  try {
    await api.cancel(scope.slug, target);
    if (scope.isCurrent() && id.value === target) await refresh();
  } finally {
    if (scope.isCurrent()) cancelling.value = false;
  }
}
useSeoMeta({ title: '代码自测详情' });
</script>
<template>
  <AsyncContent :status="error ? 'error' : status === 'pending' ? 'loading' : data ? 'data' : 'empty'"
    :error="error ? extractApiError(error).message : undefined" @retry="refresh()">
    <div v-if="data" class="space-y-4">
      <div class="flex flex-wrap justify-between gap-3">
        <h2 class="text-xl font-semibold">{{ data.data.reference.display_ref }} · 代码自测</h2>
        <UButton variant="ghost" icon="i-lucide-refresh-cw" aria-label="刷新自测" @click="refresh()" />
        <UButton v-if="pending" color="error" variant="outline" :loading="cancelling" @click="cancel">取消运行</UButton>
      </div>
      <p
        class="break-all text-xs text-text-muted">{{ data.data.id }} · 使用域 {{ slug }} · 自测不计正式成绩或作业进度</p>
      <DomainSelfTestResult :record="data.data" />
      <UCard v-if="data.data.code != null">
        <h3 class="mb-3 font-semibold">原自测代码</h3>
        <pre class="max-h-96 overflow-auto whitespace-pre font-mono text-xs">{{ data.data.code }}</pre>
      </UCard>
    </div>
  </AsyncContent>
</template>
