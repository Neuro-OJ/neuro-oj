<script setup lang="ts">
import { classroomCan, educationCacheKey } from '~/utils/education';
import { workspacePath } from '~/utils/workspace';
import { extractApiError } from '~/utils/apiError';

definePageMeta({ layout: 'workspace', middleware: ['auth', 'workspace-context'] });

const route = useRoute(), { slug, domain } = useWorkspace(), { user } = useAuth(), education = useEducationApi();
const id = computed(() => String(route.params.classroomId)), studentId = computed(() => String(route.params.userId));

const base = computed(() =>
  educationCacheKey(slug.value!, user.value?.id ?? null, id.value, `student:${studentId.value}`)
);

const room = await useAsyncData(() => `${base.value}:room`, () => education.classroom(slug.value!, id.value));

const allowed = computed(() =>
  !!room.data.value &&
  (classroomCan(room.data.value.data, 'submissions:read') || classroomCan(room.data.value.data, 'progress:read'))
);

const roster = await useAsyncData(
  () => `${base.value}:roster:${allowed.value}`,
  () => allowed.value ? education.members(slug.value!, id.value) : Promise.resolve(null),
);

const student = computed(() => roster.data.value?.data.find((member) => member.user_id === studentId.value));

useSeoMeta({ title: () => student.value ? `${student.value.username} 的训练档案` : '学生训练档案' });
</script>

<template>
  <div class="space-y-6">
    <!-- 顶部面包屑与返回 -->
    <div class="flex items-center gap-2 text-sm text-text-muted">
      <NuxtLink
        :to="workspacePath(slug!, `classrooms/${id}/students`)"
        class="inline-flex items-center gap-1 text-text-secondary hover:text-primary transition-colors font-medium"
      >
        <UIcon name="i-lucide-arrow-left" class="size-4" />
        <span>学生目录</span>
      </NuxtLink>
      <span class="text-border">/</span>
      <span class="text-text font-medium truncate max-w-xs">{{ student?.username ?? '学员详情' }}</span>
      <span class="text-border">/</span>
      <span class="text-text-muted">训练档案</span>
    </div>

    <UAlert v-if="roster.error.value" color="error" :title="extractApiError(roster.error.value).message" />

    <AsyncContent
      :status="room.error.value ? 'error' : room.status.value === 'pending' ? 'loading' : room.data.value ? 'data' : 'empty'"
      :error="room.error.value ? extractApiError(room.error.value).message : undefined"
      @retry="room.refresh()"
    >
      <ClientOnly v-if="allowed && room.data.value">
        <StudentTraining
          :key="`${base}:${room.data.value.data.revision}`"
          :slug="slug!"
          :classroom="room.data.value.data"
          :student-id="studentId"
          :student="student"
          :writable="domain?.status === 'active' && room.data.value.data.status === 'active' && !!domain.configuration.features.classroom && !!domain.configuration.features.assignment"
        />
      </ClientOnly>
      <UAlert v-else color="info" title="未授予本班学生学情或提交记录的读取能力" />
    </AsyncContent>
  </div>
</template>
