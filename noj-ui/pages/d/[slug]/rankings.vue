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
    <UCard v-if="mine.data.value?.data">
      <p
        class="text-sm">我的名次 <span class="font-semibold tabular-nums">{{ mine.data.value.data.rank }}</span> · 通过 <span class="tabular-nums">{{ mine.data.value.data.solved_count }}</span> 题</p>
    </UCard>
    <AsyncContent :status="error ? 'error' : status === 'pending' ? 'loading' : data?.data.length ? 'data' : 'empty'"
      :error="error ? extractApiError(error).message : undefined" @retry="refresh()">
      <div class="overflow-x-auto rounded border border-border">
        <table class="w-full text-sm">
          <thead class="bg-bg-panel text-left">
            <tr>
              <th class="p-3">名次</th>
              <th class="p-3">用户</th>
              <th class="p-3">通过题数</th>
              <th class="p-3">提交数</th>
              <th class="p-3">有效提交通过率</th>
            </tr>
          </thead>
          <tbody class="divide-y divide-border">
            <tr v-for="row in data?.data" :key="row.user_id">
              <td class="p-3 tabular-nums">{{ row.rank }}</td>
              <td class="p-3">
                <UserIdentity :user="{ id: row.user_id, username: row.username }" :link="false" />
              </td>
              <td class="p-3 tabular-nums">{{ row.solved_count }}</td>
              <td class="p-3 tabular-nums">{{ row.total_submissions }}</td>
              <td class="p-3 tabular-nums">{{ (row.acceptance_rate * 100).toFixed(1) }}%</td>
            </tr>
          </tbody>
        </table>
      </div>
      <PaginationNav :current-page="page" :total-pages="data?.pagination.total_pages ?? 0"
        @page-change="page = $event" />
    </AsyncContent>
  </div>
</template>
