<script setup lang="ts">
import { educationCacheKey } from '~/utils/education';
import { workspacePath } from '~/utils/workspace';
import { extractApiError } from '~/utils/apiError';
definePageMeta({ layout: 'workspace', middleware: ['auth', 'workspace-context'] });
const { slug } = useWorkspace(), { user } = useAuth(), api = useEducationApi(), page = ref(1);
const key = computed(() => educationCacheKey(slug.value!, user.value?.id ?? null, 'my-learning', page.value));
const { data, status, error, refresh } = await useAsyncData(
  key,
  () => api.dashboard(slug.value!, 'my-learning', page.value),
);
watch(slug, () => {
  page.value = 1;
});
usePolling({
  intervalMs: computed(() => data.value?.data.assignments.some((task) => task.summary.updating) ? 3000 : null),
  immediate: false,
  fetcher: () => refresh(),
});
useEducationNotifications(() => refresh());
useSeoMeta({ title: '我的学习' });
</script>
<template>
  <div class="space-y-5">
    <AdminPageHeader title="我的学习" description="查看收到的作业、个人达标进度、反馈与求助回复。"
      icon="i-lucide-book-open">
      <template #actions>
        <UButton :to="workspacePath(slug!, 'classrooms')" variant="outline">我的班级</UButton>
        <UButton :to="workspacePath(slug!, 'notifications')" variant="outline">教学通知</UButton>
        <UButton icon="i-lucide-refresh-cw" variant="ghost" aria-label="刷新学习进度" @click="refresh()" />
      </template>
    </AdminPageHeader>
    <AsyncContent :status="error ? 'error' : data ? 'data' : status === 'pending' ? 'loading' : 'empty'"
      :error="error ? extractApiError(error).message : undefined" @retry="refresh()">
      <TeachingDashboard v-if="data" :slug="slug!" :data="data.data" mode="my-learning" />
    </AsyncContent>
    <UPagination v-if="data && data.data.total > data.data.per_page" v-model:page="page" :total="data.data.total"
      :items-per-page="data.data.per_page" />
  </div>
</template>
