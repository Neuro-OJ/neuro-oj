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

const pendingHelpCount = computed(() =>
  props.data.help_requests.filter((r) => r.state === 'open').length
);

const attentionCount = computed(() =>
  props.data.assignments.filter((task) => teachingNeedsAttention(task)).length
);

const activeTasksCount = computed(() =>
  props.data.assignments.filter((task) => assignmentPhase(task) === '进行中').length
);

watch(() => [props.slug, props.mode], () => {
  filter.value = 'all';
});
</script>

<template>
  <div class="space-y-6">
    <!-- 顶部核心数据概览指标卡片 -->
    <div class="grid grid-cols-2 md:grid-cols-3 gap-3.5">
      <div class="rounded-lg border border-border bg-white dark:bg-bg-panel p-4 shadow-card flex items-center gap-3.5">
        <div class="flex size-11 shrink-0 items-center justify-center rounded-lg bg-primary-bg text-primary">
          <UIcon :name="mode === 'teaching' ? 'i-lucide-clipboard-check' : 'i-lucide-book-open'" class="size-5" />
        </div>
        <div class="min-w-0">
          <p class="text-xs text-text-muted truncate">
            {{ mode === 'teaching' ? '进行中教学任务' : '进行中作业' }}
          </p>
          <p class="text-xl font-bold text-text tabular-nums mt-0.5">
            {{ activeTasksCount }}
            <span class="text-xs font-normal text-text-muted">/ {{ data.total }}</span>
          </p>
        </div>
      </div>

      <div class="rounded-lg border border-border bg-white dark:bg-bg-panel p-4 shadow-card flex items-center gap-3.5">
        <div
          class="flex size-11 shrink-0 items-center justify-center rounded-lg"
          :class="attentionCount > 0 ? 'bg-warning-bg text-warning' : 'bg-success-bg text-success'"
        >
          <UIcon :name="mode === 'teaching' ? 'i-lucide-alert-circle' : 'i-lucide-check-circle-2'" class="size-5" />
        </div>
        <div class="min-w-0">
          <p class="text-xs text-text-muted truncate">
            {{ mode === 'teaching' ? '待关注任务' : '本页任务项' }}
          </p>
          <p class="text-xl font-bold text-text tabular-nums mt-0.5">
            {{ mode === 'teaching' ? attentionCount : visibleTasks.length }}
          </p>
        </div>
      </div>

      <div class="col-span-2 md:col-span-1 rounded-lg border border-border bg-white dark:bg-bg-panel p-4 shadow-card flex items-center gap-3.5">
        <div
          class="flex size-11 shrink-0 items-center justify-center rounded-lg"
          :class="pendingHelpCount > 0 ? 'bg-warning-bg text-warning' : 'bg-bg-sunken text-text-secondary'"
        >
          <UIcon name="i-lucide-message-circle-question" class="size-5" />
        </div>
        <div class="min-w-0">
          <p class="text-xs text-text-muted truncate">
            {{ mode === 'teaching' ? '待答复求助' : '求助与答复' }}
          </p>
          <p class="text-xl font-bold text-text tabular-nums mt-0.5">
            {{ pendingHelpCount }}
            <span class="text-xs font-normal text-text-muted">/ {{ data.help_requests.length }}</span>
          </p>
        </div>
      </div>
    </div>

    <!-- 任务过滤与标题 -->
    <div class="flex flex-wrap items-center justify-between gap-3">
      <div class="flex items-center gap-2">
        <UIcon :name="mode === 'teaching' ? 'i-lucide-layers' : 'i-lucide-list-todo'" class="size-5 text-primary" />
        <h3 class="font-semibold text-text text-base">
          {{ mode === 'teaching' ? '教学任务管理' : '我的学习任务' }}
        </h3>
        <span class="text-xs text-text-muted tabular-nums">
          ({{ visibleTasks.length }} 项)
        </span>
      </div>

      <USelect
        v-model="filter"
        :items="[{ label: '当前页全部任务', value: 'all' }, { label: '当前页进行中', value: 'active' }, ...(mode === 'teaching' ? [{ label: '当前页需要跟进', value: 'attention' }] : [])]"
        aria-label="任务筛选"
        class="w-44"
      />
    </div>

    <!-- 任务卡片网格 -->
    <div class="grid gap-4 md:grid-cols-2">
      <div
        v-for="task in visibleTasks"
        :key="task.id"
        class="group flex flex-col justify-between rounded-lg border border-border bg-white dark:bg-bg-panel p-5 shadow-card hover:border-primary/50 hover:shadow-dropdown transition-all"
      >
        <div class="space-y-3">
          <!-- 班级来源与状态徽章 -->
          <div class="flex items-start justify-between gap-2">
            <NuxtLink
              :to="workspacePath(slug, `classrooms/${task.classroom_id}`)"
              class="inline-flex items-center gap-1 text-xs font-medium text-text-secondary hover:text-primary transition-colors max-w-[70%] truncate"
            >
              <UIcon name="i-lucide-school" class="size-3.5 shrink-0 text-text-muted" />
              <span class="truncate">{{ task.classroom_name }}</span>
            </NuxtLink>
            <UBadge
              :color="assignmentPhase(task) === '进行中' ? 'primary' : assignmentPhase(task) === '已截止' ? 'neutral' : 'warning'"
              variant="subtle"
              size="sm"
            >
              {{ assignmentPhase(task) }}
            </UBadge>
          </div>

          <!-- 任务标题 -->
          <NuxtLink
            :to="workspacePath(slug, `assignments/${task.id}`)"
            class="block font-semibold text-text group-hover:text-primary transition-colors text-base line-clamp-1"
          >
            {{ task.title }}
          </NuxtLink>

          <!-- 截止时间与题目数 -->
          <div class="flex flex-wrap items-center gap-3 text-xs text-text-muted">
            <span class="inline-flex items-center gap-1 tabular-nums">
              <UIcon name="i-lucide-clock" class="size-3.5" />
              {{ task.deadline_at ? `截止 ${new Date(task.deadline_at).toLocaleString()}` : '未设置截止时间' }}
            </span>
            <span class="inline-flex items-center gap-1 tabular-nums">
              <UIcon name="i-lucide-file-code" class="size-3.5" />
              {{ task.summary.total_items }} 道题目
            </span>
          </div>

          <!-- 评测更新提示 -->
          <UAlert
            v-if="task.summary.updating"
            color="info"
            title="成绩正在后台物化更新，稍后将自动刷新当前进度"
          />

          <!-- 指标详情 -->
          <div v-else class="rounded-lg bg-bg-sunken/40 p-3 text-xs tabular-nums space-y-1.5">
            <!-- 学生个人视角：完成进度 -->
            <template v-if="mode === 'my-learning'">
              <div class="flex items-center justify-between font-medium">
                <span class="text-text-secondary">达标进度</span>
                <span class="text-text">
                  已达标 {{ task.summary.achieved_cells ?? 0 }} / {{ task.summary.total_items }} 题
                </span>
              </div>
              <div class="w-full bg-border/60 rounded-full h-1.5 overflow-hidden">
                <div
                  class="bg-primary h-full transition-all duration-300"
                  :style="{ width: `${Math.min(100, Math.round(((task.summary.achieved_cells ?? 0) / Math.max(1, task.summary.total_items)) * 100))}%` }"
                />
              </div>
            </template>

            <!-- 教师视角：班级整体学情 -->
            <template v-else>
              <div class="flex flex-wrap items-center justify-between gap-2">
                <span v-if="task.summary.total_students != null" class="text-text-secondary">
                  目标学生：<strong class="text-text">{{ task.summary.total_students }}</strong> 人
                </span>
                <span
                  v-if="task.summary.below_target_students != null"
                  :class="task.summary.below_target_students > 0 ? 'text-warning font-semibold' : 'text-text-secondary'"
                >
                  尚未达标：{{ task.summary.below_target_students }} 人
                </span>
                <span v-if="task.summary.achieved_cells != null" class="text-text-muted">
                  达标单元：{{ task.summary.achieved_cells }} 个
                </span>
              </div>
            </template>
          </div>

          <!-- 资源异常警告 -->
          <UAlert
            v-if="task.summary.unavailable_items > 0"
            color="warning"
            :title="`${task.summary.unavailable_items} 道题资源不可用${mode === 'teaching' ? '，请检查共享与下架原因' : '，请联系老师'}`"
          />
        </div>

        <!-- 底部操作按钮 -->
        <div class="mt-4 pt-3.5 border-t border-border">
          <UButton
            :to="workspacePath(slug, `assignments/${task.id}`)"
            variant="outline"
            color="primary"
            size="sm"
            class="w-full justify-between"
            trailing-icon="i-lucide-arrow-right"
          >
            {{ mode === 'my-learning' ? '查看作业与反馈' : '查看任务与学情' }}
          </UButton>
        </div>
      </div>
    </div>

    <!-- 空列表状态 -->
    <div
      v-if="!visibleTasks.length"
      class="flex flex-col items-center justify-center rounded-lg border border-dashed border-border bg-white dark:bg-bg-panel py-12 px-4 text-center shadow-card"
    >
      <UIcon name="i-lucide-clipboard-list" class="size-8 text-text-muted mb-2" />
      <p class="font-medium text-text">当前页没有符合条件的任务</p>
      <p class="text-xs text-text-muted mt-0.5">请切换筛选条件，或在所属班级中查看更多任务。</p>
    </div>

    <!-- 求助管理卡片 -->
    <UCard v-if="data.help_requests.length">
      <template #header>
        <div class="flex items-center justify-between">
          <div class="flex items-center gap-2">
            <UIcon name="i-lucide-message-circle-question" class="size-5 text-primary" />
            <h3 class="font-semibold text-text">
              {{ mode === 'teaching' ? '待处理求助列表' : '我的求助与教练回复' }}
            </h3>
          </div>
          <UBadge v-if="pendingHelpCount > 0" color="warning" variant="subtle" size="sm">
            {{ pendingHelpCount }} 条未处理
          </UBadge>
        </div>
      </template>

      <div class="divide-y divide-border -my-2">
        <div
          v-for="request in data.help_requests"
          :key="request.id"
          class="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 py-3 hover:bg-bg-sunken/40 px-2 rounded transition-colors"
        >
          <div class="space-y-1">
            <div class="flex items-center gap-2">
              <UBadge
                :color="request.state === 'open' ? 'warning' : 'neutral'"
                variant="subtle"
                size="xs"
              >
                {{ request.state === 'open' ? '待处理' : '已处理' }}
              </UBadge>
              <p class="text-sm font-medium text-text">
                {{ request.classroom_name }} · {{ request.assignment_title }}
              </p>
            </div>
            <p class="text-xs text-text-muted tabular-nums">
              发起时间：{{ new Date(request.created_at).toLocaleString() }}
            </p>
          </div>

          <UButton
            :to="{ path: workspacePath(slug, `assignments/${request.assignment_id}`), query: { help: request.id } }"
            variant="outline"
            color="primary"
            size="sm"
            trailing-icon="i-lucide-external-link"
            class="self-start sm:self-auto shrink-0"
          >
            {{ mode === 'teaching' ? '处理求助' : '查看回复' }}
          </UButton>
        </div>
      </div>
    </UCard>
  </div>
</template>
