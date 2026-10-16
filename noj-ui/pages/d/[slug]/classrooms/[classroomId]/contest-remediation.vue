<script setup lang="ts">
import { classroomCan, educationCacheKey } from '~/utils/education';
import { workspacePath } from '~/utils/workspace';
import { extractApiError } from '~/utils/apiError';

definePageMeta({ layout: 'workspace', middleware: ['auth', 'workspace-context'] });

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
      <span class="text-text-muted">按比赛成绩补题</span>
    </div>

    <AdminPageHeader
      title="按比赛成绩布置补题"
      :description="room.data.value?.data.name ? `读取「${room.data.value.data.name}」在同域比赛中的表现，自动为未达标学生生成针对性作业` : '选择同域比赛并为学生生成针对性补题作业'"
      icon="i-lucide-list-checks"
    />

    <UAlert v-if="room.error.value" color="error" :title="extractApiError(room.error.value).message" />

    <ClientOnly v-if="writable">
      <ContestRemediationBuilder
        :key="`${slug}:${id}:${actor?.id}`"
        :slug="slug!"
        :classroom-id="id"
        :writable="!!writable"
      />
    </ClientOnly>

    <UAlert v-else-if="room.data.value" color="warning" title="当前只能读取班级，无权在此创建补题任务" />
  </div>
</template>
