<script setup lang="ts">
import { classroomCan, educationCacheKey } from '~/utils/education';
import { workspacePath } from '~/utils/workspace';
import { extractApiError } from '~/utils/apiError';

definePageMeta({ layout: 'workspace', middleware: ['auth', 'workspace-context'], breadcrumbWidth: '72rem' });

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
  <div class="space-y-6">
    <ClassroomNavigation :slug="slug!" :classroom-id="id" :classroom="room.data.value?.data" />

    <LibraryPageHeader
      title="创建作业"
      :description="room.data.value?.data.name ? `为「${room.data.value.data.name}」布置新训练任务` : '配置作业题目与达标规则'"
      icon="i-lucide-clipboard-plus"
    />

    <AsyncContent
      :status="room.error.value ? 'error' : room.status.value === 'pending' ? 'loading' : room.data.value ? 'data' : 'empty'"
      :error="room.error.value ? extractApiError(room.error.value).message : undefined"
      @retry="room.refresh()">

    <ClientOnly v-if="writable">
      <AssignmentEditor
        :key="`${slug}:${id}:${actor?.id}`"
        :slug="slug!"
        :classroom-id="id"
        @saved="taskId => navigateTo(workspacePath(slug!, `assignments/${taskId}`))"
      />
    </ClientOnly>

    <UAlert v-else-if="room.data.value" color="warning" title="当前只能读取班级，无权在此创建新作业" />
    </AsyncContent>
  </div>
</template>
