<script setup lang="ts">
import { classroomCan, educationCacheKey } from '~/utils/education';
import { workspacePath } from '~/utils/workspace';
import { extractApiError } from '~/utils/apiError';
definePageMeta({ layout: 'workspace', middleware: ['auth', 'workspace-context'] });
const route = useRoute(), { slug } = useWorkspace(), { user } = useAuth(), education = useEducationApi();
const id = computed(() => String(route.params.classroomId)),
  search = ref(''),
  scope = ref<'current' | 'historical' | 'all'>('current');
const base = computed(() => educationCacheKey(slug.value!, user.value?.id ?? null, id.value, 'student-directory'));
const room = await useAsyncData(() => `${base.value}:room`, () => education.classroom(slug.value!, id.value));
const allowed = computed(() =>
  !!room.data.value &&
  (classroomCan(room.data.value.data, 'submissions:read') || classroomCan(room.data.value.data, 'progress:read'))
);
const roster = await useAsyncData(
  () => `${base.value}:roster:${allowed.value}`,
  () => allowed.value ? education.members(slug.value!, id.value) : Promise.resolve(null),
);
const students = computed(() =>
  roster.data.value?.data.filter((member) =>
    member.role === 'student' && (scope.value === 'all' || member.effective_active === (scope.value === 'current')) &&
    member.username.toLocaleLowerCase().includes(search.value.trim().toLocaleLowerCase())
  ) ?? []
);
useSeoMeta({ title: '班级学生训练目录' });
</script>
<template>
  <div class="space-y-5">
    <AdminPageHeader title="学生训练目录" :description="room.data.value?.data.name">
      <template #actions>
        <UButton :to="workspacePath(slug!, `classrooms/${id}`)" variant="outline">返回班级</UButton>
      </template>
    </AdminPageHeader>
    <UAlert v-if="room.error.value" color="error" :title="extractApiError(room.error.value).message" />
    <UAlert v-if="room.data.value && !allowed" color="info" title="需要本班学情或提交读取能力" />
    <template v-if="allowed">
      <div class="flex flex-wrap gap-3">
        <UInput v-model="search" placeholder="筛选学生姓名" class="grow" />
        <USelect v-model="scope"
          :items="[{ label: '当前学生', value: 'current' }, { label: '历史学生', value: 'historical' }, { label: '全部学生', value: 'all' }]"
          aria-label="学生成员范围" />
      </div>
      <AsyncContent
        :status="roster.error.value ? 'error' : roster.status.value === 'pending' ? 'loading' : students.length ? 'data' : 'empty'"
        :error="roster.error.value ? extractApiError(roster.error.value).message : undefined" @retry="roster.refresh()">
        <div class="grid gap-4 sm:grid-cols-2">
          <UCard v-for="student in students" :key="student.id">
            <div class="flex items-center justify-between gap-3">
              <div>
                <h3 class="font-semibold">{{ student.username }}</h3>
                <p class="mt-1 text-xs text-text-muted">{{ student.effective_active ? '当前学生' : '历史学生' }}</p>
              </div>
              <UButton :to="workspacePath(slug!, `classrooms/${id}/students/${student.user_id}`)"
                variant="outline">训练详情</UButton>
            </div>
          </UCard>
        </div>
      </AsyncContent>
    </template>
  </div>
</template>
