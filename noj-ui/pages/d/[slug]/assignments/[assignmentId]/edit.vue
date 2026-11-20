<script setup lang="ts">
import { classroomCan, educationCacheKey } from '~/utils/education';
import { workspacePath } from '~/utils/workspace';
import { extractApiError } from '~/utils/apiError';
definePageMeta({ layout: 'workspace', middleware: ['auth', 'workspace-context'] });
const route = useRoute(), { slug, domain } = useWorkspace(), education = useEducationApi(), { dialog } = useDialog();
const actor = useState<{ id: string } | null>('auth:user', () => null), reset = ref(0);
const id = computed(() => String(route.params.assignmentId));
const task = await useAsyncData(
  () => educationCacheKey(slug.value!, actor.value?.id ?? null, id.value, 'edit'),
  () => education.assignment(slug.value!, id.value),
);
const room = await useAsyncData(
  () =>
    educationCacheKey(slug.value!, actor.value?.id ?? null, id.value, 'edit-class', task.data.value?.data.classroom_id),
  () => task.data.value ? education.classroom(slug.value!, task.data.value.data.classroom_id) : Promise.resolve(null),
);
const writable = computed(() =>
  room.data.value && classroomCan(room.data.value.data, 'assignments:manage') &&
  task.data.value?.data.state === 'draft' && room.data.value.data.status === 'active' &&
  domain.value?.status === 'active' && domain.value.configuration.features.assignment &&
  domain.value.configuration.features.classroom
);
const capture = useWorkspaceActionScope();
async function reload() {
  const scope = capture(), taskId = id.value;
  if (!await dialog.confirm('重新读取会丢弃当前未保存的修改，是否继续？')) return;
  if (!scope.isCurrent() || id.value !== taskId) return;
  await task.refresh();
  if (scope.isCurrent() && id.value === taskId) reset.value++;
}
useSeoMeta({ title: '编辑作业草稿' });
</script>
<template>
  <div class="flex flex-col gap-5">
    <UButton class="self-start" :to="workspacePath(slug!, `assignments/${id}`)" variant="ghost"
      icon="i-lucide-arrow-left">返回作业</UButton>
    <AdminPageHeader title="编辑作业草稿" :description="task.data.value?.data.title">
      <template #actions>
        <UButton variant="outline" @click="reload">重新读取</UButton>
      </template>
    </AdminPageHeader>
    <UAlert v-if="task.error.value || room.error.value" color="error"
      :title="extractApiError(task.error.value ?? room.error.value).message" />
    <ClientOnly v-if="writable && task.data.value">
      <AssignmentEditor :key="`${slug}:${id}:${actor?.id}:${reset}`" :slug="slug!"
        :classroom-id="task.data.value.data.classroom_id" :initial="task.data.value.data"
        @saved="taskId => navigateTo(workspacePath(slug!, `assignments/${taskId}`))" />
    </ClientOnly>
    <UAlert v-else-if="task.data.value" color="warning"
      title="只能编辑获授权的草稿；已发布的题目和要求需要复制为新任务" />
  </div>
</template>
