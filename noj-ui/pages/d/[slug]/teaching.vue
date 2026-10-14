<script setup lang="ts">
import { educationCacheKey } from '~/utils/education';
import { workspacePath } from '~/utils/workspace';
import { extractApiError } from '~/utils/apiError';
definePageMeta({ layout: 'workspace', middleware: ['auth', 'workspace-context'] });
const { slug } = useWorkspace(), { user } = useAuth(), api = useEducationApi(), page = ref(1);
const key = computed(() => educationCacheKey(slug.value!, user.value?.id ?? null, 'teaching-dashboard', page.value));
const { data, status, error, refresh } = await useAsyncData(
  key,
  () => api.dashboard(slug.value!, 'teaching', page.value),
);
watch(slug, () => {
  page.value = 1;
});
usePolling({
  intervalMs: computed(() => data.value?.data.assignments.some((task) => task.summary.updating) ? 3000 : null),
  immediate: false,
  fetcher: () => refresh(),
});
useSeoMeta({ title: '教学工作台' });
</script>
<template>
  <div class="space-y-5">
    <AdminPageHeader title="教学工作台" description="查看正在进行的教学任务、未达标学生、资源失效和待处理求助。"
      icon="i-lucide-presentation">
      <template #actions>
        <UButton :to="workspacePath(slug!, 'classrooms')" variant="outline">管理班级</UButton>
        <UButton :to="workspacePath(slug!, 'notifications')" variant="outline">教学通知</UButton>
        <UButton icon="i-lucide-refresh-cw" variant="ghost" aria-label="刷新工作台" @click="refresh()" />
      </template>
    </AdminPageHeader>
    <AsyncContent :status="error ? 'error' : status === 'pending' ? 'loading' : data ? 'data' : 'empty'"
      :error="error ? extractApiError(error).message : undefined" @retry="refresh()">
      <TeachingDashboard v-if="data" :slug="slug!" :data="data.data" mode="teaching" />
    </AsyncContent>
    <UPagination v-if="data && data.data.total > data.data.per_page" v-model:page="page" :total="data.data.total"
      :items-per-page="data.data.per_page" />
  </div>
</template>
