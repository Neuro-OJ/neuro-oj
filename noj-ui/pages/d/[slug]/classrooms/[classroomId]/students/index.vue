<script setup lang="ts">
import { classroomCan, educationCacheKey } from '~/utils/education';
import { workspacePath } from '~/utils/workspace';
import { extractApiError } from '~/utils/apiError';

definePageMeta({ layout: 'workspace', middleware: ['auth', 'workspace-context'], breadcrumbWidth: '72rem' });

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
  <div class="space-y-6">
    <ClassroomNavigation :slug="slug!" :classroom-id="id" :classroom="room.data.value?.data" />

    <LibraryPageHeader
      title="学生训练目录"
      :description="room.data.value?.data.name ? `查看「${room.data.value.data.name}」学员的个人训练进度与答题记录` : '查看班级学员训练进展'"
      icon="i-lucide-users"
    />

    <UAlert v-if="room.error.value" color="error" :title="extractApiError(room.error.value).message" />
    <UAlert v-if="room.data.value && !allowed" color="info" title="当前账号未被授予本班学情或提交记录的读取权限" />

    <template v-if="allowed">
      <!-- 搜索与范围筛选栏 -->
      <div class="flex flex-wrap items-end gap-4 rounded-lg border border-border bg-bg-panel p-4">
        <AdminFormField label="学生用户名" class="w-full sm:w-auto sm:flex-1 sm:max-w-md">
          <UInput v-model="search" placeholder="输入用户名搜索" icon="i-lucide-search" aria-label="学生用户名" class="w-full" />
        </AdminFormField>
        <AdminFormField label="成员范围" class="w-full sm:w-44">
          <USelect v-model="scope"
            :items="[{ label: '当前在班学生', value: 'current' }, { label: '历史学生', value: 'historical' }, { label: '全部学生', value: 'all' }]"
            aria-label="学生成员范围" class="w-full" />
        </AdminFormField>
        <span class="pb-2 text-xs text-text-muted sm:ml-auto tabular-nums" role="status">
          共 {{ students.length }} 名学生
        </span>
      </div>

      <AsyncContent
        :status="roster.error.value ? 'error' : roster.status.value === 'pending' ? 'loading' : students.length ? 'data' : 'empty'"
        :error="roster.error.value ? extractApiError(roster.error.value).message : undefined"
        empty-text="暂无符合条件的学生"
        @retry="roster.refresh()"
      >
        <div class="grid gap-3 md:grid-cols-2">
          <div
            v-for="student in students"
            :key="student.id"
            class="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border bg-bg-panel p-4"
          >
            <div class="flex items-center gap-3 min-w-0">
              <div class="flex size-10 shrink-0 items-center justify-center rounded-full bg-primary-bg text-primary font-semibold text-sm">
                {{ student.username.slice(0, 1).toUpperCase() }}
              </div>
              <div class="min-w-0">
                <h2 class="font-semibold text-text break-all">{{ student.username }}</h2>
                <UBadge
                  :color="student.effective_active ? 'success' : 'neutral'"
                  variant="subtle"
                  size="xs"
                  class="mt-1"
                >
                  {{ student.effective_active ? '在班学员' : '历史学员' }}
                </UBadge>
              </div>
            </div>

            <UButton
              :to="workspacePath(slug!, `classrooms/${id}/students/${student.user_id}`)"
              variant="outline"
              color="primary"
              size="sm"
              trailing-icon="i-lucide-arrow-right"
              class="shrink-0"
            >
              训练详情
            </UButton>
          </div>
        </div>

        <template #empty>
          <div class="flex flex-col items-center justify-center py-6 px-4 text-center">
            <UIcon name="i-lucide-user-x" class="size-8 text-text-muted mb-2" />
            <p class="font-medium text-text">暂无符合条件的学生</p>
            <p class="text-xs text-text-muted mt-0.5">请尝试切换筛选范围或清空检索关键字</p>
            <UButton v-if="search || scope !== 'current'" class="mt-3" variant="outline" color="neutral" @click="search = ''; scope = 'current'">重置筛选</UButton>
          </div>
        </template>
      </AsyncContent>
    </template>
  </div>
</template>
