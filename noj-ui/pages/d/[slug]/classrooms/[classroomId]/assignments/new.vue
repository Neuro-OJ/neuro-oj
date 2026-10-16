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
  <div class="space-y-6">
    <!-- 顶部面包屑与返回 -->
    <div class="flex items-center gap-2 text-sm text-text-muted">
      <NuxtLink
        :to="workspacePath(slug!, `classrooms/${id}`)"
        class="inline-flex items-center gap-1 text-text-secondary hover:text-primary transition-colors font-medium"
      >
        <UIcon name="i-lucide-arrow-left" class="size-4" />
        <span>返回班级</span>
      </NuxtLink>
      <span class="text-border">/</span>
      <span class="text-text font-medium truncate max-w-xs">{{ room.data.value?.data.name ?? '班级' }}</span>
      <span class="text-border">/</span>
      <span class="text-text-muted">创建作业</span>
    </div>

    <AdminPageHeader
      title="创建作业"
      :description="room.data.value?.data.name ? `为「${room.data.value.data.name}」布置新训练任务` : '配置作业题目与达标规则'"
      icon="i-lucide-clipboard-plus"
    />

    <UAlert v-if="room.error.value" color="error" :title="extractApiError(room.error.value).message" />

    <ClientOnly v-if="writable">
      <AssignmentEditor
        :key="`${slug}:${id}:${actor?.id}`"
        :slug="slug!"
        :classroom-id="id"
        @saved="taskId => navigateTo(workspacePath(slug!, `assignments/${taskId}`))"
      />
    </ClientOnly>

    <UAlert v-else-if="room.data.value" color="warning" title="当前只能读取班级，无权在此创建新作业" />
  </div>
</template>
