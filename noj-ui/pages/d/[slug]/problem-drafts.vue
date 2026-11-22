<script setup lang="ts">
import { workspaceCacheKey } from '~/utils/workspace';
import { extractApiError } from '~/utils/apiError';
definePageMeta({ layout: 'workspace', middleware: ['auth', 'workspace-context'] });
const { slug } = useWorkspace(), { user } = useAuth(), api = useDomainProblemEditor(), page = ref(1);
const key = computed(() =>
  workspaceCacheKey(slug.value!, user.value?.id ?? null, 'editable-problem-drafts', String(page.value))
);
const { data, error, status, refresh } = await useAsyncData(key, () => api.drafts(slug.value!, page.value));
watch(slug, () => {
  page.value = 1;
});
useSeoMeta({ title: '可编辑题目草稿' });
</script>
<template>
  <div class="space-y-4">
    <div class="flex justify-between gap-3">
      <h2 class="text-xl font-semibold">可编辑题目草稿</h2>
      <UButton :to="`/d/${slug}/problems/new`" variant="outline">创建本域题目</UButton>
    </div>
    <AsyncContent :status="error ? 'error' : status === 'pending' ? 'loading' : data?.items.length ? 'data' : 'empty'"
      :error="error ? extractApiError(error).message : undefined" empty-text="没有获授权的题目草稿" @retry="refresh()">
      <UCard v-for="item in data?.items" :key="item.reference.problem_id">
        <div class="flex flex-wrap justify-between gap-3">
          <NuxtLink :to="`/d/${slug}/editor/${item.reference.number}`"
            class="font-semibold text-primary">{{ item.reference.display_ref }} · {{ item.title }}</NuxtLink>
          <UBadge color="neutral" variant="subtle">{{ item.base_version_id ? '已有发布版本' : '尚未发布' }}</UBadge>
        </div>
        <p v-if="item.updated_at"
          class="mt-2 text-xs text-text-muted">{{ new Date(item.updated_at).toLocaleString() }}</p>
      </UCard>
    </AsyncContent>
    <UPagination v-if="data && data.total > data.limit" v-model:page="page" :total="data.total"
      :items-per-page="data.limit" />
  </div>
</template>
