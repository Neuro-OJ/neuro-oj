<script setup lang="ts">
import { classroomCan, educationCacheKey } from '~/utils/education';
import { workspacePath } from '~/utils/workspace';
import { extractApiError } from '~/utils/apiError';
definePageMeta({ layout: 'workspace', middleware: ['auth', 'workspace-context'] });
const route = useRoute(), { slug, domain } = useWorkspace(), education = useEducationApi();
const actor = useState<{ id: string } | null>('auth:user', () => null);
const id = computed(() => String(route.params.classroomId));
const room = await useAsyncData(
  () => educationCacheKey(slug.value!, actor.value?.id ?? null, id.value, 'new-assignment'),
  () => education.classroom(slug.value!, id.value),
);
const writable = computed(() =>
  room.data.value && classroomCan(room.data.value.data, 'assignments:manage') &&
  room.data.value.data.status === 'active' && domain.value?.status === 'active' &&
  domain.value.configuration.features.assignment && domain.value.configuration.features.classroom
);
useSeoMeta({ title: '创建作业' });
</script>
<template>
  <div class="space-y-5">
    <UButton :to="workspacePath(slug!, `classrooms/${id}`)" variant="ghost"
      icon="i-lucide-arrow-left">返回班级</UButton>
    <AdminPageHeader title="创建作业" :description="room.data.value?.data.name" icon="i-lucide-clipboard-plus" />
    <UAlert v-if="room.error.value" color="error" :title="extractApiError(room.error.value).message" />
    <ClientOnly v-if="writable">
      <AssignmentEditor :key="`${slug}:${id}:${actor?.id}`" :slug="slug!" :classroom-id="id"
        @saved="taskId => navigateTo(workspacePath(slug!, `assignments/${taskId}`))" />
    </ClientOnly>
    <UAlert v-else-if="room.data.value" color="warning" title="当前只能读取班级，不能创建作业" />
  </div>
</template>
