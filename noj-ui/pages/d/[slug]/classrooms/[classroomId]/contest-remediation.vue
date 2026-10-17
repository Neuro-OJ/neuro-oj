<script setup lang="ts">
import { classroomCan, educationCacheKey } from '~/utils/education';
import { workspacePath } from '~/utils/workspace';
import { extractApiError } from '~/utils/apiError';

definePageMeta({ layout: 'workspace', middleware: ['auth', 'workspace-context'], breadcrumbWidth: '72rem' });

const route = useRoute(), { slug, domain } = useWorkspace(), education = useEducationApi();
const actor = useState<{ id: string } | null>('auth:user', () => null);
const id = computed(() => String(route.params.classroomId));

const room = await useAsyncData(
  () => educationCacheKey(slug.value!, actor.value?.id ?? null, id.value, 'contest-remediation'),
  () => education.classroom(slug.value!, id.value),
);

const writable = computed(() =>
  room.data.value && classroomCan(room.data.value.data, 'assignments:manage') &&
  classroomCan(room.data.value.data, 'progress:read') &&
  room.data.value.data.status === 'active' && domain.value?.status === 'active' &&
  domain.value.configuration.features.assignment && domain.value.configuration.features.classroom
);

useSeoMeta({ title: '按比赛成绩布置补题' });
</script>

<template>
  <div class="space-y-6">
    <ClassroomNavigation :slug="slug!" :classroom-id="id" :classroom="room.data.value?.data" />

    <LibraryPageHeader
      title="按比赛成绩布置补题"
      :description="room.data.value?.data.name ? `读取「${room.data.value.data.name}」在同域比赛中的表现，自动为未达标学生生成针对性作业` : '选择同域比赛并为学生生成针对性补题作业'"
      icon="i-lucide-list-checks"
    />

    <AsyncContent
      :status="room.error.value ? 'error' : room.status.value === 'pending' ? 'loading' : room.data.value ? 'data' : 'empty'"
      :error="room.error.value ? extractApiError(room.error.value).message : undefined"
      @retry="room.refresh()">

    <ClientOnly v-if="writable">
      <ContestRemediationBuilder
        :key="`${slug}:${id}:${actor?.id}`"
        :slug="slug!"
        :classroom-id="id"
        :writable="!!writable"
      />
    </ClientOnly>

    <UAlert v-else-if="room.data.value" color="warning" title="当前只能读取班级，无权在此创建补题任务" />
    </AsyncContent>
  </div>
</template>
