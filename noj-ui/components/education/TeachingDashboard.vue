<script setup lang="ts">
import type { EducationDashboardData } from '~/utils/education-dashboard';
import { teachingNeedsAttention } from '~/utils/education-dashboard';
import { assignmentPhase } from '~/utils/education';
import { workspacePath } from '~/utils/workspace';
const props = defineProps<{ slug: string; data: EducationDashboardData; mode: 'teaching' | 'my-learning' }>();
const filter = ref('all');
const visibleTasks = computed(() =>
  props.data.assignments.filter((task) => {
    if (filter.value === 'attention') return teachingNeedsAttention(task);
    if (filter.value === 'active') return assignmentPhase(task) === '进行中';
    return true;
  })
);
watch(() => [props.slug, props.mode], () => {
  filter.value = 'all';
});
</script>
<template>
  <div class="space-y-5">
    <div class="flex flex-wrap items-center justify-between gap-3">
      <h3 class="font-semibold">{{ mode === 'teaching' ? '教学任务' : '我的任务' }}</h3>
      <USelect v-model="filter"
        :items="[{ label: '当前页全部任务', value: 'all' }, { label: '当前页进行中', value: 'active' }, ...(mode === 'teaching' ? [{ label: '当前页需要跟进', value: 'attention' }] : [])]"
        aria-label="任务筛选" class="min-w-44" />
    </div>
    <div class="grid gap-4 md:grid-cols-2">
      <UCard v-for="task in visibleTasks" :key="task.id">
        <div class="flex flex-wrap items-start justify-between gap-2">
          <NuxtLink :to="workspacePath(slug, `assignments/${task.id}`)"
            class="font-semibold text-primary">{{ task.title }}</NuxtLink>
          <UBadge color="neutral" variant="subtle">{{ assignmentPhase(task) }}</UBadge>
        </div>
        <NuxtLink :to="workspacePath(slug, `classrooms/${task.classroom_id}`)"
          class="mt-2 block text-sm text-text-secondary">{{ task.classroom_name }}</NuxtLink>
        <p
          class="mt-2 text-xs tabular-nums text-text-muted">{{ task.deadline_at ? `截止 ${new Date(task.deadline_at).toLocaleString()}` : '未设置截止时间' }} · {{ task.summary.total_items }} 道题</p>
        <UAlert v-if="task.summary.updating" class="mt-3" color="info" title="成绩正在更新，稍后查看当前进度" />
        <div v-else class="mt-3 flex flex-wrap gap-x-4 gap-y-2 text-sm tabular-nums">
          <template
            v-if="mode === 'my-learning'"><span v-if="task.summary.achieved_cells != null">已达标 {{ task.summary.achieved_cells }} / {{ task.summary.total_items }} 题</span></template>
          <template v-else>
            <span v-if="task.summary.total_students != null">{{ task.summary.total_students }} 名目标学生</span>
            <span v-if="task.summary.below_target_students != null"
              :class="task.summary.below_target_students ? 'text-warning-text' : 'text-text-secondary'">{{ task.summary.below_target_students }} 名尚未达标</span>
            <span v-if="task.summary.achieved_cells != null">{{ task.summary.achieved_cells }} 个达标单元</span>
          </template>
        </div>
        <UAlert v-if="task.summary.unavailable_items > 0" class="mt-3" color="warning"
          :title="`${task.summary.unavailable_items} 道题资源不可用${mode === 'teaching' ? '，请检查共享与下架原因' : '，请联系老师'}`" />
        <UButton :to="workspacePath(slug, `assignments/${task.id}`)" variant="outline"
          class="mt-4">{{ mode === 'my-learning' ? '查看作业与反馈' : '查看任务与学情' }}</UButton>
      </UCard>
    </div>
    <p v-if="!visibleTasks.length" class="py-8 text-center text-text-muted">当前页没有符合条件的任务</p>
    <UCard v-if="data.help_requests.length">
      <h3 class="mb-3 font-semibold">{{ mode === 'teaching' ? '待处理求助' : '我的求助' }}</h3>
      <div v-for="request in data.help_requests" :key="request.id"
        class="flex flex-wrap justify-between gap-3 border-t border-border py-3">
        <div>
          <p class="text-sm">{{ request.classroom_name }} · {{ request.assignment_title }}</p>
          <p
            class="mt-1 text-xs text-text-muted">{{ request.state === 'open' ? '待处理' : '已处理' }} · {{ new Date(request.created_at).toLocaleString() }}</p>
        </div>
        <UButton
          :to="{ path: workspacePath(slug, `assignments/${request.assignment_id}`), query: { help: request.id } }"
          variant="ghost">{{ mode === 'teaching' ? '处理求助' : '查看回复' }}</UButton>
      </div>
    </UCard>
  </div>
</template>
