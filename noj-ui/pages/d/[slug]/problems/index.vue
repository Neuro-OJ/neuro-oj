<script setup lang="ts">
import { workspaceCacheKey, workspaceProblemPath } from '~/utils/domain/workspace/workspace';
import { extractApiError } from '~/utils/server/apiError';
import TableSkeleton from '~/components/base/TableSkeleton.vue';
definePageMeta({
  layout: 'workspace',
  middleware: 'workspace-context',
  workspaceWidth: 'library',
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
  { accessorKey: 'reference', header: '#', meta: { class: { th: 'w-16', td: 'font-mono tabular-nums' } } },
  { accessorKey: 'title', header: '题目', meta: { class: { th: 'min-w-36 w-full', td: 'min-w-36 max-w-0' } } },
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
  ...(can('problem:write_any')
    ? [{ label: '题目草稿', to: `/d/${slug.value}/problem-drafts`, icon: 'i-lucide-file-pen-line' }]
    : []),
  ...(can('problem:policy') || can('problem:write_any')
    ? [{ label: '资源管理', to: `/d/${slug.value}/problem-bindings`, icon: 'i-lucide-library-big' }]
    : []),
]);
useSeoMeta({ title: '题库' });
</script>
<template>
  <div class="space-y-3">
    <LibraryPageHeader title="题库" :description="domain?.name ?? ''" :count="`${data?.total ?? '—'} 题`">
      <template #actions>
        <UButton v-if="domain?.status==='active' && (can('problem:write_any'))"
          :to="`/d/${slug}/problems/new`" size="xs" icon="i-lucide-plus">创建题目</UButton>
        <UDropdownMenu v-if="manageItems.length" :items="manageItems">
          <UButton color="neutral" variant="outline" size="xs" trailing-icon="i-lucide-chevron-down">管理</UButton>
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
      <template #loading>
        <TableSkeleton :rows="12" :columns="['w-16', 'flex-1', 'w-14', 'w-28', 'w-14', 'w-14', 'w-16']" />
      </template>
      <div class="overflow-x-auto rounded-lg border border-border bg-bg-panel">
        <UTable :columns="columns" :data="rows"
          :ui="{tr:'transition-colors hover:bg-bg-sunken/50', td:'px-3 py-1.5 text-[13px]'}">
          <template #reference-cell="{row}">
            <NuxtLink :to="workspaceProblemPath(slug!,row.original.reference.display_ref)"
              class="whitespace-nowrap font-mono text-xs text-text-secondary no-underline hover:text-primary">{{ row.original.reference.display_ref }}</NuxtLink>
          </template>
          <template #title-cell="{row}">
            <div class="flex min-w-0 items-center gap-2"
              :class="{'contest-protected !p-0.5': row.original.contest_protection?.length}">
              <NuxtLink :to="workspaceProblemPath(slug!,row.original.reference.display_ref)"
                class="truncate font-medium text-text no-underline hover:text-primary hover:underline">{{ row.original.title }}</NuxtLink>
              <span
                class="shrink-0 font-mono text-[11px] text-text-muted">{{ {oi:'OI',ai:'AI',objective:'客观'}[row.original.kind] }}<template v-if="row.original.judge_backend">·{{ row.original.judge_backend }}</template></span>
              <span v-if="row.original.contest_protection?.length"
                class="inline-flex shrink-0 items-center gap-0.5 text-[11px] text-text-secondary"
                title="比赛赛题 · 受保护"><UIcon name="i-lucide-lock-keyhole" class="size-3" />赛题</span>
              <span v-if="user && row.original.best_score != null"
                class="font-mono text-[11px] text-success-text sm:hidden">{{ (row.original.best_score / 100).toFixed(2) }}</span>
            </div>
          </template>
          <template
            #difficulty-cell="{row}"><ProblemDifficultyBadge v-if="row.original.difficulty" :difficulty="row.original.difficulty" /><span v-else class="text-xs text-text-muted">—</span></template>
          <template #tags-cell="{row}">
            <div class="flex max-w-64 items-center gap-1 overflow-hidden">
              <button v-for="label in (row.original.tags ?? []).slice(0, 3)" :key="label.id" type="button"
                class="shrink-0 rounded-[4px] bg-bg-sunken px-1.5 text-[11px] leading-5 text-text-secondary transition-colors hover:bg-primary-bg hover:text-primary"
                @click="controls.setFilter('tag',label.id)">{{ label.name }}</button>
              <span
                v-if="(row.original.tags?.length ?? 0) > 3"
                class="shrink-0 font-mono text-[11px] text-text-muted"
                :title="(row.original.tags ?? []).slice(3).map((t) => t.name).join('、')"
              >+{{ row.original.tags!.length - 3 }}</span>
              <span v-if="row.original.has_hidden_algorithm_tags"
                class="text-[11px] text-text-muted">通过后显示</span>
              <span v-else-if="!row.original.tags?.length" class="text-text-muted">—</span>
            </div>
          </template>
          <template
            #time-cell="{row}"><span class="whitespace-nowrap font-mono text-xs text-text-secondary">{{ row.original.kind === 'objective' ? '即时' : row.original.limits?.time_limit_ms != null ? `${row.original.limits.time_limit_ms}ms` : '—' }}</span></template>
          <template
            #memory-cell="{row}"><span class="whitespace-nowrap font-mono text-xs text-text-secondary">{{ row.original.limits?.memory_limit_mb != null ? `${row.original.limits.memory_limit_mb}MB` : '—' }}</span></template>
          <template
            #rate-cell="{row}"><span class="font-mono text-xs text-text-secondary" :title="`${row.original.accepted_submissions ?? 0} 次通过 / ${row.original.valid_submissions ?? 0} 次有效提交`">{{ row.original.valid_submissions ? `${((row.original.accepted_submissions ?? 0)*100/row.original.valid_submissions).toFixed(1)}%` : '—' }}<span v-if="row.original.valid_submissions" class="ml-1 text-text-muted">{{ row.original.accepted_submissions ?? 0 }}/{{ row.original.valid_submissions }}</span></span></template>
          <template
            #progress-cell="{row}"><span class="inline-flex items-center gap-1.5 whitespace-nowrap text-xs" :class="row.original.progress==='solved' ? 'text-success-text' : row.original.progress==='attempted' ? 'text-warning-text' : 'text-text-muted'"><span class="size-1.5 rounded-full" :class="row.original.progress==='solved' ? 'bg-success-text' : row.original.progress==='attempted' ? 'bg-warning-text' : 'bg-border-strong'" />{{ {solved:'通过',attempted:'尝试',unseen:'—'}[row.original.progress ?? 'unseen'] }}<span v-if="row.original.best_score != null" class="font-mono">{{ (row.original.best_score / 100).toFixed(2) }}</span></span></template>
        </UTable>
      </div>
      <PaginationNav v-if="data && data.total>30" class="mt-3" :current-page="page"
        :total-pages="Math.ceil(data.total/30)" @page-change="controls.setFilter('page',String($event))" />
    </AsyncContent>
  </div>
</template>
