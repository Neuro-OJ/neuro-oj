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
  <div class="flex flex-col gap-6">
    <ClassroomNavigation :slug="slug!" :classroom-id="id" :classroom="room.data.value?.data" />

    <LibraryPageHeader
      title="学生训练目录"
      :description="room.data.value?.data.name ? `查看「${room.data.value.data.name}」学员的个人训练进度与答题记录` : '查看班级学员训练进展'"
      icon="i-lucide-users"
    />

    <UAlert v-if="room.error.value" color="error" :title="extractApiError(room.error.value).message" />
    <UAlert v-if="room.data.value && !allowed" color="info" title="当前账号未被授予本班学情或提交记录的读取权限" />

    <section v-if="allowed" aria-label="学生训练名单" class="overflow-hidden rounded-lg border border-border bg-bg-panel">
      <div class="flex flex-wrap items-end gap-3 border-b border-border p-4 sm:gap-4 sm:px-5">
        <AdminFormField label="学生用户名" class="w-full sm:w-80">
          <UInput v-model="search" placeholder="输入用户名搜索" icon="i-lucide-search" aria-label="学生用户名" class="w-full" />
        </AdminFormField>
        <AdminFormField label="成员范围" class="w-44">
          <USelect v-model="scope"
            :items="[{ label: '当前在班学生', value: 'current' }, { label: '历史学生', value: 'historical' }, { label: '全部学生', value: 'all' }]"
            aria-label="学生成员范围" class="w-full" />
        </AdminFormField>
        <span v-if="roster.data.value" class="ml-auto pb-2 text-xs text-text-muted tabular-nums" role="status">
          共 {{ students.length }} 名学生
        </span>
      </div>

      <AsyncContent
        :status="roster.error.value ? 'error' : roster.status.value === 'pending' ? 'loading' : students.length ? 'data' : 'empty'"
        :error="roster.error.value ? extractApiError(roster.error.value).message : undefined"
        empty-text="暂无符合条件的学生"
        @retry="roster.refresh()"
      >
        <div class="hidden grid-cols-[minmax(0,1fr)_7rem_7rem] items-center gap-4 border-b border-border bg-bg-sunken px-5 py-2.5 text-xs font-medium text-text-secondary sm:grid" aria-hidden="true">
          <span>学生</span>
          <span>成员状态</span>
          <span class="text-right">训练记录</span>
        </div>
        <ul aria-label="学生名单" class="divide-y divide-border">
          <li
            v-for="student in students"
            :key="student.id"
          >
            <NuxtLink
              :to="workspacePath(slug!, `classrooms/${id}/students/${student.user_id}`)"
              class="grid min-h-16 grid-cols-[minmax(0,1fr)_auto] items-center gap-4 px-4 py-3 transition-colors hover:bg-primary-bg focus-visible:bg-primary-bg focus-visible:outline-2 focus-visible:outline-primary focus-visible:-outline-offset-2 sm:min-h-14 sm:grid-cols-[minmax(0,1fr)_7rem_7rem] sm:px-5"
            >
              <div class="min-w-0">
                <UserIdentity :user="student.user ?? { id: student.user_id, username: student.username, avatar_url: student.avatar_url }" :domain="slug!" :link="false" size="sm" />
                <div class="mt-1 sm:hidden">
                  <UBadge :color="student.effective_active ? 'success' : 'neutral'" variant="subtle" size="xs">
                    {{ student.effective_active ? '在班学员' : '历史学员' }}
                  </UBadge>
                </div>
              </div>
              <div class="hidden sm:block">
                <UBadge :color="student.effective_active ? 'success' : 'neutral'" variant="subtle" size="xs">
                  {{ student.effective_active ? '在班学员' : '历史学员' }}
                </UBadge>
              </div>
              <span class="inline-flex items-center justify-end gap-2 whitespace-nowrap text-sm font-medium text-primary">
                训练详情<UIcon name="i-lucide-arrow-right" class="size-4" />
              </span>
            </NuxtLink>
          </li>
        </ul>

        <template #empty>
          <div class="flex flex-col items-center justify-center px-4 text-center">
            <UIcon name="i-lucide-user-x" class="size-8 text-text-muted mb-2" />
            <p class="font-medium text-text">暂无符合条件的学生</p>
            <p class="text-xs text-text-muted mt-0.5">请尝试切换筛选范围或清空检索关键字</p>
            <UButton v-if="search || scope !== 'current'" class="mt-3" variant="outline" color="neutral" @click="search = ''; scope = 'current'">重置筛选</UButton>
          </div>
        </template>
      </AsyncContent>
    </section>
  </div>
</template>
