<script setup lang="ts">
import { workspaceCacheKey, workspaceProblemPath } from '~/utils/workspace';
import { extractApiError } from '~/utils/apiError';
definePageMeta({ layout: 'workspace', middleware: 'workspace-context' });
const { slug } = useWorkspace();
const { user } = useAuth();
const api = useDomainProblems();
const page = ref(1);
const keyword = ref('');
const search = ref('');
const key = computed(() =>
  workspaceCacheKey(slug.value!, user.value?.id ?? null, `problems:${page.value}:${search.value}`)
);
const { data, status, error, refresh } = await useAsyncData(key, () => api.list(slug.value!, page.value, search.value));
function find() {
  page.value = 1;
  search.value = keyword.value;
}
useSeoMeta({ title: '空间题库' });
</script>
<template>
  <div class="space-y-4">
    <form class="flex gap-2" @submit.prevent="find">
      <UInput v-model="keyword" placeholder="搜索题目标题" aria-label="搜索题目" class="flex-1" />
      <UButton type="submit" icon="i-lucide-search">搜索</UButton>
    </form>
    <AsyncContent :status="error ? 'error' : status === 'pending' ? 'loading' : data?.items.length ? 'data' : 'empty'"
      :error="error ? extractApiError(error).message : undefined" empty-text="暂无可访问的题目" @retry="refresh()">
      <div class="divide-y divide-border rounded border border-border bg-bg-panel">
        <NuxtLink v-for="problem in data?.items" :key="problem.binding_id"
          :to="workspaceProblemPath(slug!, problem.reference.display_ref)"
          class="flex items-center justify-between gap-3 p-4 hover:bg-primary-bg">
          <div><span class="mr-3 font-mono tabular-nums text-primary">{{ problem.reference.display_ref }}</span>{{ problem.title }}</div>
          <div
            class="flex gap-2 text-xs text-text-muted"><span>{{ { oi: 'OI', ai: 'AI', objective: '客观题' }[problem.kind] }}</span><span>V{{ problem.version }}</span></div>
        </NuxtLink>
      </div>
    </AsyncContent>
    <div v-if="data && data.total > 30" class="flex items-center justify-between">
      <UButton variant="outline" :disabled="page === 1" @click="page--">上一页</UButton>
      <span class="text-sm tabular-nums">第 {{ page }} 页 · {{ data.total }} 道题</span>
      <UButton variant="outline" :disabled="page * 30 >= data.total" @click="page++">下一页</UButton>
    </div>
  </div>
</template>
