<script setup lang="ts">
import { workspaceCacheKey, workspaceProblemPath } from '~/utils/workspace';
import { extractApiError } from '~/utils/apiError';
definePageMeta({ layout: 'workspace', middleware: 'workspace-context' });
const { slug, can, domain } = useWorkspace();
const { user } = useAuth();
const api = useDomainProblems();
const controls = useProblemFilters();
const page = controls.page, search = controls.keyword;
const keyword = ref(search.value);
watch(search, value => { keyword.value = value; });
const difficulty = computed({ get: () => controls.difficulty.value || 'all', set: value => controls.setFilter('difficulty', value === 'all' ? null : value) });
const kind = computed({ get: () => controls.kind.value || 'all', set: value => controls.setFilter('kind', value === 'all' ? null : value) });
const progress = computed({ get: () => controls.progress.value || 'all', set: value => controls.setFilter('progress', value === 'all' ? null : value) });
const tag = computed({ get: () => controls.tagId.value || 'all', set: value => controls.setFilter('tag', value === 'all' ? null : value) });
const filters = computed(() => ({ difficulty: difficulty.value === 'all' ? undefined : difficulty.value,
  kind: kind.value === 'all' ? undefined : kind.value, progress: user.value && progress.value !== 'all' ? progress.value : undefined,
  tag_id: tag.value === 'all' ? undefined : tag.value }));
const key = computed(() =>
  workspaceCacheKey(slug.value!, user.value?.id ?? null, `problems:${page.value}:${search.value}:${JSON.stringify(filters.value)}`)
);
const { data, status, error, refresh } = await useAsyncData(key, () => api.list(slug.value!, page.value, search.value, filters.value));
function find() {
  controls.setFilter('keyword', keyword.value.trim());
}
useSeoMeta({ title: '空间题库' });
</script>
<template>
  <div class="space-y-4">
    <div class="flex flex-wrap justify-between gap-3">
      <h2 class="text-xl font-semibold">空间题库</h2>
      <UButton v-if="domain?.status === 'active' && (can('problem:write_own') || can('problem:write_any'))"
        :to="`/d/${slug}/problems/new`" icon="i-lucide-plus">创建本域题目</UButton>
      <UButton v-if="can('problem:write_own') || can('problem:write_any')" :to="`/d/${slug}/problem-drafts`"
        variant="outline">题目草稿</UButton>
      <UButton v-if="can('problem:policy') || can('problem:write_own') || can('problem:write_any')"
        :to="`/d/${slug}/problem-bindings`" variant="outline">资源管理</UButton>
    </div>
    <form class="flex gap-2" @submit.prevent="find">
      <UInput v-model="keyword" placeholder="题号、来源题号或标题" aria-label="搜索题目" class="flex-1" />
      <UButton type="submit" icon="i-lucide-search">搜索</UButton>
    </form>
    <div class="flex flex-wrap items-center gap-3">
      <USelect v-model="kind" :items="[{label:'全部题型',value:'all'},{label:'OI',value:'oi'},{label:'AI / LLM / 产物',value:'ai'},{label:'客观题',value:'objective'}]" aria-label="筛选题型" />
      <USelect v-model="difficulty" :items="[{label:'全部难度',value:'all'},{label:'简单',value:'easy'},{label:'中等',value:'medium'},{label:'困难',value:'hard'}]" aria-label="筛选难度" />
      <USelect v-if="user" v-model="progress" :items="[{label:'全部本人状态',value:'all'},{label:'已通过',value:'solved'},{label:'尝试未通过',value:'attempted'},{label:'未尝试',value:'unseen'}]" aria-label="筛选本人状态" />
      <UButton v-if="tag !== 'all'" color="neutral" variant="outline" icon="i-lucide-x" @click="tag = 'all'">清除标签筛选</UButton>
      <UButton v-if="kind !== 'all' || difficulty !== 'all' || progress !== 'all' || tag !== 'all'" color="neutral" variant="ghost" @click="controls.setFilters({kind:null,difficulty:null,progress:null,tag:null})">重置筛选</UButton>
    </div>
    <AsyncContent :status="error ? 'error' : status === 'pending' ? 'loading' : data?.items.length ? 'data' : 'empty'"
      :error="error ? extractApiError(error).message : undefined" empty-text="暂无可访问的题目" @retry="refresh()">
      <div class="divide-y divide-border rounded border border-border bg-bg-panel">
        <div v-for="problem in data?.items" :key="problem.binding_id" class="flex flex-wrap items-center justify-between gap-3 p-4">
          <div class="min-w-0 flex-1">
            <NuxtLink :to="workspaceProblemPath(slug!, problem.reference.display_ref)" class="font-medium hover:text-primary">
              <span class="mr-3 font-mono tabular-nums text-primary">{{ problem.reference.display_ref }}</span>{{ problem.title }}
            </NuxtLink>
            <div v-if="problem.tags?.length || problem.has_hidden_algorithm_tags" class="mt-2 flex flex-wrap items-center gap-2">
              <UButton v-for="label in problem.tags" :key="label.id" color="neutral" variant="soft" size="xs" @click="tag = label.id">{{ label.name }}</UButton>
              <span v-if="problem.has_hidden_algorithm_tags" class="text-xs text-text-muted">通过后显示算法标签</span>
            </div>
          </div>
          <div class="flex flex-wrap items-center gap-3 text-xs text-text-muted">
            <UBadge v-if="user && problem.progress && problem.progress !== 'unseen'" :color="problem.progress === 'solved' ? 'success' : 'neutral'" variant="subtle">{{ problem.progress === 'solved' ? '已通过' : '尝试未通过' }}</UBadge>
            <DifficultyBadge v-if="problem.difficulty" :difficulty="problem.difficulty" />
            <span>{{ { oi: 'OI', ai: 'AI', objective: '客观题' }[problem.kind] }}</span><span>V{{ problem.version }}</span>
            <span v-if="problem.valid_submissions" class="tabular-nums">{{ ((problem.accepted_submissions ?? 0) * 100 / problem.valid_submissions).toFixed(1) }}% 通过 · {{ problem.valid_submissions }} 次有效提交</span>
            <span v-else>暂无有效提交</span>
          </div>
        </div>
      </div>
    </AsyncContent>
    <div v-if="data && data.total > 30" class="flex items-center justify-between">
      <UButton variant="outline" :disabled="page === 1" @click="controls.setFilter('page', String(page - 1))">上一页</UButton>
      <span class="text-sm tabular-nums">第 {{ page }} 页 · {{ data.total }} 道题</span>
      <UButton variant="outline" :disabled="page * 30 >= data.total" @click="controls.setFilter('page', String(page + 1))">下一页</UButton>
    </div>
  </div>
</template>
