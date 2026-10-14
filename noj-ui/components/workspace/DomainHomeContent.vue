<script setup lang="ts">
import { workspaceCacheKey, workspacePath, workspaceProblemPath } from '~/utils/workspace';
import { extractApiError } from '~/utils/apiError';
const {slug, domain, can} = useWorkspace(), {user} = useAuth();
const {api} = useApi(), problemsApi = useDomainProblems(), contestsApi = useDomainContests(), educationApi = useEducationApi();
const key = computed(() => workspaceCacheKey(slug.value!, user.value?.id ?? null, 'home-content'));
const mode = ref<'teaching' | 'my-learning'>(can('classroom:create') || can('classroom:manage_any') ? 'teaching' : 'my-learning');
const educationEnabled = computed(() => !!user.value && !!domain.value?.configuration.features.assignment && (domain.value.is_member || domain.value.platform_admin));
const [stats, problems, contests, teaching] = await Promise.all([
  useAsyncData(() => `${key.value}:stats`, () => api.get<{data: {problems:number; users:number; submissions:number; accepted:number}}>(`/api/v1/domains/${encodeURIComponent(slug.value!)}/stats`, {silent:true})),
  useAsyncData(() => `${key.value}:problems`, () => problemsApi.list(slug.value!, 1)),
  useAsyncData(() => `${key.value}:contests`, () => contestsApi.list(slug.value!, 1)),
  useAsyncData(() => `${key.value}:education:${mode.value}:${educationEnabled.value}`, () => educationEnabled.value ? educationApi.dashboard(slug.value!, mode.value, 1) : Promise.resolve(null)),
]);
useEducationNotifications(async () => { if (educationEnabled.value) await teaching.refresh(); }, educationEnabled);
</script>
<template>
  <div class="space-y-5">
    <UAlert v-if="stats.error.value" color="error" :title="extractApiError(stats.error.value).message">
      <template #actions><UButton variant="outline" @click="stats.refresh()">重试统计</UButton></template>
    </UAlert>
    <dl v-if="stats.data.value" class="grid grid-cols-2 gap-3 lg:grid-cols-4">
      <UCard v-for="metric in [{label:'可访问题目',value:stats.data.value.data.problems},{label:'域内成员',value:stats.data.value.data.users},{label:'可展示提交',value:stats.data.value.data.submissions},{label:'通过提交',value:stats.data.value.data.accepted}]" :key="metric.label">
        <dt class="text-sm text-text-muted">{{ metric.label }}</dt><dd class="mt-2 text-2xl font-semibold tabular-nums">{{ metric.value }}</dd>
      </UCard>
    </dl>
    <UCard v-if="educationEnabled">
      <div class="mb-4 flex flex-wrap items-center justify-between gap-3">
        <h2 class="font-semibold">教学与学习</h2>
        <div class="flex flex-wrap gap-2">
          <USelect v-model="mode" :items="[{label:'我的学习',value:'my-learning'},{label:'教学任务',value:'teaching'}]" aria-label="首页教学视角" />
          <UButton :to="workspacePath(slug!,mode)" variant="outline">{{ mode === 'teaching' ? '进入教学工作台' : '进入我的学习' }}</UButton>
          <UButton :to="workspacePath(slug!,'classrooms')" variant="ghost">班级</UButton>
        </div>
      </div>
      <AsyncContent :status="teaching.error.value ? 'error' : teaching.status.value === 'pending' ? 'loading' : teaching.data.value?.data.assignments.length ? 'data' : 'empty'" :error="teaching.error.value ? extractApiError(teaching.error.value).message : undefined" empty-text="当前没有获授权的教学任务" @retry="teaching.refresh()">
        <div class="divide-y divide-border">
          <NuxtLink v-for="task in teaching.data.value?.data.assignments.slice(0,5)" :key="task.id" :to="workspacePath(slug!,`assignments/${task.id}`)" class="flex flex-wrap items-center justify-between gap-2 py-3 hover:text-primary">
            <span>{{ task.title }}<span class="ml-2 text-xs text-text-muted">{{ task.classroom_name }}</span></span>
            <span class="text-xs text-text-muted">{{ task.summary.updating ? '成绩更新中' : task.summary.unavailable_items ? `${task.summary.unavailable_items} 题资源不可用` : task.deadline_at ? `截止 ${new Date(task.deadline_at).toLocaleDateString()}` : '无截止时间' }}</span>
          </NuxtLink>
        </div>
      </AsyncContent>
    </UCard>
    <div class="grid gap-4 lg:grid-cols-2">
      <UCard>
        <div class="mb-4 flex items-center justify-between"><h2 class="font-semibold">本域题库</h2><UButton :to="workspacePath(slug!,'problems')" variant="ghost">查看题库</UButton></div>
        <AsyncContent :status="problems.error.value ? 'error' : problems.status.value === 'pending' ? 'loading' : problems.data.value?.items.length ? 'data' : 'empty'" :error="problems.error.value ? extractApiError(problems.error.value).message : undefined" empty-text="暂无可访问的题目" @retry="problems.refresh()">
          <div class="divide-y divide-border">
            <NuxtLink v-for="problem in problems.data.value?.items.slice(0,5)" :key="problem.binding_id" :to="workspaceProblemPath(slug!,problem.reference.display_ref)" class="block break-words py-3 hover:text-primary"><span class="mr-2 font-mono text-primary">{{ problem.reference.display_ref }}</span>{{ problem.title }}</NuxtLink>
          </div>
        </AsyncContent>
      </UCard>
      <UCard>
        <div class="mb-4 flex items-center justify-between"><h2 class="font-semibold">本域比赛</h2><UButton :to="workspacePath(slug!,'contests')" variant="ghost">查看比赛</UButton></div>
        <AsyncContent :status="contests.error.value ? 'error' : contests.status.value === 'pending' ? 'loading' : contests.data.value?.data.length ? 'data' : 'empty'" :error="contests.error.value ? extractApiError(contests.error.value).message : undefined" empty-text="暂无可访问的比赛" @retry="contests.refresh()">
          <div class="divide-y divide-border">
            <NuxtLink v-for="contest in contests.data.value?.data.slice(0,5)" :key="contest.id" :to="workspacePath(slug!,`contests/${contest.id}`)" class="flex items-center justify-between gap-3 py-3 hover:text-primary"><span class="min-w-0 break-words">{{ contest.title }}</span><span class="shrink-0 text-xs text-text-muted">{{ {pending:'未开始',running:'进行中',ended:'已结束'}[contest.status] }}</span></NuxtLink>
          </div>
        </AsyncContent>
      </UCard>
    </div>
  </div>
</template>
