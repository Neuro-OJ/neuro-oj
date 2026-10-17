<script setup lang="ts">
import { assignmentPhase, classroomCan, educationCacheKey } from '~/utils/education';
import { workspacePath } from '~/utils/workspace';
import { extractApiError } from '~/utils/apiError';

definePageMeta({ layout: 'workspace', middleware: ['auth', 'workspace-context'], breadcrumbWidth: '72rem' });

const route = useRoute(), { slug, domain } = useWorkspace(), education = useEducationApi();
const actor = useState<{ id: string } | null>('auth:user', () => null), page = ref(1);
const id = computed(() => String(route.params.classroomId));

const room = await useAsyncData(
  () => educationCacheKey(slug.value!, actor.value?.id ?? null, id.value),
  () => education.classroom(slug.value!, id.value),
);

const tasks = await useAsyncData(
  () => educationCacheKey(slug.value!, actor.value?.id ?? null, id.value, 'tasks', page.value),
  () => education.assignments(slug.value!, id.value, page.value),
);

useSeoMeta({ title: () => room.data.value?.data.name ?? '班级' });
</script>

<template>
  <div class="flex flex-col gap-6">
    <ClassroomNavigation :slug="slug!" :classroom-id="id" :classroom="room.data.value?.data" />

    <AsyncContent
      :status="room.error.value ? 'error' : room.status.value === 'pending' ? 'loading' : room.data.value ? 'data' : 'empty'"
      :error="room.error.value ? extractApiError(room.error.value).message : undefined"
      @retry="room.refresh()"
    >
      <div class="space-y-4">
      <LibraryPageHeader :title="room.data.value?.data.name ?? '班级'"
        :description="room.data.value?.data.description || '暂无班级说明'" icon="i-lucide-graduation-cap">
        <template #actions>
            <UButton
              v-if="room.data.value && classroomCan(room.data.value.data, 'assignments:manage') && room.data.value.data.status === 'active' && domain?.status === 'active' && domain.configuration.features.assignment && domain.configuration.features.classroom"
              :to="workspacePath(slug!, `classrooms/${id}/assignments/new`)"
              color="primary"
              icon="i-lucide-plus"
            >
              创建作业
            </UButton>
            <UButton
              v-if="room.data.value && classroomCan(room.data.value.data, 'assignments:manage') && classroomCan(room.data.value.data, 'progress:read') && room.data.value.data.status === 'active' && domain?.status === 'active' && domain.configuration.features.assignment && domain.configuration.features.classroom"
              :to="workspacePath(slug!, `classrooms/${id}/contest-remediation`)"
              variant="outline"
              color="neutral"
              icon="i-lucide-list-checks"
            >
              按比赛补题
            </UButton>
        </template>
      </LibraryPageHeader>
      <div class="flex flex-wrap items-center gap-2">
        <UBadge :color="room.data.value?.data.status === 'archived' ? 'neutral' : 'success'" variant="subtle">
          {{ room.data.value?.data.status === 'archived' ? '已归档' : '正常教学' }}
        </UBadge>
        <UBadge v-if="room.data.value?.data.stage_tag" variant="subtle">{{ room.data.value.data.stage_tag }}</UBadge>
      </div>
        <UAlert
          v-if="room.data.value?.data.status === 'archived'"
          color="warning"
          title="班级已归档，可以继续查看获授权的历史记录与作业反馈"
        />
      </div>
    </AsyncContent>

    <!-- 班级作业列表 -->
    <section v-if="room.data.value" class="space-y-4">
      <div class="flex items-center justify-between">
        <div class="flex items-center gap-2">
          <UIcon name="i-lucide-clipboard-list" class="size-5 text-primary" />
          <h2 class="text-base font-semibold text-text">班级作业</h2>
          <span v-if="tasks.data.value?.data.length" class="text-xs text-text-muted tabular-nums">
            本页 {{ tasks.data.value.data.length }} 份
          </span>
        </div>
      </div>

      <AsyncContent
        :status="tasks.error.value ? 'error' : tasks.status.value === 'pending' ? 'loading' : tasks.data.value?.data.length ? 'data' : 'empty'"
        :error="tasks.error.value ? extractApiError(tasks.error.value).message : undefined"
        empty-text="暂无可查看的作业"
        @retry="tasks.refresh()"
      >
        <div class="divide-y divide-border rounded-lg border border-border bg-bg-panel">
          <div
            v-for="task in tasks.data.value?.data"
            :key="task.id"
            class="flex flex-col gap-3 p-4 sm:flex-row sm:items-center sm:justify-between sm:p-5"
          >
            <div class="min-w-0 space-y-2">
              <div class="flex flex-wrap items-center gap-2">
                <NuxtLink
                  :to="workspacePath(slug!, `assignments/${task.id}`)"
                  class="break-words font-medium text-text hover:text-primary transition-colors"
                >
                  {{ task.title }}
                </NuxtLink>
                <UBadge
                  :color="assignmentPhase(task) === '进行中' ? 'primary' : assignmentPhase(task) === '已截止，可继续练习' ? 'neutral' : 'warning'"
                  variant="subtle"
                  size="sm"
                >
                  {{ assignmentPhase(task) }}
                </UBadge>
              </div>

              <div class="flex flex-wrap items-center gap-3 text-xs text-text-muted">
                <span v-if="task.deadline_at" class="inline-flex items-center gap-1 tabular-nums">
                  <UIcon name="i-lucide-clock" class="size-3.5" />
                  截止时间：{{ new Date(task.deadline_at).toLocaleString() }}
                </span>
                <span v-else class="inline-flex items-center gap-1">
                  <UIcon name="i-lucide-calendar-off" class="size-3.5" />
                  未设截止时间
                </span>
              </div>
            </div>

            <UButton
              :to="workspacePath(slug!, `assignments/${task.id}`)"
              variant="ghost"
              color="primary"
              size="sm"
              trailing-icon="i-lucide-arrow-right"
              class="self-start sm:self-auto shrink-0"
            >
              查看作业
            </UButton>
          </div>
        </div>

        <template #empty>
          <div class="flex flex-col items-center justify-center py-6 px-4 text-center">
            <div class="flex size-10 items-center justify-center rounded-full bg-primary-bg text-primary mb-2">
              <UIcon name="i-lucide-clipboard-x" class="size-5" />
            </div>
            <p class="font-medium text-text">暂无可查看的作业</p>
            <p class="mt-1 text-xs text-text-muted">班级尚未发布任何作业，或当前账号无权查看未发布草稿。</p>
          </div>
        </template>
      </AsyncContent>

      <!-- 分页 -->
      <div
        v-if="(tasks.data.value?.data.length ?? 0) >= 50 || page > 1"
        class="flex items-center justify-between gap-3 text-sm"
      >
        <span class="text-text-muted">第 <strong class="text-text tabular-nums">{{ page }}</strong> 页</span>
        <div class="flex items-center gap-2">
          <UButton :disabled="page <= 1" variant="outline" color="neutral" size="sm" @click="page--">
            上一页
          </UButton>
          <UButton :disabled="(tasks.data.value?.data.length ?? 0) < 50" variant="outline" color="neutral" size="sm" @click="page++">
            下一页
          </UButton>
        </div>
      </div>
    </section>
  </div>
</template>
