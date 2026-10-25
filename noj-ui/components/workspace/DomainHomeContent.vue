<script setup lang="ts">
import { workspaceCacheKey, workspacePath } from '~/utils/workspace';
import { extractApiError } from '~/utils/apiError';
import type { EducationDashboardData } from '~/utils/education-dashboard';
const props = defineProps<{ initialData?: { data: EducationDashboardData } }>();
const { slug, domain, can } = useWorkspace(), { user } = useAuth();
const api = useEducationApi();
const key = computed(() => workspaceCacheKey(slug.value!, user.value?.id ?? null, 'home-tasks'));
const mode = ref<'teaching' | 'my-learning'>(
  can('classroom:create') || can('classroom:manage_any') ? 'teaching' : 'my-learning',
);
const enabled = computed(() =>
  !!user.value && !!domain.value?.configuration.features.assignment &&
  (domain.value.is_member || domain.value.platform_admin)
);
const tasks = await useViewAsyncData(
  'dashboard',
  () => `${key.value}:${mode.value}:${enabled.value}`,
  () => enabled.value ? api.dashboard(slug.value!, mode.value, 1) : Promise.resolve(null),
  { immediate: !props.initialData },
);
const dashboard = computed(() => props.initialData ?? tasks.data.value);
useEducationNotifications(async () => {
  if (enabled.value) await tasks.refresh();
}, enabled);
</script>
<template>
  <section v-if="enabled" class="px-5 py-5 sm:px-6" aria-label="教学与学习">
    <div class="flex flex-wrap items-center gap-3">
      <h2 class="mr-auto text-sm font-semibold text-text">教学与学习</h2>
      <USelect v-model="mode" size="sm"
        :items="[{label:'我的学习',value:'my-learning'},{label:'教学任务',value:'teaching'}]"
        aria-label="首页教学视角" />
      <UButton :to="workspacePath(slug!, mode)" variant="ghost" size="sm"
        trailing-icon="i-lucide-arrow-right">{{ mode === 'teaching' ? '教学工作台' : '我的学习' }}</UButton>
    </div>
    <AsyncContent
      :status="tasks.error.value ? 'error' : dashboard?.data.assignments.length ? 'data' : tasks.status.value === 'pending' ? 'loading' : 'empty'"
      :error="tasks.error.value ? extractApiError(tasks.error.value).message : undefined"
      empty-text="当前没有进行中的任务" @retry="tasks.refresh()">
      <ul class="mt-2 divide-y divide-border">
        <li v-for="task in dashboard?.data.assignments.slice(0,3)" :key="task.id">
          <NuxtLink :to="workspacePath(slug!, `assignments/${task.id}`)"
            class="flex flex-wrap items-center gap-x-4 gap-y-1 py-2 text-sm no-underline hover:text-primary">
            <span
              class="min-w-0 flex-1 break-words font-medium">{{ task.title }}<span class="ml-2 text-xs font-normal text-text-muted">{{ task.classroom_name }}</span></span>
            <span
              class="text-xs text-text-muted">{{ task.summary.updating ? '成绩更新中' : task.summary.unavailable_items ? `${task.summary.unavailable_items} 题资源不可用` : task.deadline_at ? `截止 ${new Date(task.deadline_at).toLocaleDateString()}` : '无截止时间' }}</span>
          </NuxtLink>
        </li>
      </ul>
    </AsyncContent>
  </section>
</template>
