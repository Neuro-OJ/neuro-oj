<script setup lang="ts">
import { workspaceCacheKey } from '~/utils/workspace';
import { extractApiError } from '~/utils/apiError';
definePageMeta({ layout: 'workspace', middleware: 'workspace-context' });
const { slug } = useWorkspace(), { user } = useAuth(), api = useDomainQuery(), page = ref(1);
const { data, error, status, refresh } = await useAsyncData(
  () => workspaceCacheKey(slug.value!, user.value?.id ?? null, 'rankings', String(page.value)),
  () => api.rankings(slug.value!, page.value),
);
const mine = await useAsyncData(
  () => workspaceCacheKey(slug.value!, user.value?.id ?? null, 'my-ranking'),
  () => user.value ? api.mine(slug.value!) : Promise.resolve(null),
);
useSeoMeta({ title: '域排行榜' });
</script>
<template>
  <div class="space-y-5">
    <AdminPageHeader title="排行榜" description="仅统计当前域可展示资源和已公开比赛结果" />
    <div v-if="mine.data.value?.data" class="flex flex-wrap items-center justify-between gap-4 rounded-lg border border-primary/20 bg-primary-bg/30 px-5 py-3.5 shadow-xs">
      <div class="flex items-center gap-3">
        <UIcon name="i-lucide-award" class="size-5 text-primary" />
        <span class="text-sm font-medium text-text">我的当前排名</span>
      </div>
      <div class="flex items-center gap-4 text-xs tabular-nums">
        <span class="rounded bg-white/80 px-2.5 py-1 font-semibold text-primary border border-border shadow-2xs">
          第 <strong class="text-sm">{{ mine.data.value.data.rank }}</strong> 名
        </span>
        <span class="text-text-secondary">
          通过 <strong class="text-text font-bold">{{ mine.data.value.data.solved_count }}</strong> 题
        </span>
      </div>
    </div>
    <AsyncContent :status="error ? 'error' : status === 'pending' ? 'loading' : data?.data.length ? 'data' : 'empty'"
      :error="error ? extractApiError(error).message : undefined" empty-text="暂无排名数据" @retry="refresh()">
      <div class="overflow-x-auto rounded-lg border border-border bg-bg-panel shadow-card">
        <table class="w-full text-sm" aria-label="域排行榜">
          <thead class="border-b border-border bg-bg-sunken/40 text-left text-xs font-semibold text-text-muted">
            <tr>
              <th class="px-4 py-3 w-20 text-center">名次</th>
              <th class="px-4 py-3">用户</th>
              <th class="px-4 py-3 text-right">通过题数</th>
              <th class="px-4 py-3 text-right">总提交数</th>
              <th class="px-4 py-3 text-right">有效通过率</th>
            </tr>
          </thead>
          <tbody class="divide-y divide-border">
            <tr v-for="row in data?.data" :key="row.user_id" class="transition-colors hover:bg-primary-hover-bg/30">
              <td class="px-4 py-3 text-center tabular-nums font-mono font-bold">
                <span
                  v-if="row.rank === 1"
                  class="inline-flex size-6 items-center justify-center rounded-full bg-amber-400/20 text-amber-600 text-xs"
                >1</span>
                <span
                  v-else-if="row.rank === 2"
                  class="inline-flex size-6 items-center justify-center rounded-full bg-slate-400/20 text-slate-600 text-xs"
                >2</span>
                <span
                  v-else-if="row.rank === 3"
                  class="inline-flex size-6 items-center justify-center rounded-full bg-amber-700/20 text-amber-700 text-xs"
                >3</span>
                <span v-else class="text-text-muted text-xs">{{ row.rank }}</span>
              </td>
              <td class="px-4 py-3">
                <UserIdentity :user="{ id: row.user_id, username: row.username }" :link="false" />
              </td>
              <td class="px-4 py-3 text-right tabular-nums font-semibold text-text">{{ row.solved_count }}</td>
              <td class="px-4 py-3 text-right tabular-nums text-text-secondary">{{ row.total_submissions }}</td>
              <td class="px-4 py-3 text-right tabular-nums text-text-secondary">{{ (row.acceptance_rate * 100).toFixed(1) }}%</td>
            </tr>
          </tbody>
        </table>
      </div>
      <PaginationNav :current-page="page" :total-pages="data?.pagination.total_pages ?? 0"
        @page-change="page = $event" />
    </AsyncContent>
  </div>
</template>
