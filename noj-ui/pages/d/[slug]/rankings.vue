<script setup lang="ts">
import { workspaceCacheKey } from '~/utils/domain/workspace/workspace';
import { extractApiError } from '~/utils/server/apiError';
definePageMeta({
  layout: 'workspace',
  middleware: 'workspace-context',
  workspaceWidth: 'library',
  breadcrumbWidth: '1008px',
});
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
  <div class="space-y-3">
    <LibraryPageHeader title="排行榜" description="当前域的训练与解题排名">
      <template #actions>
        <span v-if="mine.data.value?.data" class="font-mono text-xs tabular-nums text-text-secondary">
          我的排名 <strong class="text-text">#{{ mine.data.value.data.rank }}</strong>
          · 通过 <strong class="text-text">{{ mine.data.value.data.solved_count }}</strong>
        </span>
        <NuxtLink to="/leaderboard" class="text-xs text-primary no-underline hover:underline">全站榜单 →</NuxtLink>
      </template>
    </LibraryPageHeader>
    <AsyncContent :status="error ? 'error' : status === 'pending' ? 'loading' : data?.data.length ? 'data' : 'empty'"
      :error="error ? extractApiError(error).message : undefined" empty-text="暂无排名数据" @retry="refresh()">
      <div class="overflow-x-auto rounded-lg border border-border bg-bg-panel">
        <table class="w-full text-[13px]" aria-label="域排行榜">
          <thead class="border-b border-border bg-bg-sunken/60 text-left text-xs font-medium text-text-muted">
            <tr>
              <th class="w-16 px-3 py-2 text-right">#</th>
              <th class="px-3 py-2">用户</th>
              <th class="px-3 py-2 text-right">通过题数</th>
              <th class="hidden px-3 py-2 text-right sm:table-cell">总提交数</th>
              <th class="hidden px-3 py-2 text-right sm:table-cell">有效通过率</th>
            </tr>
          </thead>
          <tbody class="divide-y divide-border">
            <tr v-for="row in data?.data" :key="row.user_id" class="transition-colors hover:bg-bg-sunken/50">
              <td class="px-3 py-1.5 text-right font-mono text-xs tabular-nums">
                <span :class="row.rank <= 3 ? 'text-text' : 'text-text-muted'">{{ row.rank }}</span>
              </td>
              <td class="px-3 py-1.5">
                <UserIdentity :user="{ id: row.user_id, username: row.username }" :link="false" />
              </td>
              <td
                class="px-3 py-1.5 text-right font-mono tabular-nums font-medium text-text">{{ row.solved_count }}</td>
              <td
                class="hidden px-3 py-1.5 text-right font-mono tabular-nums text-text-secondary sm:table-cell">{{ row.total_submissions }}</td>
              <td
                class="hidden px-3 py-1.5 text-right font-mono tabular-nums text-text-secondary sm:table-cell">{{ (row.acceptance_rate * 100).toFixed(1) }}%</td>
            </tr>
          </tbody>
        </table>
      </div>
      <PaginationNav :current-page="page" :total-pages="data?.pagination.total_pages ?? 0"
        @page-change="page = $event" />
    </AsyncContent>
  </div>
</template>
