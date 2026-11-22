<script setup lang="ts">
import { formatDateTime } from '~/utils/submissionFormat';
import { workspaceCacheKey } from '~/utils/workspace';
import { DOMAIN_CONTEST_TYPES } from '~/utils/domain-contests';
import { extractApiError } from '~/utils/apiError';
definePageMeta({
  layout: 'workspace',
  middleware: 'workspace-context',
  workspaceWidth: 'library',
  breadcrumbWidth: '960px',
});
const { slug, can } = useWorkspace();
const { user } = useAuth();
const api = useDomainContests();
const page = ref(1);
const key = computed(() => workspaceCacheKey(slug.value!, user.value?.id ?? null, `contests:${page.value}`));
const { data, error, status, refresh } = await useAsyncData(key, () => api.list(slug.value!, page.value));
useSeoMeta({ title: '比赛' });
</script>
<template>
  <div class="space-y-5">
    <LibraryPageHeader title="比赛" icon="i-lucide-trophy" description="OI、IOI、ACM/ICPC 与 AI 竞赛" :count="`共 ${data?.pagination.total ?? '—'} 场比赛`">
      <template #actions>
        <UButton v-if="can('contest:manage') || can('contest:manage_own')" :to="`/d/${slug}/contests/new`" size="sm" icon="i-lucide-plus">创建比赛</UButton>
      </template>
    </LibraryPageHeader>
    <AsyncContent :status="error?'error':data?.data.length?'data':status==='pending'?'loading':'empty'"
      :error="error?extractApiError(error).message:undefined" empty-text="暂无比赛" @retry="refresh()">
      <div class="grid gap-5 md:grid-cols-2 xl:grid-cols-3">
        <NuxtLink v-for="contest in data?.data" :key="contest.id" :to="`/d/${slug}/contests/${contest.id}`"
          class="group flex min-h-60 flex-col rounded-lg border border-border bg-bg-panel p-5 text-text no-underline shadow-card transition-all duration-150 hover:border-primary/50 hover:shadow-dropdown hover:-translate-y-0.5">
          <div class="flex flex-wrap items-start justify-between gap-2">
            <UBadge color="primary"
              variant="subtle">{{ DOMAIN_CONTEST_TYPES.find((type) => type.value === contest.type)?.label }}</UBadge>
            <UBadge :color="contest.status==='running'?'success':'neutral'"
              variant="subtle">{{ {pending:'未开始',running:'进行中',ended:'已结束'}[contest.status] }}</UBadge>
          </div>
          <h2 class="mt-5 line-clamp-2 break-words text-lg font-bold group-hover:text-primary">{{ contest.title }}</h2>
          <p
            class="mt-2 line-clamp-2 text-sm leading-6 text-text-secondary">{{ contest.description || '查看比赛介绍与参赛要求' }}</p>
          <div class="mt-auto space-y-2 border-t border-border pt-4 text-xs tabular-nums text-text-secondary">
            <p
              class="mt-3 flex items-center gap-2"><UIcon name="i-lucide-calendar-clock" class="size-3.5 shrink-0" />{{ formatDateTime(contest.start_time) }}</p>
            <p>结束于 {{ formatDateTime(contest.end_time) }}</p>
            <p>{{ contest.participant_count }} 人参赛 · {{ contest.problem_count }} 道题</p>
          </div>
        </NuxtLink>
      </div>
    </AsyncContent>
    <PaginationNav v-if="data && data.pagination.total_pages>1" :current-page="page"
      :total-pages="data.pagination.total_pages" @page-change="page=$event" />
  </div>
</template>
