<script setup lang="ts">
import { workspaceCacheKey } from '~/utils/workspace';
import { DOMAIN_CONTEST_TYPES } from '~/utils/domain-contests';
import { extractApiError } from '~/utils/apiError';
definePageMeta({ layout: 'workspace', middleware: 'workspace-context' });
const { slug, can } = useWorkspace();
const { user } = useAuth();
const api = useDomainContests();
const page = ref(1);
const key = computed(() => workspaceCacheKey(slug.value!, user.value?.id ?? null, `contests:${page.value}`));
const { data, error, status, refresh } = await useAsyncData(key, () => api.list(slug.value!, page.value));
useSeoMeta({ title: '空间比赛' });
</script>
<template>
  <div class="space-y-4">
    <div class="flex justify-between">
      <h2 class="text-xl font-semibold">比赛</h2>
      <UButton v-if="can('contest:manage') || can('contest:manage_own')" :to="`/d/${slug}/contests/new`"
        icon="i-lucide-plus">创建比赛</UButton>
    </div>
    <AsyncContent :status="error ? 'error' : status === 'pending' ? 'loading' : data?.data.length ? 'data' : 'empty'"
      :error="error ? extractApiError(error).message : undefined" empty-text="暂无比赛" @retry="refresh()">
      <div class="grid gap-3 sm:grid-cols-2">
        <UCard v-for="contest in data?.data" :key="contest.id">
          <NuxtLink :to="`/d/${slug}/contests/${contest.id}`"
            class="font-semibold text-primary">{{ contest.title }}</NuxtLink>
          <div class="mt-3 flex gap-2">
            <UBadge
              variant="subtle">{{ DOMAIN_CONTEST_TYPES.find((type) => type.value === contest.type)?.label }}</UBadge>
            <UBadge color="neutral"
              variant="subtle">{{ { pending: '未开始', running: '进行中', ended: '已结束' }[contest.status] }}</UBadge>
          </div>
          <p
            class="mt-3 text-sm text-text-muted">{{ new Date(contest.start_time).toLocaleString() }} — {{ new Date(contest.end_time).toLocaleString() }}</p>
        </UCard>
      </div>
    </AsyncContent>
    <UPagination v-if="data && data.pagination.total_pages > 1" v-model:page="page" :total="data.pagination.total"
      :items-per-page="20" />
  </div>
</template>
