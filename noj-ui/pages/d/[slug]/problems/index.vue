<script setup lang="ts">
import { workspaceCacheKey, workspaceProblemPath } from '~/utils/workspace';
import { extractApiError } from '~/utils/apiError';
definePageMeta({
  layout: 'workspace',
  middleware: 'workspace-context',
  workspaceWidth: 'library',
  breadcrumbWidth: '960px',
});
const { slug, can, domain } = useWorkspace(), { user } = useAuth();
const api = useDomainProblems(), controls = useProblemFilters(), router = useRouter();
const { page, keyword, difficulty, kind, progress, tagId, judgeBackend } = controls;
const filters = computed(() => ({
  difficulty: difficulty.value || undefined,
  kind: kind.value || undefined,
  progress: user.value ? progress.value || undefined : undefined,
  tag_id: tagId.value || undefined,
  judge_backend: judgeBackend.value || undefined,
}));
const key = computed(() =>
  workspaceCacheKey(
    slug.value!,
    user.value?.id ?? null,
    `problems:${page.value}:${keyword.value}:${JSON.stringify(filters.value)}`,
  )
);
const { data, status, error, refresh } = await useAsyncData(
  key,
  () => api.list(slug.value!, page.value, keyword.value, filters.value),
);
const rows = computed(() => data.value?.items ?? []);
const columns = computed(() => [
  { accessorKey: 'reference', header: '#', meta: { class: { th: 'w-20', td: 'align-top font-mono tabular-nums' } } },
  { accessorKey: 'title', header: '题目', meta: { class: { th: 'min-w-36', td: 'min-w-36 whitespace-normal' } } },
  { accessorKey: 'difficulty', header: '难度' },
  ...['tags', 'time', 'memory', 'rate', ...(user.value ? ['progress'] : [])].map((key) => ({
    accessorKey: key,
    header:
      ({ tags: '标签', time: '时间', memory: '内存', rate: '通过率', progress: '我的进度' } as Record<string, string>)[
        key
      ]!,
    meta: {
      class: {
        th: key === 'tags' ? 'hidden lg:table-cell' : 'hidden sm:table-cell',
        td: key === 'tags' ? 'hidden lg:table-cell' : 'hidden sm:table-cell',
      },
    },
  })),
]);
const manageItems = computed(() => [
  ...(can('problem:write_own') || can('problem:write_any')
    ? [{ label: '题目草稿', to: `/d/${slug.value}/problem-drafts`, icon: 'i-lucide-file-pen-line' }]
    : []),
  ...(can('problem:policy') || can('problem:write_own') || can('problem:write_any')
    ? [{ label: '资源管理', to: `/d/${slug.value}/problem-bindings`, icon: 'i-lucide-library-big' }]
    : []),
]);
useSeoMeta({ title: '题库' });
</script>
<template>
  <div class="space-y-5">
    <LibraryPageHeader title="题库" :description="`${domain?.name ?? ''} · 算法与 AI 在线评测`" icon="i-lucide-book-open" :count="`共 ${data?.total ?? '—'} 道题`">
      <template #actions>
        <UButton v-if="domain?.status==='active' && (can('problem:write_own') || can('problem:write_any'))"
          :to="`/d/${slug}/problems/new`" size="sm" icon="i-lucide-plus">创建题目</UButton>
        <UDropdownMenu v-if="manageItems.length" :items="manageItems">
          <UButton color="neutral" variant="outline" size="sm" trailing-icon="i-lucide-chevron-down">管理题库</UButton>
        </UDropdownMenu>
      </template>
    </LibraryPageHeader>
    <ProblemFilterBar :keyword="keyword" :difficulty="difficulty" :kind="kind" :judge-backend="judgeBackend"
      :progress="progress" :signed-in="!!user"
      :tag-id="tagId" :tags="data?.tags ?? []"
      @update:keyword="controls.setFilter('keyword',$event)"
      @update:difficulty="controls.setFilter('difficulty',$event)"
      @update:kind="controls.setFilter('kind',$event)"
      @update:judge-backend="controls.setFilter('judge_backend',$event)"
      @update:progress="controls.setFilter('progress',$event)" @update:tag-id="controls.setFilter('tag',$event)"
      @reset="router.push({query:{}})" />
    <AsyncContent :status="error ? 'error' : status === 'pending' ? 'loading' : rows.length ? 'data' : 'empty'"
      :error="error ? extractApiError(error).message : undefined" empty-text="暂无符合条件的题目" @retry="refresh()">
      <div class="overflow-x-auto rounded-lg border border-border bg-bg-panel shadow-card">
        <UTable :columns="columns" :data="rows" :ui="{th:'whitespace-nowrap px-3 py-3 text-xs',td:'px-3 py-3 text-sm'}">
          <template #reference-cell="{row}">
            <NuxtLink :to="workspaceProblemPath(slug!,row.original.reference.display_ref)"
              class="whitespace-nowrap text-xs text-primary no-underline"><ProblemId :display-id="row.original.reference.display_ref" type="T" /></NuxtLink>
          </template>
          <template #title-cell="{row}">
            <NuxtLink :to="workspaceProblemPath(slug!,row.original.reference.display_ref)"
              class="break-words font-medium leading-relaxed text-text no-underline hover:text-primary">{{ row.original.title }}</NuxtLink>
            <div class="mt-1 flex flex-wrap items-center gap-1.5 text-[11px] text-text-muted">
              <span
                class="rounded border border-primary/20 bg-primary-bg px-1.5 text-primary">{{ {oi:'OI',ai:'AI / LLM',objective:'客观题'}[row.original.kind] }}</span>
              <span v-if="row.original.judge_backend" class="rounded border border-border px-1.5 font-mono text-text-secondary">{{ row.original.judge_backend }}</span>
              <span v-if="user && row.original.progress==='solved'" class="text-success-text sm:hidden">已通过</span>
            </div>
          </template>
          <template
            #difficulty-cell="{row}"><DifficultyBadge v-if="row.original.difficulty" :difficulty="row.original.difficulty" /><span v-else class="text-xs text-text-muted">—</span></template>
          <template #tags-cell="{row}">
            <div class="flex max-w-40 flex-wrap gap-1">
              <button v-for="label in row.original.tags" :key="label.id" type="button"
                class="rounded-md border border-primary/20 bg-primary-bg px-2 py-0.5 text-xs text-primary transition-colors hover:bg-primary/10"
                @click="controls.setFilter('tag',label.id)">{{ label.name }}</button>
              <span v-if="row.original.has_hidden_algorithm_tags"
                class="text-xs text-text-muted">通过后显示算法标签</span>
              <span v-else-if="!row.original.tags?.length" class="text-text-muted">—</span>
            </div>
          </template>
          <template
            #time-cell="{row}"><span class="whitespace-nowrap text-xs tabular-nums text-text-secondary">{{ row.original.kind === 'objective' ? '即时' : row.original.limits?.time_limit_ms != null ? `${row.original.limits.time_limit_ms}ms` : '—' }}</span></template>
          <template
            #memory-cell="{row}"><span class="whitespace-nowrap text-xs tabular-nums text-text-secondary">{{ row.original.limits?.memory_limit_mb != null ? `${row.original.limits.memory_limit_mb}MB` : '—' }}</span></template>
          <template
            #rate-cell="{row}"><span class="text-xs tabular-nums text-text-secondary" :title="`${row.original.accepted_submissions ?? 0} 次通过 / ${row.original.valid_submissions ?? 0} 次有效提交`">{{ row.original.valid_submissions ? `${((row.original.accepted_submissions ?? 0)*100/row.original.valid_submissions).toFixed(1)}%` : '—' }}</span></template>
          <template
            #progress-cell="{row}"><span class="inline-flex items-center gap-1 whitespace-nowrap text-xs" :class="row.original.progress==='solved' ? 'text-success-text' : 'text-text-muted'"><UIcon :name="row.original.progress === 'solved' ? 'i-lucide-circle-check' : row.original.progress === 'attempted' ? 'i-lucide-circle-alert' : 'i-lucide-circle'" class="size-3.5" />{{ {solved:'已通过',attempted:'尝试未通过',unseen:'未尝试'}[row.original.progress ?? 'unseen'] }}</span></template>
        </UTable>
      </div>
      <PaginationNav v-if="data && data.total>30" class="mt-5" :current-page="page"
        :total-pages="Math.ceil(data.total/30)" @page-change="controls.setFilter('page',String($event))" />
    </AsyncContent>
  </div>
</template>
