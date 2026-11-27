<script setup lang="ts">
import { formatDateTime } from '~/utils/domain/submission/submissionFormat';
import { workspaceCacheKey } from '~/utils/domain/workspace/workspace';
import { DOMAIN_CONTEST_TYPES } from '~/utils/domain/contest/domain-contests';
import { extractApiError } from '~/utils/server/apiError';
definePageMeta({
  layout: 'workspace',
  middleware: 'workspace-context',
  workspaceWidth: 'library',
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
  <div class="space-y-3">
    <LibraryPageHeader title="比赛" description="OI、IOI、ACM/ICPC 与 AI 竞赛"
      :count="data ? `${data.pagination.total} 场` : undefined">
      <template #actions>
        <UButton v-if="can('contest:manage') || can('contest:manage_own')" :to="`/d/${slug}/contests/new`" size="xs"
          icon="i-lucide-plus">创建比赛</UButton>
      </template>
    </LibraryPageHeader>
    <AsyncContent :status="error ? 'error' : data?.data.length ? 'data' : status === 'pending' ? 'loading' : 'empty'"
      :error="error ? extractApiError(error).message : undefined" empty-text="暂无比赛" @retry="refresh()">
      <div class="overflow-x-auto rounded-lg border border-border bg-bg-panel">
        <table class="w-full text-[13px]">
          <thead class="bg-bg-sunken/60 text-left text-xs text-text-muted">
            <tr>
              <th class="w-20 px-3 py-2 font-medium">状态</th>
              <th class="px-3 py-2 font-medium">比赛</th>
              <th class="w-24 px-3 py-2 font-medium">赛制</th>
              <th class="w-40 px-3 py-2 font-medium">开始</th>
              <th class="w-40 px-3 py-2 font-medium">结束</th>
              <th class="w-16 px-3 py-2 text-right font-medium">题数</th>
              <th class="w-16 px-3 py-2 text-right font-medium">人数</th>
            </tr>
          </thead>
          <tbody class="divide-y divide-border">
            <tr v-for="contest in data?.data" :key="contest.id" class="hover:bg-bg-sunken/50">
              <td class="whitespace-nowrap px-3 py-1.5">
                <span class="inline-flex items-center gap-1.5"
                  :class="contest.status === 'running' ? 'text-verdict-accepted' : 'text-text-muted'">
                  <span class="size-1.5 rounded-[1px] bg-current" :class="contest.status === 'running' && 'animate-pulse'" />
                  {{ { pending: '未开始', running: '进行中', ended: '已结束' }[contest.status] }}
                </span>
              </td>
              <td class="max-w-0 px-3 py-1.5">
                <NuxtLink :to="`/d/${slug}/contests/${contest.id}`"
                  class="block truncate font-medium text-text no-underline hover:text-primary"
                  :title="contest.description || contest.title">
                  {{ contest.title }}
                </NuxtLink>
              </td>
              <td class="whitespace-nowrap px-3 py-1.5 font-mono text-xs text-text-secondary">
                {{ DOMAIN_CONTEST_TYPES.find((type) => type.value === contest.type)?.label }}
              </td>
              <td
                class="whitespace-nowrap px-3 py-1.5 font-mono text-xs tabular-nums text-text-secondary">{{ formatDateTime(contest.start_time) }}</td>
              <td
                class="whitespace-nowrap px-3 py-1.5 font-mono text-xs tabular-nums text-text-secondary">{{ formatDateTime(contest.end_time) }}</td>
              <td class="px-3 py-1.5 text-right font-mono tabular-nums">{{ contest.problem_count }}</td>
              <td class="px-3 py-1.5 text-right font-mono tabular-nums">{{ contest.participant_count }}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </AsyncContent>
    <PaginationNav v-if="data && data.pagination.total_pages > 1" :current-page="page"
      :total-pages="data.pagination.total_pages" @page-change="page = $event" />
  </div>
</template>
