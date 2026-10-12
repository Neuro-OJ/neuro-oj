<script setup lang="ts">
import { assignmentPhase, educationCacheKey } from '~/utils/education';
import { workspacePath } from '~/utils/workspace';
import { extractApiError } from '~/utils/apiError';
definePageMeta({ layout: 'workspace', middleware: ['auth', 'workspace-context'] });
const route = useRoute(), { slug } = useWorkspace(), education = useEducationApi();
const actor = useState<{ id: string } | null>('auth:user', () => null), page = ref(1);
const id = computed(() => String(route.params.classroomId));
const room = await useAsyncData(
  () => educationCacheKey(slug.value!, actor.value?.id ?? null, id.value),
  () => education.classroom(slug.value!, id.value),
);
const tasks = await useAsyncData(
  () => educationCacheKey(slug.value!, actor.value?.id ?? null, id.value, 'tasks', page.value),
  () => education.assignments(slug.value!, id.value, page.value),
);
useSeoMeta({ title: () => room.data.value?.data.name ?? '班级' });
</script>
<template>
  <div class="space-y-5">
    <UButton :to="workspacePath(slug!, 'classrooms')" variant="ghost" icon="i-lucide-arrow-left">我的班级</UButton>
    <AsyncContent
      :status="room.error.value ? 'error' : room.status.value === 'pending' ? 'loading' : room.data.value ? 'data' : 'empty'"
      :error="room.error.value ? extractApiError(room.error.value).message : undefined" @retry="room.refresh()">
      <AdminPageHeader :title="room.data.value?.data.name ?? '班级'" :description="room.data.value?.data.description"
        icon="i-lucide-graduation-cap" />
      <UAlert v-if="room.data.value?.data.status === 'archived'" class="mt-4" color="warning"
        title="班级已归档，可以继续查看获授权的历史" />
    </AsyncContent>
    <h2 class="font-semibold">班级作业</h2>
    <AsyncContent
      :status="tasks.error.value ? 'error' : tasks.status.value === 'pending' ? 'loading' : tasks.data.value?.data.length ? 'data' : 'empty'"
      :error="tasks.error.value ? extractApiError(tasks.error.value).message : undefined" empty-text="暂无可查看的作业"
      @retry="tasks.refresh()">
      <UCard v-for="task in tasks.data.value?.data" :key="task.id" class="mb-3">
        <div class="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h3 class="font-medium">{{ task.title }}</h3>
            <p class="mt-1 text-sm text-text-muted">{{ assignmentPhase(task) }}</p>
            <p v-if="task.deadline_at"
              class="mt-1 text-xs text-text-secondary">截止：{{ new Date(task.deadline_at).toLocaleString() }}</p>
          </div>
          <UButton :to="workspacePath(slug!, `assignments/${task.id}`)" variant="outline">查看作业</UButton>
        </div>
      </UCard>
    </AsyncContent>
    <div
      class="flex items-center gap-3"><UButton :disabled="page <= 1" variant="ghost" @click="page--">上一页</UButton><span class="text-sm tabular-nums">{{ page }}</span><UButton :disabled="(tasks.data.value?.data.length ?? 0) < 50" variant="ghost" @click="page++">下一页</UButton></div>
  </div>
</template>
