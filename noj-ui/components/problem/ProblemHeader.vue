<script setup lang="ts">
import type { ProblemView } from '~/utils/problemView'
import { problemTypeLabel } from '~/utils/problemView'
import { formatAcceptanceRate } from '~/utils/submissionFormat'
import { formatMemoryLimit, formatTimeLimit } from '~/utils/problemView'
import type { PublicProblemStats } from '~/utils/problemStats'

/**
 * 题目头部标识区（#511）：编号胶囊 + 类型/客观题徽章 + 标题 + 作者 +
 * 右对齐统计条（提交数/通过数/时间限制/内存限制）+ 右上角操作插槽。
 *
 * 由独立题目页与竞赛做题页共用，消除第二份题面实现与第二套硬编码难度色。
 */
const props = defineProps<{
  problem: ProblemView
  /** 公开统计；null 表示未加载或接口不可用（不渲染对应数值项）。 */
  stats?: PublicProblemStats | null
  /** 竞赛进行中时后端抑制统计，显示占位而非空白。 */
  suppressedReason?: 'running_contest' | null
}>()

/**
 * 插槽：
 * - `leading`：编号胶囊之前的上下文（如竞赛页「返回竞赛」与题号）；
 * - `titleSuffix`：标题右侧补充（如竞赛名）；
 * - `actions`：右上角主操作按钮。
 */
defineSlots<{
  leading?: () => unknown
  titleSuffix?: () => unknown
  actions?: () => unknown
}>()

const typeLabel = computed(() => problemTypeLabel(props.problem.type))

/** 统计条是否整体不可用（赛期抑制）。 */
const suppressed = computed(
  () => props.suppressedReason === 'running_contest' || props.stats?.suppressed_reason === 'running_contest',
)
</script>

<template>
  <header class="flex flex-wrap items-start justify-between gap-4">
    <div class="min-w-0 flex-1">
      <div class="mb-2 flex flex-wrap items-center gap-2">
        <slot name="leading" />
        <span
          class="inline-flex items-center rounded-full px-2 py-0.5 font-mono text-xs font-semibold"
          :class="problem.type === 'U' ? 'bg-primary/10 text-primary' : 'bg-signal/10 text-signal-deep'"
        >
          {{ problem.display_id }}
        </span>
        <span
          class="inline-flex items-center rounded-full border border-border px-2 py-0.5 text-xs font-semibold text-text-secondary"
        >
          {{ typeLabel }}
        </span>
        <span
          v-if="problem.is_objective"
          class="inline-flex items-center rounded-full bg-success-text/10 px-2 py-0.5 text-xs font-semibold text-success-text"
        >
          客观题
        </span>
      </div>
      <div class="flex flex-wrap items-center gap-3">
        <h1 class="text-2xl font-bold text-text">{{ problem.title }}</h1>
        <slot name="titleSuffix" />
      </div>
      <UserIdentity
        v-if="problem.type === 'U' && problem.owner_username"
        :user="{ id: problem.owner_id ?? '', username: problem.owner_username }"
        size="sm"
        class="mt-2"
      />
    </div>

    <div class="flex flex-col items-end gap-3">
      <div class="flex items-center gap-2">
        <slot name="actions" />
      </div>
      <dl class="flex flex-wrap items-center justify-end gap-x-5 gap-y-1.5 text-xs text-text-secondary">
        <template v-if="suppressed">
          <div class="flex items-center gap-1">
            <UIcon name="i-lucide-trophy" class="size-3.5" />
            <span>竞赛进行中，暂不显示通过率</span>
          </div>
        </template>
        <template v-else>
          <div v-if="stats" class="flex items-center gap-1">
            <dt class="sr-only">提交数</dt>
            <UIcon name="i-lucide-send" class="size-3.5" />
            <dd class="tabular-nums">{{ stats.submit_count ?? '—' }} 次提交</dd>
          </div>
          <div v-if="stats" class="flex items-center gap-1">
            <dt class="sr-only">通过数</dt>
            <UIcon name="i-lucide-check-circle" class="size-3.5" />
            <dd class="tabular-nums">{{ stats.accepted_count ?? '—' }} 次通过</dd>
          </div>
          <div v-if="stats" class="flex items-center gap-1">
            <dt class="sr-only">通过率</dt>
            <UIcon name="i-lucide-percent" class="size-3.5" />
            <dd class="tabular-nums">{{ formatAcceptanceRate(stats.acceptance_rate) }}</dd>
          </div>
        </template>
        <div v-if="!problem.is_objective && problem.time_limit_ms != null" class="flex items-center gap-1">
          <dt class="sr-only">时间限制</dt>
          <UIcon name="i-lucide-clock" class="size-3.5" />
          <dd class="tabular-nums">{{ formatTimeLimit(problem.time_limit_ms) }}</dd>
        </div>
        <div v-if="!problem.is_objective && problem.memory_limit_mb != null" class="flex items-center gap-1">
          <dt class="sr-only">内存限制</dt>
          <UIcon name="i-lucide-server" class="size-3.5" />
          <dd class="tabular-nums">{{ formatMemoryLimit(problem.memory_limit_mb) }}</dd>
        </div>
        <div v-if="problem.is_objective" class="flex items-center gap-1">
          <UIcon name="i-lucide-zap" class="size-3.5" />
          <span>服务端即时判定</span>
        </div>
      </dl>
    </div>
  </header>
</template>
